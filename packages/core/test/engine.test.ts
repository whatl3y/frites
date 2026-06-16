import { describe, expect, it } from "vitest";
import {
  type AgentRunOutput,
  type AgentSpec,
  type EngineDeps,
  type ModelPricing,
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
  /** Per-agent runAgent output (tokens/cost). Defaults to a bare success when omitted. */
  outputs?: Record<string, AgentRunOutput>;
  pricing?: Record<string, ModelPricing>;
}): { deps: EngineDeps; task: Task } {
  const config = resolveConfig({
    defaultAgents: opts.agents,
    defaultN: opts.agents.length,
    pricing: opts.pricing,
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
    async runAgent(spec) {
      return opts.outputs?.[spec.id] ?? { status: "succeeded" };
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

describe("runEngine usage + cost surfacing", () => {
  it("surfaces per-candidate token usage from the runAgent output", async () => {
    const { deps, task } = scenario({
      agents: [
        { id: "A", kind: "claude-cli" },
        { id: "B", kind: "codex-cli" },
      ],
      diffs: { A: SMALL, B: SMALL },
      outputs: {
        A: { status: "succeeded", costUsd: 0.5, inputTokens: 2000, outputTokens: 100 },
        B: { status: "succeeded", inputTokens: 11224, outputTokens: 33 }, // codex: no cost reported
      },
    });
    const r = await runEngine(task, deps);
    const byId = new Map(r.candidates.map((c) => [c.agentId, c]));
    expect(byId.get("B")?.outputTokens).toBe(33); // codex no longer reads as zero-token
    expect(byId.get("B")?.costUsd).toBeUndefined();
    expect(byId.get("A")?.inputTokens).toBe(2000);
  });

  it("estimates codex spend from tokens when its backend reports no cost", async () => {
    const { deps, task } = scenario({
      agents: [{ id: "B", kind: "codex-cli", model: "gpt-5.5" }],
      diffs: { B: SMALL },
      outputs: {
        B: { status: "succeeded", inputTokens: 1_000_000, outputTokens: 1_000_000 },
      },
      pricing: { "gpt-5.5": { inputPerMtok: 1, outputPerMtok: 10 } },
    });
    const r = await runEngine(task, deps);
    // 1M input @ $1 + 1M output @ $10 = $11.000, marked "~" because it's estimated, not reported.
    expect(r.costNote).toContain("~$11.000");
  });

  it("notes when no cost telemetry and no pricing are available", async () => {
    const { deps, task } = scenario({
      agents: [{ id: "B", kind: "codex-cli" }],
      diffs: { B: SMALL },
      outputs: { B: { status: "succeeded", inputTokens: 100, outputTokens: 50 } },
    });
    const r = await runEngine(task, deps);
    expect(r.costNote).toContain("Cost telemetry not available");
  });
});
