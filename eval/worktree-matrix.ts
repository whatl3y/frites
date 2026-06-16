/**
 * eval/worktree-matrix.ts — `pnpm wbench`
 *
 * Benchmarks the **worktree engine** (oracle-gated selection + `synthesisMode` synthesis) on Aider
 * polyglot exercises, calling `runEngine` DIRECTLY instead of routing through the gateway. This is
 * the complement to `bench-matrix.ts` (`pnpm bench`): that one measures gateway *answer* fusion (a
 * blind LLM merge of child text, no verification); THIS one measures the highest-value fusion
 * workflow — N full child implementations in isolated git worktrees, an executable oracle filtering
 * them, synthesis from the oracle-passing candidates, and a re-run of the SAME oracle against the
 * synthesized diff with a guarded fallback to the best original passer.
 *
 * Each exercise becomes an isolated git repo (solution stub + tests committed). The oracle is the
 * exercise's own test suite, run INSIDE the `aider-benchmark` Docker image so generated code never
 * executes on the host. The agents themselves run on the host (they need your claude/codex OAuth).
 *
 *   pnpm wbench --dry-run                              # free: seed cases + self-test the Docker
 *                                                      #   oracle against the reference solution
 *   pnpm wbench --combos claude+3codex --synthesis passing-only --num-tests 25 --langs python
 *   pnpm wbench --combos claude,codex,claude+codex --synthesis both --num-tests 25 --langs python
 *
 * Prereqs: the aider polyglot harness set up (see eval/README.md "One-time setup"), Docker running,
 * and `claude`/`codex` logged in. Every non-dry run is METERED (each case spawns the child CLIs).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type AgentSpec,
  type EngineDeps,
  type FritesConfig,
  type RunResult,
  type Task,
  resolveConfig,
  runEngine,
  runOracle,
} from "@frites/core";
import { defaultRunners, makeRunAgent } from "@frites/agents";
import { WorktreeManager } from "@frites/isolation";

// ── locations ────────────────────────────────────────────────────────────────
const POLYGLOT =
  process.env.FRITES_WBENCH_POLYGLOT ??
  join(homedir(), "aider", "tmp.benchmarks", "polyglot-benchmark");
const IMAGE = process.env.AIDER_DOCKER_IMAGE ?? "aider-benchmark";
// Worktrees live under <repo>/.frites/... so each case repo must sit on a Docker-mountable path.
// $HOME (under /Users on macOS) is shared by Docker Desktop by default; the system tmpdir is not.
const WORKDIR = process.env.FRITES_WBENCH_DIR ?? join(homedir(), ".frites-wbench");

/** Per-language oracle command, run INSIDE the aider-benchmark image with cwd=/work. Mirrors aider's
 *  benchmark TEST_COMMANDS (the js/cpp helper scripts ship inside that image). */
const TEST_CMD: Record<string, string> = {
  python: "pytest",
  rust: "cargo test -- --include-ignored",
  go: "go test ./...",
  javascript: "/aider/benchmark/npm-test.sh",
  cpp: "/aider/benchmark/cpp-test.sh",
  java: "./gradlew test",
};
const ALL_LANGS = Object.keys(TEST_CMD);

// ── agent combinations (a combo is a defaultAgents list) ───────────────────────
const FRAME_MIN = "Make the smallest correct change that satisfies the task.";
const FRAME_CLEAN = "Prefer a clean, well-structured solution.";
const FRAME_CHECK = "Double-check correctness against the tests before finalizing.";
const FRAME_EDGE = "Consider edge cases and failure modes carefully.";
const COMBOS: Record<string, AgentSpec[]> = {
  claude: [{ id: "c1", kind: "claude-cli" }],
  codex: [{ id: "x1", kind: "codex-cli" }],
  "claude+codex": [
    { id: "c1", kind: "claude-cli", framing: FRAME_MIN },
    { id: "x1", kind: "codex-cli", framing: FRAME_CHECK },
  ],
  "claude+2codex": [
    { id: "c1", kind: "claude-cli", framing: FRAME_MIN },
    { id: "x1", kind: "codex-cli", framing: FRAME_CHECK },
    { id: "x2", kind: "codex-cli", framing: FRAME_CLEAN },
  ],
  // The headline cross-model fusion panel: claude integrates three diverse codex implementations.
  "claude+3codex": [
    { id: "c1", kind: "claude-cli", framing: FRAME_MIN },
    { id: "x1", kind: "codex-cli", framing: FRAME_CHECK },
    { id: "x2", kind: "codex-cli", framing: FRAME_CLEAN },
    { id: "x3", kind: "codex-cli", framing: FRAME_EDGE },
  ],
};

