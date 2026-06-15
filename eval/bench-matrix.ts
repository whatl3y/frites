#!/usr/bin/env -S npx tsx
/**
 * distrai bench-matrix: run an agentic-coding harness against many distrai configs (and raw-model
 * baselines) on the SAME tasks, then table accuracy + tokens + cost + latency side by side.
 *
 * This script owns the DISTRAI side only. For each condition it writes a temp config, starts a
 * gateway on an isolated port, waits for readiness, points the harness at it, runs the harness,
 * reads back a results JSON, then tears the gateway down. The harness itself is a pluggable command
 * (default: Aider polyglot via eval/harness/aider-polyglot.sh) so this file never hard-codes a
 * benchmark. See eval/README.md for the full runbook and the why behind each knob.
 *
 * Run:
 *   pnpm bench                         # raw baselines + all agent combos (OAuth) — METERED
 *   pnpm bench -- --dry-run            # fake harness, no children spawned — pure wiring smoke test
 *   pnpm bench -- --auth both          # run every combo under BOTH OAuth and metered API-key auth
 *   pnpm bench -- --combos claude,claude+codex --auth oauth
 *   pnpm bench -- --only "claude+codex / oauth" --num-tests 5
 *   pnpm bench -- --no-raw             # skip the raw-model baselines (distrai conditions only)
 *
 * Harness contract — the command in DISTRAI_BENCH_HARNESS (default below) is invoked once per
 * condition with these env vars, and MUST write a JSON object to $DISTRAI_BENCH_RESULT:
 *   {"pass_rate_1": number, "pass_rate_2": number, "percent_well_formed": number,
 *    "cost_usd": number, "n": number, "prompt_tokens"?: number, "completion_tokens"?: number,
 *    "notes"?: string}
 * Env the harness receives:
 *   DISTRAI_BENCH_URL        gateway base url (EMPTY string for raw-model passthrough conditions)
 *   DISTRAI_BENCH_MODEL      the --model value to hand the harness
 *   DISTRAI_BENCH_RESULT     path to write the results JSON
 *   DISTRAI_BENCH_NUM_TESTS  exercise cap (from --num-tests; empty = harness default)
 *   DISTRAI_BENCH_CONDITION  condition name (for run labelling)
 *   ANTHROPIC_BASE_URL / ANTHROPIC_API_BASE / ANTHROPIC_API_KEY  (distrai conditions only)
 *   ...plus any per-condition `env` overrides (used to point raw baselines at real APIs)
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "../.."); // <repo>/eval/bench-matrix.ts → <repo>

/**
 * A condition is one row of the comparison. `config` present → spin up a distrai gateway with it and
 * point the harness at the gateway. `config` absent → a raw-model passthrough baseline: no gateway,
 * the harness talks to the real provider (creds come from the ambient env / the condition's `env`).
 *
 * NB: distrai picks the child model from `config.defaultAgents`, NOT from the request `model` field
 * (apps/gateway/src/index.ts: `model = body.model ?? "distrai"` is a label only). So vary the model
 * MIX via the agent combos below, not via `model`. And never give a distrai condition a `model`
 * containing haiku/small/fast — that string trips the single-agent background short-circuit.
 */
interface Condition {
  name: string;
  /** Value handed to the harness as --model / DISTRAI_BENCH_MODEL. */
  model: string;
  /** distrai config (written to a temp file, loaded via DISTRAI_GLOBAL_CONFIG). Omit → passthrough. */
  config?: Record<string, unknown>;
  /** Extra env for the harness (e.g. point a raw baseline at the real OpenAI/Anthropic API). */
  env?: Record<string, string>;
}

// maxTurns is bumped well past the default 60 because an agentic coding task (esp. SWE-bench-style
// tool loops) runs many turns under one session key and would otherwise hit the cap mid-task and
// score an artificial failure.
const MAX_TURNS = 200;

