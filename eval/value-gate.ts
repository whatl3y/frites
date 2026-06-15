#!/usr/bin/env -S npx tsx
/**
 * distrai value-gate: does fan-out + synthesis actually beat a single agent on coding tasks?
 *
 * For each fixture × each condition (single vs council), it starts the gateway with that config,
 * runs the task through a REAL `claude` client (ANTHROPIC_BASE_URL → gateway, bypassPermissions),
 * runs the fixture's verify command, and records pass/fail + turns + cost + duration.
 *
 * Run:  pnpm eval            (default fixtures)
 * Cost: each run is a real, metered coding session — start small.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "../.."); // <repo>/eval/value-gate.ts → <repo>

interface Fixture {
  name: string;
  files: Record<string, string>;
  task: string;
  verify: string; // shell command; exit 0 = pass
}
interface Condition {
  name: string;
  config: Record<string, unknown>;
}

const FIXTURES: Fixture[] = [
  {
    name: "fix-add",
    files: {
      "add.js": "const add = (a, b) => a - b; // BUG\nmodule.exports = { add };\n",
      "add.test.js":
        'const test=require("node:test");const assert=require("node:assert");const {add}=require("./add");test("add",()=>{assert.strictEqual(add(2,3),5);assert.strictEqual(add(-1,1),0);});\n',
      "package.json": '{"name":"vg","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}\n',
    },
    task: "Fix the bug in add.js so that 'npm test' passes.",
    verify: "npm test",
  },
];

const CONDITIONS: Condition[] = [
  {
    name: "single",
    config: { fanOutPolicy: "never", defaultAgents: [{ id: "c1", kind: "claude-cli" }] },
  },
  {
    name: "council",
    config: {
      fanOutPolicy: "always",
      defaultN: 2,
      // Heterogeneous: claude + codex parallelize across two providers, avoiding a single
      // subscription's concurrency throttle. Synth (defaultAgents[0]) is claude.
      defaultAgents: [
        { id: "c1", kind: "claude-cli", framing: "Make the smallest correct change." },
        { id: "x1", kind: "codex-cli", framing: "Double-check correctness before editing." },
      ],
    },
  },
];

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function setupRepo(fx: Fixture): string {
  const dir = mkdtempSync(join(tmpdir(), `vg-${fx.name}-`));
  writeFiles(dir, fx.files);
  writeFileSync(join(dir, ".gitignore"), ".distrai/\nnode_modules/\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "vg@vg.vg"]);
  git(["config", "user.name", "vg"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

function startGateway(configPath: string, port: number) {
  // Spawn tsx directly (not via `pnpm`) so the gateway's stderr telemetry is captured cleanly.
  const tsxBin = join(REPO, "node_modules", ".bin", "tsx");
  const proc = spawn(tsxBin, [join(REPO, "apps", "gateway", "src", "index.ts")], {
    env: {
      ...process.env,
      DISTRAI_GLOBAL_CONFIG: configPath,
      DISTRAI_GATEWAY_PORT: String(port),
      DISTRAI_GATEWAY_HOST: "127.0.0.1",
      // ensure the gateway itself is never pointed at itself
      ANTHROPIC_BASE_URL: "",
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
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

function runClient(repoDir: string, port: number, task: string): { numTurns: number; error?: string } {
  try {
    const out = execFileSync(
      "claude",
      ["-p", task, "--permission-mode", "bypassPermissions", "--output-format", "json"],
      {
        cwd: repoDir,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_AUTH_TOKEN: "distrai",
        },
        timeout: 600000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    const obj = JSON.parse(out) as { num_turns?: number };
    return { numTurns: obj.num_turns ?? 0 };
  } catch (e) {
    return { numTurns: 0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

function verify(repoDir: string, cmd: string): boolean {
  try {
    execFileSync("bash", ["-lc", cmd], { cwd: repoDir, stdio: "ignore", timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}

function sumCost(log: string): number {
  let total = 0;
  for (const m of log.matchAll(/\$([0-9]+\.[0-9]+)/g)) total += Number(m[1]);
  return total;
}

interface Row {
  fixture: string;
  condition: string;
  passed: boolean;
  turns: number;
  costUsd: number;
  durationS: number;
  error?: string;
}

const rows: Row[] = [];
let portCursor = 6800;

for (const fx of FIXTURES) {
  for (const cond of CONDITIONS) {
    const port = portCursor++;
    const repoDir = setupRepo(fx);
    const cfgPath = join(tmpdir(), `vg-cfg-${cond.name}-${port}.json`);
    writeFileSync(cfgPath, JSON.stringify(cond.config));
    process.stderr.write(`\n[value-gate] ${fx.name} / ${cond.name} on :${port}…\n`);
    const gw = startGateway(cfgPath, port);
    const up = await waitForPort(port);
    let row: Row;
    if (!up) {
      row = { fixture: fx.name, condition: cond.name, passed: false, turns: 0, costUsd: 0, durationS: 0, error: "gateway did not start" };
    } else {
      const t0 = Date.now();
      const res = runClient(repoDir, port, fx.task);
      const durationS = Math.round((Date.now() - t0) / 1000);
      const passed = res.error ? false : verify(repoDir, fx.verify);
      // runClient/verify are execFileSync (they block the event loop), so the gateway's piped
      // stderr 'data' events haven't fired yet — yield a tick so logBuf fills before we read cost.
      await new Promise((r) => setTimeout(r, 1500));
      row = {
        fixture: fx.name,
        condition: cond.name,
        passed,
        turns: res.numTurns,
        costUsd: sumCost(gw.getLog()),
        durationS,
        error: res.error,
      };
    }
    gw.proc.kill("SIGTERM");
    if (existsSync(cfgPath)) rmSync(cfgPath, { force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rows.push(row);
    process.stderr.write(
      `[value-gate] → ${row.passed ? "PASS" : "FAIL"} | ${row.turns} turns | $${row.costUsd.toFixed(3)} | ${row.durationS}s${row.error ? ` | ${row.error}` : ""}\n`,
    );
  }
}

console.log("\n=== distrai value-gate results ===");
console.log("fixture            condition  passed  turns  cost($)  dur(s)");
for (const r of rows) {
  console.log(
    `${r.fixture.padEnd(18)} ${r.condition.padEnd(9)} ${(r.passed ? "yes" : "no").padEnd(6)} ${String(r.turns).padEnd(6)} ${r.costUsd.toFixed(3).padEnd(8)} ${r.durationS}`,
  );
}
const byCond = (c: string) => rows.filter((r) => r.condition === c);
for (const c of CONDITIONS.map((x) => x.name)) {
  const rs = byCond(c);
  const pass = rs.filter((r) => r.passed).length;
  const cost = rs.reduce((a, r) => a + r.costUsd, 0);
  console.log(`\n${c}: ${pass}/${rs.length} passed, total $${cost.toFixed(3)}`);
}
console.log(
  "\nInterpretation: council should match or beat single on pass-rate to justify its extra cost.",
);