// ── args ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const DRY_RUN = argv.includes("--dry-run");
const KEEP = argv.includes("--keep");
const NUM_TESTS = Number(flag("--num-tests") ?? "10");
const CONCURRENCY = Math.max(1, Number(flag("--concurrency") ?? "1"));
const comboNames = (flag("--combos") ?? "claude,codex,claude+codex")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const langs = (flag("--langs") ?? "python")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// off | passing-only | both. Single-agent combos run "off" only (synthesis never fires with <2 passers).
const synthArg = (flag("--synthesis") ?? "passing-only").toLowerCase();
const synthModes: Array<"off" | "passing-only"> =
  synthArg === "both" ? ["off", "passing-only"] : synthArg === "off" ? ["off"] : ["passing-only"];

for (const c of comboNames) {
  if (!COMBOS[c]) {
    process.stderr.write(`[wbench] unknown --combos "${c}" (have: ${Object.keys(COMBOS).join(", ")})\n`);
    process.exit(1);
  }
}
for (const l of langs) {
  if (!TEST_CMD[l]) {
    process.stderr.write(`[wbench] unknown --langs "${l}" (have: ${ALL_LANGS.join(", ")})\n`);
    process.exit(1);
  }
}

// ── exercise discovery (round-robin across languages, deterministic) ────────────
interface Exercise {
  lang: string;
  name: string;
  path: string;
  solution: string[];
  test: string[];
  example: string[];
  instructions: string;
}

function readExercise(lang: string, dir: string): Exercise | null {
  const cfgPath = join(dir, ".meta", "config.json");
  if (!existsSync(cfgPath)) return null;
  let cfg: { files?: { solution?: string[]; test?: string[]; example?: string[] } };
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    return null;
  }
  const solution = cfg.files?.solution ?? [];
  const test = cfg.files?.test ?? [];
  const example = cfg.files?.example ?? [];
  if (!solution.length || !test.length) return null;
  let instructions = "";
  for (const f of ["instructions.md", "instructions.append.md"]) {
    const p = join(dir, ".docs", f);
    if (existsSync(p)) instructions += `${readFileSync(p, "utf8")}\n\n`;
  }
  return { lang, name: basename(dir), path: dir, solution, test, example, instructions: instructions.trim() };
}

function discover(): Exercise[] {
  const perLang: Exercise[][] = langs.map((lang) => {
    const root = join(POLYGLOT, lang, "exercises", "practice");
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .map((name) => readExercise(lang, join(root, name)))
      .filter((e): e is Exercise => e !== null);
  });
  // Round-robin so a multi-language run is balanced rather than front-loaded by one language.
  const out: Exercise[] = [];
  for (let i = 0; out.length < NUM_TESTS; i++) {
    let added = false;
    for (const list of perLang) {
      if (list[i]) {
        out.push(list[i]!);
        added = true;
        if (out.length >= NUM_TESTS) break;
      }
    }
    if (!added) break;
  }
  return out;
}

// ── per-case git repo seeding ───────────────────────────────────────────────────
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const RUN_TAG = new Date().toISOString().replace(/[:.]/g, "-");

