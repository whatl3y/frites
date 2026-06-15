import { describe, expect, it } from "vitest";
import {
  type AgentSpec,
  type EngineDeps,
  type OracleCommands,
  type Task,
  resolveConfig,
  runEngine,
} from "@frites/core";

interface DiffEntry {
  diff: string;
  filesTouched: string[];
}

function scenario(opts: {
  agents: AgentSpec[];
  diffs: Record<string, DiffEntry>;
  oracle?: Record<string, boolean>;
  commands?: OracleCommands;
}): { deps: EngineDeps; task: Task } {
  const config = resolveConfig({
    defaultAgents: opts.agents,
    defaultN: opts.agents.length,
  });
  const deps: EngineDeps = {
    worktrees: {
      async resolveBase() {
        return { ref: "HEAD", sha: "abc123" };
      },
      async create(_repo, _runId, agentId) {
        return { path: agentId, branch: `b/${agentId}` };
      },
      async captureDiff(path) {
        return opts.diffs[path] ?? { diff: "", filesTouched: [] };
      },
      async cleanup() {},
    },
    async runAgent() {
      return { status: "succeeded" };
    },
    async runOracle(_cwd, agentId) {
      const passed = opts.oracle?.[agentId] ?? false;
      return { agentId, passed, hadOracle: true };
    },
    oracleCommands: opts.commands ?? {},
    config,
    newRunId: () => "run1",
  };
  const task: Task = { instructions: "do the thing", repoPath: "/repo" };
  return { deps, task };
}

const SMALL: DiffEntry = { diff: "+a", filesTouched: ["a.ts"] };
const BIG: DiffEntry = {
  diff: "+a\n+b\n+c\n+d",
  filesTouched: ["a.ts", "b.ts"],
};

describe("runEngine reconciliation", () => {
  it("picks the single oracle survivor", async () => {
    const { deps, task } = scenario({
      agents: [
        { id: "A", kind: "claude-cli" },
        { id: "B", kind: "codex-cli" },
      ],
      diffs: { A: SMALL, B: BIG },
      oracle: { A: true, B: false },
      commands: { test: "pnpm test" },
    });
    const r = await runEngine(task, deps);
    expect(r.decision).toBe("tests");
    expect(r.recommended?.agentId).toBe("A");
  });

  it("tie-breaks multiple survivors by smallest diff", async () => {
    const { deps, task } = scenario({
      agents: [
        { id: "A", kind: "claude-cli" },
        { id: "B", kind: "codex-cli" },
      ],
      diffs: { A: BIG, B: SMALL },
      oracle: { A: true, B: true },
      commands: { test: "pnpm test" },
    });
    const r = await runEngine(task, deps);
    expect(r.decision).toBe("judge");
    expect(r.recommended?.agentId).toBe("B");
  });

  it("surfaces a near-miss when nothing passes the oracle", async () => {
    const { deps, task } = scenario({
      agents: [
        { id: "A", kind: "claude-cli" },
        { id: "B", kind: "codex-cli" },
      ],
      diffs: { A: SMALL, B: BIG },
      oracle: { A: false, B: false },
      commands: { test: "pnpm test" },
    });
    const r = await runEngine(task, deps);
    expect(r.decision).toBe("near-miss");
    expect(r.recommended?.agentId).toBe("A"); // smaller near-miss
  });

  it("falls back to a best-effort pick when there is no oracle", async () => {
    const { deps, task } = scenario({
      agents: [
        { id: "A", kind: "claude-cli" },
        { id: "B", kind: "codex-cli" },
      ],
      diffs: { A: BIG, B: SMALL },
      commands: {}, // no oracle commands
    });
    const r = await runEngine(task, deps);
    expect(r.decision).toBe("no-oracle");
    expect(r.recommended?.agentId).toBe("B");
  });
});