// ── agent combinations to sweep (the "several iterations of combinations" axis) ──
// Each combo is a defaultAgents list. Single-agent combos run fanOutPolicy:never (no council);
// multi-agent combos run fanOutPolicy:always. Add/remove freely; `--combos a,b` filters them.
const AGENT_COMBOS: Record<string, Array<Record<string, unknown>>> = {
  claude: [{ id: "c1", kind: "claude-cli" }],
  codex: [{ id: "x1", kind: "codex-cli" }],
  "claude+codex": [
    { id: "c1", kind: "claude-cli", framing: "Make the smallest correct change." },
    { id: "x1", kind: "codex-cli", framing: "Double-check correctness before editing." },
  ],
  "claude x2": [
    { id: "c1", kind: "claude-cli", framing: "Make the smallest correct change." },
    { id: "c2", kind: "claude-cli", framing: "Prefer a clean, well-structured solution." },
  ],
  "codex x2": [
    { id: "x1", kind: "codex-cli", framing: "Make the smallest correct change." },
    { id: "x2", kind: "codex-cli", framing: "Prefer a clean, well-structured solution." },
  ],
  "claude+2codex": [
    { id: "c1", kind: "claude-cli", framing: "Make the smallest correct change." },
    { id: "x1", kind: "codex-cli", framing: "Double-check correctness before editing." },
    { id: "x2", kind: "codex-cli", framing: "Prefer a clean, well-structured solution." },
  ],
  "claude+codex+claude": [
    { id: "c1", kind: "claude-cli", framing: "Make the smallest correct change." },
    { id: "x1", kind: "codex-cli", framing: "Double-check correctness before editing." },
    { id: "c2", kind: "claude-cli", framing: "Prefer a clean, well-structured solution." },
  ],
};

// ── auth axis: subscription/OAuth vs metered API key ──
// passApiKeys:false → children use the host's claude/codex OAuth (subscription; no API key needed).
// passApiKeys:true  → the gateway forwards ANTHROPIC_API_KEY/OPENAI_API_KEY to children (metered).
// Same models either way, so QUALITY should match — this axis is about cost VISIBILITY + rate limits
// (codex on the ChatGPT/OAuth backend reports no cost; the API backend does). Export the real keys
// before using apikey mode (and for the raw baselines).
const AUTH_MODES: Record<string, boolean> = { oauth: false, apikey: true };

// ── cost attribution (opt-in via --price) ──
// distrai's gateway estimates a child's spend from per-model $/Mtoken rates ONLY when that child has
// an explicit model matching a rate key AND it reports no cost itself. claude self-reports cost (even
// on subscription), so it needs no rate; codex reports NOTHING on the ChatGPT/OAuth backend, so
// without this its contribution shows as $0. Enabling --price (a) stamps the codex children with an
// explicit model so the rate keys off it, and (b) attaches `pricing` to the config.
// ⚠️ Provider prices drift and --price PINS codex to CHILD_MODELS["codex-cli"] — set the model id and
// rates to your real setup (constants below, or the env vars) before trusting the cost column.
const CHILD_MODELS: Record<string, string | undefined> = {
  "claude-cli": process.env.DISTRAI_BENCH_CLAUDE_MODEL, // undefined → CLI default (claude self-reports)
  "codex-cli": process.env.DISTRAI_BENCH_CODEX_MODEL ?? "gpt-5.5",
};
const PRICING: Record<string, { inputPerMtok: number; outputPerMtok: number }> = {
  // $ per million tokens, keyed by model id (distrai prefix-matches). EDIT to your provider's rates.
  "gpt-5.5": {
    inputPerMtok: Number(process.env.DISTRAI_BENCH_CODEX_IN ?? "1.25"),
    outputPerMtok: Number(process.env.DISTRAI_BENCH_CODEX_OUT ?? "10"),
  },
};

// ── raw-model baselines (no gateway): the "normal models" reference line ──
// Always real API keys. Adjust the model ids to whatever you actually benchmark against.
const RAW_BASELINES: Condition[] = [
  { name: "raw-opus", model: "anthropic/claude-opus-4-8" },
  { name: "raw-gpt", model: "openai/gpt-5.5" },
];

