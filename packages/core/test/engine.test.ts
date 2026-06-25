import { describe, expect, it } from "vitest";
import {
  type AgentRunOutput,
  type AgentSpec,
  type EngineDeps,
  type EngineEvent,
  type ModelPricing,
  type OracleCommands,
  type Task,
  resolveConfig,
  runEngine,
  selectAgents,
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
  /** Synthesis-related config overrides (merged into resolveConfig). */
  config?: Record<string, unknown>;
  /** Agent ids whose runAgent should throw (to exercise error/cleanup paths). */
  throwOn?: string[];
  /** Pre-aborted external signal. */
  aborted?: boolean;
}): {
  deps: EngineDeps;
  task: Task;
  cleaned: string[];
  applied: Array<{ path: string; diff: string }>;
  created: Array<{ agentId: string; baseSha: string }>;
} {
  const config = resolveConfig({
    defaultAgents: opts.agents,
    defaultN: opts.agents.length,
    pricing: opts.pricing,
    ...opts.config,
  });
  const cleaned: string[] = [];
  const applied: Array<{ path: string; diff: string }> = [];
  const created: Array<{ agentId: string; baseSha: string }> = [];
  const throwOn = new Set(opts.throwOn ?? []);
  const deps: EngineDeps = {
    worktrees: {
      async resolveBase() {
        return { ref: "HEAD", sha: "abc123" };
      },
      async create(_repo, _runId, agentId, baseSha) {
        created.push({ agentId, baseSha });
        return { path: agentId, branch: `b/${agentId}` };
      },
      async captureDiff(path) {
        return opts.diffs[path] ?? { diff: "", filesTouched: [] };
      },
      async cleanup(_repo, handle) {
        cleaned.push(handle.path);
      },
      async applyDiffToWorktree(path, diff) {
        applied.push({ path, diff });
      },
    },
    async runAgent(spec) {
      if (throwOn.has(spec.id)) throw new Error(`boom:${spec.id}`);
      return opts.outputs?.[spec.id] ?? { status: "succeeded" };
    },
    async runOracle(_cwd, agentId) {
      const passed = opts.oracle?.[agentId] ?? false;
      return { agentId, passed, hadOracle: true };
    },
    oracleCommands: opts.commands ?? {},
    config,
    newRunId: () => "run1",
    signal: opts.aborted ? AbortSignal.abort() : undefined,
  };
  const task: Task = { instructions: "do the thing", repoPath: "/repo" };
  return { deps, task, cleaned, applied, created };
}

const SMALL: DiffEntry = { diff: "+a", filesTouched: ["a.ts"] };
const BIG: DiffEntry = {
  diff: "+a\n+b\n+c\n+d",
  filesTouched: ["a.ts", "b.ts"],
};