function git(repo: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

/** Materialize an exercise as an isolated git repo: solution stub + tests committed, reference
 *  solution (.meta) and docs withheld. Returns the repo path. */
function seedRepo(ex: Exercise): string {
  const repo = join(WORKDIR, RUN_TAG, `${ex.lang}__${ex.name}`);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  // Copy everything EXCEPT .meta (holds the reference solution) and .docs.
  cpSync(ex.path, repo, {
    recursive: true,
    filter: (src) => !/\/\.meta(\/|$)/.test(src) && !/\/\.docs(\/|$)/.test(src),
  });
  // Java: strip @Disabled(...) so the full suite runs (mirrors aider).
  for (const t of ex.test) {
    if (!t.endsWith(".java")) continue;
    const p = join(repo, t);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, "utf8").replace(/@Disabled\([^)]*\)\s*\n/g, ""));
  }
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, [
    "-c",
    "user.email=wbench@frites.local",
    "-c",
    "user.name=frites wbench",
    "commit",
    "-q",
    "-m",
    "seed",
  ]);
  return repo;
}

/** The oracle command for a case: restore canonical tests (anti-cheat), then run the language's test
 *  suite inside the sandbox image, mounting the candidate's worktree (resolved at run time via $PWD).
 *  Runs as the host uid so generated artifacts stay host-cleanable. */
function oracleTestCommand(ex: Exercise): string {
  const restore = ex.test.length ? `git checkout HEAD -- ${ex.test.map(shq).join(" ")} 2>/dev/null; ` : "";
  const docker =
    `docker run --rm -e HOME=/tmp --user "$(id -u):$(id -g)" ` +
    `-v "$PWD":/work -w /work ${IMAGE} ${TEST_CMD[ex.lang]}`;
  return `${restore}${docker}`;
}

function buildConfig(agents: AgentSpec[], mode: "off" | "passing-only"): FritesConfig {
  return resolveConfig({
    defaultAgents: agents,
    synthesisMode: mode,
    passApiKeys: process.env.FRITES_PASS_API_KEYS === "1",
    oracle: { autoDetect: false }, // engine uses deps.oracleCommands; this just disables detection
  });
}

function buildDeps(repo: string, config: FritesConfig, ex: Exercise): EngineDeps {
  return {
    worktrees: new WorktreeManager(),
    runAgent: makeRunAgent({ runners: defaultRunners, config, passApiKeys: config.passApiKeys }),
    runOracle,
    oracleCommands: { test: oracleTestCommand(ex) },
    config,
    newRunId: () => randomUUID().slice(0, 8),
  };
}

function taskFor(ex: Exercise, repo: string, agents: AgentSpec[]): Task {
  const instr =
    `${ex.instructions}\n\n` +
    `Implement your solution in: ${ex.solution.join(", ")}. ` +
    `The test file(s) ${ex.test.join(", ")} define correctness and will be run to verify your work — ` +
    `do not modify them. The language toolchain may not be installed on this machine, so reason ` +
    `carefully about correctness rather than relying on running the tests yourself.`;
  return { repoPath: repo, instructions: instr, agents };
}

// ── result types ─────────────────────────────────────────────────────────────
interface CaseResult {
  exercise: string;
  lang: string;
  finalPass: boolean;
  decision: string;
  originalPassCount: number;
  candidateCount: number;
  synthAttempted: boolean;
  synthRecommended: boolean;
  synthPassed: boolean | null;
  fallbackReason: string | null;
  skippedReason: string | null;
  costUsd: number | null;
  durationMs: number;
  error: string | null;
}

interface Condition {
  name: string;
  agents: AgentSpec[];
  mode: "off" | "passing-only";
}

function buildConditions(): Condition[] {
  const out: Condition[] = [];
  for (const cn of comboNames) {
    const agents = COMBOS[cn]!;
    const single = agents.length < 2;
    // Single-agent combos: synthesis can never fire (needs >=2 passers), so run "off" once.
    const modes = single ? (["off"] as const) : synthModes;
    for (const mode of modes) {
      out.push({
        name: single ? cn : `${cn} [synth:${mode === "off" ? "off" : "on"}]`,
        agents,
        mode,
      });
    }
  }
  return out;
}

function costOf(result: RunResult): number | null {
  let total = 0;
  let any = false;
  for (const c of result.candidates) {
    if (typeof c.costUsd === "number") {
      total += c.costUsd;
      any = true;
    }
  }
  return any ? total : null;
}