/** Build a distrai condition for one (combo, auth) pair. fanOutScope stays first-turn (one council
 *  per task, then a single agent through tool continuations; on the tool-less Aider harness scope
 *  has no effect anyway — see eval/README.md for the per-turn variant). */
function distraiCondition(comboName: string, agents: Array<Record<string, unknown>>, authName: string): Condition {
  // Under --price, stamp each child with the model whose rate we'll attribute (so codex gets priced).
  const childAgents = PRICE
    ? agents.map((a) => {
        const m = CHILD_MODELS[String(a.kind)];
        return m ? { ...a, model: m } : a;
      })
    : agents;
  const config: Record<string, unknown> = {
    maxTurns: MAX_TURNS,
    fanOutScope: "first-turn",
    fanOutPolicy: agents.length > 1 ? "always" : "never",
    defaultN: agents.length,
    defaultAgents: childAgents,
    passApiKeys: AUTH_MODES[authName],
  };
  if (PRICE) config.pricing = PRICING;
  return {
    name: `${comboName} / ${authName}`,
    model: "distrai-council", // a LABEL only; the real mix is `childAgents` (never haiku/small/fast)
    config,
  };
}

// ── CLI flags ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const DRY_RUN = argv.includes("--dry-run");
const NO_RAW = argv.includes("--no-raw");
const PRICE = argv.includes("--price"); // estimate codex spend from PRICING so cost($) is complete
const TIMEOUT_MIN = Number(process.env.DISTRAI_BENCH_TIMEOUT_MIN ?? "90"); // per-condition wall-clock ceiling
const ONLY = flag("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
const NUM_TESTS = flag("--num-tests") ?? "";
// --auth oauth | apikey | both (default oauth — the no-key path; pass `both` for the comparison).
const AUTH_ARG = (flag("--auth") ?? "oauth").toLowerCase();
const authNames = AUTH_ARG === "both" ? Object.keys(AUTH_MODES) : AUTH_ARG.split(",").map((s) => s.trim());
// --combos name1,name2 (default: every combo in AGENT_COMBOS).
const comboNames = flag("--combos")?.split(",").map((s) => s.trim()).filter(Boolean) ?? Object.keys(AGENT_COMBOS);

for (const a of authNames) {
  if (!(a in AUTH_MODES)) {
    process.stderr.write(`[bench] unknown --auth "${a}" (use: ${Object.keys(AUTH_MODES).join("|")}|both)\n`);
    process.exit(1);
  }
}

// Build the condition list: raw baselines (unless --no-raw) + (selected combos × selected auth modes).
const generated: Condition[] = [];
if (!NO_RAW) generated.push(...RAW_BASELINES);
for (const cn of comboNames) {
  const agents = AGENT_COMBOS[cn];
  if (!agents) {
    process.stderr.write(`[bench] unknown --combos "${cn}" (have: ${Object.keys(AGENT_COMBOS).join(", ")})\n`);
    process.exit(1);
  }
  for (const an of authNames) generated.push(distraiCondition(cn, agents, an));
}

// The harness command. Default to the bundled Aider adapter; override with DISTRAI_BENCH_HARNESS.
// In --dry-run we swap in a stub that writes zeros, so the matrix wiring can be exercised for free.
const DEFAULT_HARNESS = join(REPO, "eval", "harness", "aider-polyglot.sh");
const HARNESS = DRY_RUN
  ? `node -e 'require("fs").writeFileSync(process.env.DISTRAI_BENCH_RESULT,JSON.stringify({pass_rate_1:0,pass_rate_2:0,percent_well_formed:0,cost_usd:0,n:0,prompt_tokens:0,completion_tokens:0,notes:"dry-run stub"}))'`
  : (process.env.DISTRAI_BENCH_HARNESS ?? `bash ${DEFAULT_HARNESS}`);

const conditions = ONLY ? generated.filter((c) => ONLY.includes(c.name)) : generated;
if (conditions.length === 0) {
  process.stderr.write(
    `[bench] no conditions matched (only=${ONLY?.join(",") ?? "-"} combos=${comboNames.join(",")} auth=${authNames.join(",")})\n`,
  );
  process.exit(1);
}

// ── gateway lifecycle (mirrors eval/value-gate.ts) ───────────────────────────
// Bind host: 127.0.0.1 by default (loopback only). For the Docker harness the benchmark runs in a
// container and reaches the host gateway via host.docker.internal, which a 127.0.0.1-bound server
// REFUSES — so export DISTRAI_BENCH_GATEWAY_HOST=0.0.0.0 for Docker runs (exposes the gateway on the
// LAN for the run's duration; auth is off by default — set DISTRAI_GATEWAY_TOKEN if that matters).
const GATEWAY_HOST = process.env.DISTRAI_BENCH_GATEWAY_HOST ?? "127.0.0.1";
function startGateway(configPath: string, port: number) {
  const tsxBin = join(REPO, "node_modules", ".bin", "tsx");
  const proc = spawn(tsxBin, [join(REPO, "apps", "gateway", "src", "index.ts")], {
    env: {
      ...process.env,
      DISTRAI_GLOBAL_CONFIG: configPath,
      DISTRAI_GATEWAY_PORT: String(port),
      DISTRAI_GATEWAY_HOST: GATEWAY_HOST,
      ANTHROPIC_BASE_URL: "", // never let the gateway point a child back at itself
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logBuf = "";
  proc.stdout?.on("data", (d) => (logBuf += d.toString()));
  proc.stderr?.on("data", (d) => (logBuf += d.toString()));
  return { proc, getLog: () => logBuf };
}

async function waitForPort(port: number, timeoutMs = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

/** Sum every "$N.NNN" the gateway logged — the real distrai spend (claude reports it authoritatively;
 *  codex on the ChatGPT/OAuth backend reports nothing, so a codex-only OAuth row can read $0 even
 *  though work happened — read the `tok` column alongside it). */
function sumGatewayCost(log: string): number {
  let total = 0;
  for (const m of log.matchAll(/\$([0-9]+\.[0-9]+)/g)) total += Number(m[1]);
  return total;
}

interface HarnessResult {
  pass_rate_1: number;
  pass_rate_2: number;
  percent_well_formed: number;
  cost_usd: number;
  n: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  notes?: string;
}
interface Row extends HarnessResult {
  condition: string;
  durationS: number;
  gatewayCostUsd?: number;
  error?: string;
}

function runHarness(env: NodeJS.ProcessEnv, resultPath: string): HarnessResult {
  execFileSync("bash", ["-lc", HARNESS], {
    env,
    stdio: ["ignore", "inherit", "inherit"], // let the harness stream its own progress to our console
    timeout: TIMEOUT_MIN * 60 * 1000, // per-condition ceiling (DISTRAI_BENCH_TIMEOUT_MIN, default 90)
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!existsSync(resultPath)) throw new Error(`harness wrote no result at ${resultPath}`);
  return JSON.parse(readFileSync(resultPath, "utf8")) as HarnessResult;
}

// The cost worth showing: distrai's real spend from the gateway logs, else the harness's own number
// (which is right for raw baselines — their model ids ARE in LiteLLM's price map).
const rowCost = (r: Row): number => r.gatewayCostUsd ?? r.cost_usd;
const rowTokK = (r: Row): string => `${(((r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0)) / 1000).toFixed(1)}k`;

// ── run the matrix ───────────────────────────────────────────────────────────
const rows: Row[] = [];
let portCursor = 6850;

process.stderr.write(
  `\n[bench] ${conditions.length} condition(s)${DRY_RUN ? " (DRY RUN)" : ""} · auth: ${authNames.join("+")}${PRICE ? " · pricing: on" : ""} · harness: ${DRY_RUN ? "stub" : HARNESS}\n`,
);

for (const cond of conditions) {
  const isDistrai = !!cond.config;
  const port = portCursor++;
  const resultPath = join(tmpdir(), `bench-${port}.json`);
  let cfgPath: string | undefined;
  let gw: ReturnType<typeof startGateway> | undefined;

  process.stderr.write(`\n[bench] ${cond.name}${isDistrai ? ` on :${port}` : " (passthrough)"}…\n`);

  let row: Row;
  try {
    if (isDistrai) {
      cfgPath = join(tmpdir(), `bench-cfg-${port}.json`);
      writeFileSync(cfgPath, JSON.stringify(cond.config));
      gw = startGateway(cfgPath, port);
      const up = await waitForPort(port);
      if (!up) throw new Error("gateway did not start");
    }

    const url = isDistrai ? `http://127.0.0.1:${port}` : "";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISTRAI_BENCH_URL: url,
      DISTRAI_BENCH_MODEL: cond.model,
      DISTRAI_BENCH_RESULT: resultPath,
      DISTRAI_BENCH_NUM_TESTS: NUM_TESTS,
      DISTRAI_BENCH_CONDITION: cond.name,
      ...(isDistrai
        ? {
            // Cover both harness families: Anthropic-SDK/Inspect read ANTHROPIC_BASE_URL,
            // LiteLLM/aider read ANTHROPIC_API_BASE. The key is a dummy (gateway auth is off).
            ANTHROPIC_BASE_URL: url,
            ANTHROPIC_API_BASE: url,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "distrai",
          }
        : {}),
      ...cond.env,
    };

    const t0 = Date.now();
    const res = runHarness(env, resultPath);
    const durationS = Math.round((Date.now() - t0) / 1000);
    // execFileSync blocks the loop, so the gateway's piped stderr hasn't flushed — yield a tick.
    if (gw) await new Promise((r) => setTimeout(r, 1000));
    row = {
      condition: cond.name,
      ...res,
      durationS,
      gatewayCostUsd: gw ? sumGatewayCost(gw.getLog()) : undefined,
    };
  } catch (e) {
    row = {
      condition: cond.name,
      pass_rate_1: 0,
      pass_rate_2: 0,
      percent_well_formed: 0,
      cost_usd: 0,
      n: 0,
      durationS: 0,
      error: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  } finally {
    gw?.proc.kill("SIGTERM");
    if (cfgPath && existsSync(cfgPath)) rmSync(cfgPath, { force: true });
    if (existsSync(resultPath)) rmSync(resultPath, { force: true });
  }

  rows.push(row);
  process.stderr.write(
    row.error
      ? `[bench] → ERROR | ${row.error}\n`
      : `[bench] → pass@1 ${row.pass_rate_1}% · pass@2 ${row.pass_rate_2}% · well-formed ${row.percent_well_formed}% · ${rowTokK(row)} tok · $${rowCost(row).toFixed(2)} · ${row.durationS}s\n`,
  );
}

// ── report ─────────────────────────────────────────────────────────────────
console.log("\n=== distrai bench-matrix ===");
console.log(`${"condition".padEnd(30)} n    pass@1  pass@2  well%   tok     cost($)  dur(s)`);
for (const r of rows) {
  if (r.error) {
    console.log(`${r.condition.padEnd(30)} ERROR: ${r.error}`);
    continue;
  }
  console.log(
    `${r.condition.padEnd(30)} ${String(r.n).padEnd(4)} ${`${r.pass_rate_1}%`.padEnd(7)} ${`${r.pass_rate_2}%`.padEnd(7)} ${`${r.percent_well_formed}%`.padEnd(7)} ${rowTokK(r).padEnd(7)} ${rowCost(r).toFixed(2).padEnd(8)} ${r.durationS}`,
  );
}
console.log(
  "\nRead it as: does a council beat its own best single member (and the raw model) on pass@2,\n" +
    "and is the cost/latency premium worth it? Notes:\n" +
    "• cost($) on distrai rows is the gateway-measured spend; on OAuth/subscription it can read $0\n" +
    "  (and codex reports none) — use the `tok` column as the comparable usage metric there.\n" +
    "• well% — a low well-formed rate means the synthesizer is mangling the harness's edit format,\n" +
    "  which caps pass-rate independent of reasoning quality (a distrai fix, not a benchmark result).",
);