describe("runEngine reconciliation", () => {
  it("round-robins default agents up to the defaultN guardrail", () => {
    const config = resolveConfig({
      defaultN: 10,
      defaultAgents: [{ id: "A", kind: "claude-cli" }],
    });
    const agents = selectAgents({ instructions: "do it", repoPath: "/repo" }, config);
    expect(agents).toHaveLength(10);
    expect(agents.map((a) => a.id)).toEqual([
      "A",
      "A-2",
      "A-3",
      "A-4",
      "A-5",
      "A-6",
      "A-7",
      "A-8",
      "A-9",
      "A-10",
    ]);
  });

  it("clamps implicit task fan-out above the guardrail", () => {
    const config = resolveConfig({
      defaultAgents: [{ id: "A", kind: "claude-cli" }],
    });
    const agents = selectAgents({ instructions: "do it", repoPath: "/repo", n: 99 }, config);
    expect(agents).toHaveLength(10);
  });

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

describe("runEngine synthesis stage", () => {
  const TWO: AgentSpec[] = [
    { id: "A", kind: "claude-cli" },
    { id: "B", kind: "codex-cli" },
  ];
  const SYNTH: DiffEntry = { diff: "+x\n+y", filesTouched: ["a.ts", "b.ts"] }; // 2 Δlines

  it("does not run synthesis when synthesisMode is off", async () => {
    const { deps, task, created } = scenario({
      agents: TWO,
      diffs: { A: BIG, B: SMALL },
      oracle: { A: true, B: true },
      commands: { test: "pnpm test" },
      config: { synthesisMode: "off" },
    });
    const r = await runEngine(task, deps);
    expect(r.synthesis).toBeUndefined();
    expect(r.candidates.map((c) => c.agentId)).toEqual(["A", "B"]);
    expect(created.some((c) => c.agentId === "synthesis-1")).toBe(false);
  });

  it("prefers a passing synthesis even when a smaller child also passed", async () => {
    const { deps, task, created, applied } = scenario({
      agents: TWO,
      diffs: { A: BIG, B: SMALL, "synthesis-1": SYNTH },
      oracle: { A: true, B: true, "synthesis-1": true },
      commands: { test: "pnpm test" },
      config: { synthesisMode: "passing-only" },
    });
    const r = await runEngine(task, deps);
    expect(r.decision).toBe("synthesis");
    expect(r.recommended?.agentId).toBe("synthesis-1");
    expect(r.recommended?.synthesis).toBe(true);
    expect(r.synthesis?.attempted).toBe(true);
    expect(r.synthesis?.recommended).toBe(true);
    expect(r.synthesis?.inputs).toEqual(["A", "B"]);
    // synthesis candidate + oracle are in the result arrays (single source of truth)
    expect(r.candidates.map((c) => c.agentId)).toContain("synthesis-1");
    expect(r.oracle.map((o) => o.agentId)).toContain("synthesis-1");
    // worktree created from the SAME base sha as the children, and seeded from the smallest passer (B)
    const synthCreate = created.find((c) => c.agentId === "synthesis-1");
    expect(synthCreate?.baseSha).toBe("abc123");
    expect(r.synthesis?.seededFrom).toBe("B");
    expect(applied).toContainEqual({ path: "synthesis-1", diff: SMALL.diff });
  });

  it("falls back to the best original when the synthesis is over-broad", async () => {
    const HUGE: DiffEntry = {
      diff: Array.from({ length: 30 }, (_, i) => `+l${i}`).join("\n"),
      filesTouched: ["a.ts"],
    };
    const { deps, task } = scenario({
      agents: TWO,
      diffs: { A: BIG, B: SMALL, "synthesis-1": HUGE },
      oracle: { A: true, B: true, "synthesis-1": true },
      commands: { test: "pnpm test" },
      config: { synthesisMode: "passing-only" },
    });
    const events: EngineEvent[] = [];
    const r = await runEngine(task, deps, (e) => events.push(e));
    expect(r.decision).toBe("judge");
    expect(r.recommended?.agentId).toBe("B"); // smallest passing child
    expect(r.synthesis?.passed).toBe(true);
    expect(r.synthesis?.recommended).toBe(false);
    expect(r.synthesis?.fallbackReason).toContain("exceeded");
    // The reconcile event reports the ORIGINAL survivor pool (2), not 3 — the synthesis candidate
    // is surfaced separately and must not inflate the count next to a "judge" decision.
    const rec = events.find((e) => e.type === "reconcile");
    expect(rec?.type === "reconcile" ? rec.survivors : -1).toBe(2);
  });

  it("falls back when the synthesis fails the oracle", async () => {
    const { deps, task } = scenario({
      agents: TWO,
      diffs: { A: BIG, B: SMALL, "synthesis-1": SYNTH },
      oracle: { A: true, B: true, "synthesis-1": false },
      commands: { test: "pnpm test" },
      config: { synthesisMode: "passing-only" },
    });
    const r = await runEngine(task, deps);
    expect(r.decision).toBe("judge");
    expect(r.recommended?.agentId).toBe("B");
    expect(r.synthesis?.fallbackReason).toContain("failed the oracle");
  });

  it("falls back and still cleans up the synthesis worktree when the synthesizer throws", async () => {
    const { deps, task, cleaned } = scenario({
      agents: TWO,
      diffs: { A: BIG, B: SMALL },
      oracle: { A: true, B: true },
      commands: { test: "pnpm test" },
      config: { synthesisMode: "passing-only" },
      throwOn: ["synthesis-1"],
    });
    const r = await runEngine(task, deps);
    expect(r.recommended?.agentId).toBe("B");
    expect(r.synthesis?.recommended).toBe(false);
    expect(r.synthesis?.fallbackReason).toContain("no usable change");
    // registered-before-spawn means the finally reaps it even on a throw
    expect(cleaned).toContain("synthesis-1");
    expect(cleaned).toEqual(expect.arrayContaining(["A", "B", "synthesis-1"]));
  });

  it("skips synthesis with fewer than two passing candidates", async () => {
    const { deps, task, created } = scenario({
      agents: TWO,
      diffs: { A: SMALL, B: BIG },
      oracle: { A: true, B: false },
      commands: { test: "pnpm test" },
      config: { synthesisMode: "passing-only" },
    });
    const r = await runEngine(task, deps);
    expect(r.decision).toBe("tests");
    expect(r.recommended?.agentId).toBe("A");
    expect(r.synthesis?.attempted).toBe(false);
    expect(r.synthesis?.skippedReason).toContain("1 candidate");
    expect(created.some((c) => c.agentId === "synthesis-1")).toBe(false);
  });

  it("skips synthesis when there is no oracle", async () => {
    const { deps, task } = scenario({
      agents: TWO,
      diffs: { A: BIG, B: SMALL },
      commands: {}, // no oracle
      config: { synthesisMode: "passing-only" },
    });
    const r = await runEngine(task, deps);
    expect(r.decision).toBe("no-oracle");
    expect(r.synthesis?.attempted).toBe(false);
    expect(r.synthesis?.skippedReason).toContain("oracle");
  });

  it("skips synthesis when the run was already aborted", async () => {
    const { deps, task, created } = scenario({
      agents: TWO,
      diffs: { A: BIG, B: SMALL },
      oracle: { A: true, B: true },
      commands: { test: "pnpm test" },
      config: { synthesisMode: "passing-only" },
      aborted: true,
    });
    const r = await runEngine(task, deps);
    expect(r.synthesis?.attempted).toBe(false);
    expect(r.synthesis?.skippedReason).toContain("aborted");
    expect(created.some((c) => c.agentId === "synthesis-1")).toBe(false);
  });

  it("counts synthesis spend exactly once in the cost note", async () => {
    const { deps, task } = scenario({
      agents: TWO,
      diffs: { A: SMALL, B: SMALL, "synthesis-1": SMALL },
      oracle: { A: true, B: true, "synthesis-1": true },
      commands: { test: "pnpm test" },
      config: { synthesisMode: "passing-only" },
      outputs: {
        A: { status: "succeeded", costUsd: 0.5 },
        B: { status: "succeeded", costUsd: 0.5 },
        "synthesis-1": { status: "succeeded", costUsd: 1.0 },
      },
    });
    const r = await runEngine(task, deps);
    expect(r.recommended?.agentId).toBe("synthesis-1");
    expect(r.costNote).toContain("$2.000");
    expect(r.costNote).toContain("3 agent(s)");
  });

  it("runs the synthesizer at the same depth as children (no recursion level added)", async () => {
    // The synthesizer is dispatched via the same runAgent path as children; the engine adds no
    // nesting. This guards that synthesis is a sibling, not a child-of-a-child.
    const seen: string[] = [];
    const { deps, task } = scenario({
      agents: TWO,
      diffs: { A: SMALL, B: SMALL, "synthesis-1": SMALL },
      oracle: { A: true, B: true, "synthesis-1": true },
      commands: { test: "pnpm test" },
      config: { synthesisMode: "passing-only" },
    });
    const inner = deps.runAgent;
    deps.runAgent = async (spec, ctx) => {
      seen.push(spec.id);
      return inner(spec, ctx);
    };
    await runEngine(task, deps);
    expect(seen).toEqual(["A", "B", "synthesis-1"]); // one flat tier of dispatch
  });
});