async function runCase(cond: Condition, ex: Exercise): Promise<CaseResult> {
  const started = Date.now();
  const base: CaseResult = {
    exercise: `${ex.lang}/${ex.name}`,
    lang: ex.lang,
    finalPass: false,
    decision: "n/a",
    originalPassCount: 0,
    candidateCount: 0,
    synthAttempted: false,
    synthRecommended: false,
    synthPassed: null,
    fallbackReason: null,
    skippedReason: null,
    costUsd: null,
    durationMs: 0,
    error: null,
  };
  let repo: string | undefined;
  try {
    repo = seedRepo(ex);
    const config = buildConfig(cond.agents, cond.mode);
    const deps = buildDeps(repo, config, ex);
    const result = await runEngine(taskFor(ex, repo, cond.agents), deps);
    const oracleById = new Map(result.oracle.map((o) => [o.agentId, o]));
    const rec = result.recommended;
    const s = result.synthesis;
    return {
      ...base,
      finalPass: !!rec && oracleById.get(rec.agentId)?.passed === true,
      decision: result.decision,
      candidateCount: result.candidates.filter((c) => !c.synthesis).length,
      originalPassCount: result.candidates.filter(
        (c) => !c.synthesis && oracleById.get(c.agentId)?.passed === true,
      ).length,
      synthAttempted: s?.attempted ?? false,
      synthRecommended: s?.recommended ?? false,
      synthPassed: s?.passed ?? null,
      fallbackReason: s?.fallbackReason ?? null,
      skippedReason: s?.skippedReason ?? null,
      costUsd: costOf(result),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started };
  } finally {
    if (repo && !KEEP) rmSync(repo, { recursive: true, force: true });
  }
}

// ── dry run: free oracle self-test (reference solution must PASS) ───────────────
function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

async function selfTest(exercises: Exercise[]): Promise<void> {
  process.stderr.write(
    `\n[wbench] DRY RUN — self-testing the Docker oracle against the reference solution for ` +
      `${exercises.length} case(s). No agents run; expect every case to PASS.\n`,
  );
  let pass = 0;
  for (const ex of exercises) {
    const repo = seedRepo(ex);
    try {
      // Overlay the reference solution onto the stub(s), then run the oracle in-place.
      for (let i = 0; i < ex.solution.length; i++) {
        const ref = ex.example[i] ?? ex.example[0];
        if (ref && existsSync(join(ex.path, ref))) {
          cpSync(join(ex.path, ref), join(repo, ex.solution[i]!));
        }
      }
      const res = await runOracle(repo, "selftest", { test: oracleTestCommand(ex) }, { timeoutMs: 180_000 });
      const ok = res.passed;
      if (ok) pass++;
      process.stderr.write(`  ${ok ? "PASS" : "FAIL"}  ${ex.lang}/${ex.name}\n`);
      if (!ok) process.stderr.write(`        ${(res.test?.output ?? "").split("\n").slice(-4).join("\n        ")}\n`);
    } finally {
      if (!KEEP) rmSync(repo, { recursive: true, force: true });
    }
  }
  process.stderr.write(`\n[wbench] oracle self-test: ${pass}/${exercises.length} reference solutions passed.\n`);
  if (pass !== exercises.length) {
    process.stderr.write(`[wbench] ⚠ oracle wiring is not clean — fix before a real run.\n`);
    process.exit(1);
  }
}

// ── reporting ─────────────────────────────────────────────────────────────────
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function aggregate(name: string, cases: CaseResult[]): Record<string, unknown> {
  const n = cases.length;
  const passN = cases.filter((c) => c.finalPass).length;
  const attempted = cases.filter((c) => c.synthAttempted).length;
  const recommended = cases.filter((c) => c.synthRecommended).length;
  const fellBack = cases.filter((c) => c.synthAttempted && !c.synthRecommended).length;
  const errored = cases.filter((c) => c.error).length;
  const costs = cases.map((c) => c.costUsd).filter((v): v is number => typeof v === "number");
  const cost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  const durS = Math.round(cases.reduce((a, c) => a + c.durationMs, 0) / 1000);
  return {
    condition: name,
    n,
    pass: passN,
    passRate: n ? Math.round((passN / n) * 100) : 0,
    synthAttempted: attempted,
    synthRecommended: recommended,
    synthFellBack: fellBack,
    errored,
    costUsd: cost,
    durationS: durS,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function main() {
  if (!existsSync(POLYGLOT)) {
    process.stderr.write(
      `[wbench] polyglot benchmark not found at ${POLYGLOT}. See eval/README.md "One-time setup", ` +
        `or set FRITES_WBENCH_POLYGLOT.\n`,
    );
    process.exit(1);
  }
  if (!dockerAvailable()) {
    process.stderr.write(`[wbench] Docker is not available (the oracle runs generated code in ${IMAGE}). Start Docker.\n`);
    process.exit(1);
  }
  const exercises = discover();
  if (exercises.length === 0) {
    process.stderr.write(`[wbench] no exercises discovered for langs=${langs.join(",")} under ${POLYGLOT}.\n`);
    process.exit(1);
  }
  mkdirSync(join(WORKDIR, RUN_TAG), { recursive: true });

  if (DRY_RUN) {
    await selfTest(exercises);
    return;
  }

  const conditions = buildConditions();
  process.stderr.write(
    `\n[wbench] ${conditions.length} condition(s) × ${exercises.length} case(s) ` +
      `[langs: ${langs.join(",")}] · concurrency ${CONCURRENCY} · image ${IMAGE}\n` +
      `[wbench] conditions: ${conditions.map((c) => c.name).join(" | ")}\n`,
  );

  const rows: Record<string, unknown>[] = [];
  const allCases: Record<string, CaseResult[]> = {};
  for (const cond of conditions) {
    process.stderr.write(`\n[wbench] === ${cond.name} ===\n`);
    let done = 0;
    const cases = await mapLimit(exercises, CONCURRENCY, async (ex) => {
      const r = await runCase(cond, ex);
      done++;
      const tag = r.error ? "ERR " : r.finalPass ? "pass" : "fail";
      const synth = r.synthAttempted ? (r.synthRecommended ? " synth✓" : " synth→fallback") : "";
      process.stderr.write(
        `  [${done}/${exercises.length}] ${tag}  ${pad(r.exercise, 28)} ` +
          `decision=${r.decision} origPass=${r.originalPassCount}/${r.candidateCount}${synth} ` +
          `${Math.round(r.durationMs / 1000)}s${r.error ? `  (${r.error.slice(0, 60)})` : ""}\n`,
      );
      return r;
    });
    allCases[cond.name] = cases;
    rows.push(aggregate(cond.name, cases));
  }

  // ── matrix ──
  process.stderr.write(`\n=== frites worktree-matrix (oracle-gated synthesis) ===\n`);
  const header = `${pad("condition", 26)} n   pass  pass%  synth(att/rec/fb)  err  cost($)  dur(s)`;
  process.stderr.write(header + "\n");
  for (const r of rows as Array<ReturnType<typeof aggregate>>) {
    const cost = r.costUsd == null ? "n/a" : (r.costUsd as number).toFixed(2);
    process.stderr.write(
      `${pad(String(r.condition), 26)} ${pad(String(r.n), 3)} ` +
        `${pad(String(r.pass), 5)} ${pad(String(r.passRate) + "%", 6)} ` +
        `${pad(`${r.synthAttempted}/${r.synthRecommended}/${r.synthFellBack}`, 18)} ` +
        `${pad(String(r.errored), 4)} ${pad(cost, 8)} ${r.durationS}\n`,
    );
  }
  process.stderr.write(
    `\nReads as: pass% is the FINAL recommended candidate verified by the oracle. synth(att/rec/fb) = ` +
      `synthesis attempted / recommended over originals / attempted-but-fell-back. cost($) sums ` +
      `claude's self-reported spend (codex reports none on the OAuth backend).\n`,
  );

  const outPath = join(WORKDIR, RUN_TAG, "results.json");
  writeFileSync(outPath, JSON.stringify({ runTag: RUN_TAG, langs, conditions: rows, cases: allCases }, null, 2));
  process.stderr.write(`\n[wbench] full results: ${outPath}\n`);
}

main().catch((e) => {
  process.stderr.write(`[wbench] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
