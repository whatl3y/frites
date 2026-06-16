import { describe, expect, it } from "vitest";
import {
  type AgentSpec,
  type Candidate,
  type OracleResult,
  type SynthesisStageResult,
  type Task,
  applySynthesisPreference,
  buildSynthesisPrompt,
  evaluateSynthesisEligibility,
  reservedSynthesisId,
  resolveConfig,
  selectSynthesizer,
} from "@frites/core";

function cand(over: Partial<Candidate> & { agentId: string }): Candidate {
  return {
    kind: "claude-cli",
    worktreePath: over.agentId,
    branch: `b/${over.agentId}`,
    diff: "",
    filesTouched: [],
    status: "succeeded",
    ...over,
  };
}

const A = cand({ agentId: "A", diff: "+a\n+b", filesTouched: ["a.ts"] }); // 2 Δlines
const B = cand({ agentId: "B", diff: "+c", filesTouched: ["b.ts"] }); // 1 Δline
const PASS: OracleResult[] = [
  { agentId: "A", passed: true, hadOracle: true },
  { agentId: "B", passed: true, hadOracle: true },
];

describe("evaluateSynthesisEligibility", () => {
  it("is ineligible when synthesis is off", () => {
    const r = evaluateSynthesisEligibility(
      [A, B],
      PASS,
      resolveConfig({ synthesisMode: "off" }),
      true,
    );
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("off");
  });

  it("is ineligible without an oracle", () => {
    const cfg = resolveConfig({ synthesisMode: "passing-only" });
    const r = evaluateSynthesisEligibility([A, B], PASS, cfg, false);
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("oracle");
  });

  it("is ineligible with fewer than min passing candidates", () => {
    const cfg = resolveConfig({ synthesisMode: "passing-only" });
    const oneFail: OracleResult[] = [
      { agentId: "A", passed: true, hadOracle: true },
      { agentId: "B", passed: false, hadOracle: true },
    ];
    const r = evaluateSynthesisEligibility([A, B], oneFail, cfg, true);
    expect(r.eligible).toBe(false);
    expect(r.passing.map((c) => c.agentId)).toEqual(["A"]);
  });

  it("is eligible with two passing candidates and excludes failed/empty ones", () => {
    const cfg = resolveConfig({ synthesisMode: "passing-only" });
    const empty = cand({ agentId: "C", status: "empty" });
    const r = evaluateSynthesisEligibility([A, B, empty], PASS, cfg, true);
    expect(r.eligible).toBe(true);
    expect(r.passing.map((c) => c.agentId)).toEqual(["A", "B"]);
  });
});

describe("reservedSynthesisId", () => {
  it("avoids collisions with taken ids", () => {
    expect(reservedSynthesisId(["A", "B"])).toBe("synthesis-1");
    expect(reservedSynthesisId(["synthesis-1", "A"])).toBe("synthesis-2");
    expect(reservedSynthesisId(["synthesis-1", "synthesis-2"])).toBe("synthesis-3");
  });
});

describe("selectSynthesizer", () => {
  const agents: AgentSpec[] = [
    { id: "codex-1", kind: "codex-cli" },
    { id: "claude-1", kind: "claude-cli" },
  ];

  it("prefers a claude child and maps synthesis budget/timeout onto the spec", () => {
    const cfg = resolveConfig({ synthesisMode: "passing-only", synthesisBudgetUsd: 5 });
    const spec = selectSynthesizer(agents, cfg, "synthesis-1");
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe("claude-cli"); // claude preferred so --max-budget-usd is honored
    expect(spec!.id).toBe("synthesis-1");
    expect(spec!.framing).toBeUndefined();
    expect(spec!.maxBudgetUsd).toBe(5);
    expect(spec!.hardTimeoutMs).toBe(1_800_000); // concrete wall-clock default, not off
  });

  it("uses config.synthesisAgent when provided", () => {
    const cfg = resolveConfig({
      synthesisMode: "passing-only",
      synthesisAgent: { id: "x", kind: "codex-cli", model: "gpt-5.5" },
    });
    const spec = selectSynthesizer(agents, cfg, "synthesis-1");
    expect(spec!.kind).toBe("codex-cli");
    expect(spec!.model).toBe("gpt-5.5");
  });

  it("falls back to the first agent when no claude child exists", () => {
    const cfg = resolveConfig({ synthesisMode: "passing-only" });
    const spec = selectSynthesizer([{ id: "codex-1", kind: "codex-cli" }], cfg, "synthesis-1");
    expect(spec!.kind).toBe("codex-cli");
  });
});

describe("buildSynthesisPrompt", () => {
  const task: Task = {
    instructions: "Add a retry helper",
    repoPath: "/repo",
    acceptanceCriteria: "must retry 3 times",
  };
  const base = { ref: "HEAD", sha: "abcdef1234" };

  it("includes task, acceptance criteria, base, candidate diffs, and seed framing", () => {
    const cfg = resolveConfig({ synthesisMode: "passing-only" });
    const prompt = buildSynthesisPrompt({
      task,
      base,
      passing: [A, B],
      seedId: "B",
      worktreePaths: new Map([
        ["A", "/repo/.frites/worktrees/r/A"],
        ["B", "/repo/.frites/worktrees/r/B"],
      ]),
      config: cfg,
    });
    expect(prompt).toContain("Add a retry helper");
    expect(prompt).toContain("must retry 3 times");
    expect(prompt).toContain("abcdef1"); // short base sha
    expect(prompt).toContain('"B"'); // seed framing names the seed
    expect(prompt).toContain("+a\n+b"); // the non-seed candidate A's diff is embedded
    expect(prompt).not.toContain("+c\n```"); // the seed (B) diff is NOT re-embedded
    expect(prompt).toContain("/repo/.frites/worktrees/r/A"); // read-only ref path for non-seed
    expect(prompt).toContain("Do NOT blindly concatenate");
  });

  it("omits a too-large diff but keeps its file list and path", () => {
    const cfg = resolveConfig({ synthesisMode: "passing-only", synthesisMaxDiffChars: 5 });
    const big = cand({
      agentId: "BIG",
      diff: "+" + "x".repeat(100),
      filesTouched: ["big.ts"],
    });
    const prompt = buildSynthesisPrompt({
      task,
      base,
      passing: [big, B],
      seedId: "B",
      worktreePaths: new Map([["BIG", "/wt/BIG"]]),
      config: cfg,
    });
    expect(prompt).toContain("diff omitted");
    expect(prompt).toContain("big.ts");
    expect(prompt).toContain("/wt/BIG");
  });
});

describe("applySynthesisPreference", () => {
  const cfg = resolveConfig({ synthesisMode: "passing-only" }); // maxBlastFactor 1.5
  const judgeBase = {
    recommended: B,
    decision: "judge" as const,
    rationale: "smallest blast radius",
  };

  function stage(over: Partial<SynthesisStageResult>): SynthesisStageResult {
    return {
      info: { attempted: true, inputs: ["A", "B"], synthesizerId: "synthesis-1" },
      ...over,
    };
  }

  it("passes the base decision through when synthesis is disabled", () => {
    const r = applySynthesisPreference(judgeBase, undefined, [A, B], cfg);
    expect(r.decision).toBe("judge");
    expect(r.info).toBeUndefined();
  });

  it("prefers a passing synthesis even when a smaller child also passed", () => {
    const synth = cand({
      agentId: "synthesis-1",
      diff: "+x\n+y", // 2 Δlines; within 1.5 × (2+1)=4.5
      filesTouched: ["a.ts", "b.ts"],
      synthesis: true,
    });
    const r = applySynthesisPreference(
      judgeBase,
      stage({ candidate: synth, oracle: { agentId: "synthesis-1", passed: true, hadOracle: true } }),
      [A, B],
      cfg,
    );
    expect(r.decision).toBe("synthesis");
    expect(r.recommended?.agentId).toBe("synthesis-1");
    expect(r.info?.recommended).toBe(true);
    expect(r.info?.passed).toBe(true);
  });

  it("falls back to the best original when the synthesis is over-broad", () => {
    const huge = cand({
      agentId: "synthesis-1",
      diff: Array.from({ length: 20 }, (_, i) => `+l${i}`).join("\n"), // 20 Δlines > 1.5×3
      filesTouched: ["a.ts"],
      synthesis: true,
    });
    const r = applySynthesisPreference(
      judgeBase,
      stage({ candidate: huge, oracle: { agentId: "synthesis-1", passed: true, hadOracle: true } }),
      [A, B],
      cfg,
    );
    expect(r.decision).toBe("judge");
    expect(r.recommended?.agentId).toBe("B");
    expect(r.info?.passed).toBe(true);
    expect(r.info?.recommended).toBe(false);
    expect(r.info?.fallbackReason).toContain("exceeded");
  });

  it("falls back when the synthesis fails the oracle", () => {
    const synth = cand({ agentId: "synthesis-1", diff: "+x", filesTouched: ["a.ts"], synthesis: true });
    const r = applySynthesisPreference(
      judgeBase,
      stage({ candidate: synth, oracle: { agentId: "synthesis-1", passed: false, hadOracle: true } }),
      [A, B],
      cfg,
    );
    expect(r.decision).toBe("judge");
    expect(r.recommended?.agentId).toBe("B");
    expect(r.info?.fallbackReason).toContain("failed the oracle");
  });

  it("falls back when the synthesis produced no usable change", () => {
    const empty = cand({ agentId: "synthesis-1", status: "errored", synthesis: true });
    const r = applySynthesisPreference(judgeBase, stage({ candidate: empty }), [A, B], cfg);
    expect(r.decision).toBe("judge");
    expect(r.info?.fallbackReason).toContain("no usable change");
  });

  // Inputs whose diffs touch files but have zero COUNTED lines (rename/binary/mode-only) — diffSize
  // is 0. The blast-radius guard must still fire (no sumSizes>0 bypass) for a non-empty synthesis.
  const zeroA = cand({ agentId: "ZA", diff: "--- a/a.ts\n+++ b/a.ts", filesTouched: ["a.ts"] });
  const zeroB = cand({ agentId: "ZB", diff: "--- a/b.ts\n+++ b/b.ts", filesTouched: ["b.ts"] });
  const zeroBase = { recommended: zeroA, decision: "judge" as const, rationale: "" };

  it("does not bypass the blast-radius guard when inputs have zero counted diff size", () => {
    const big = cand({
      agentId: "synthesis-1",
      diff: "+x\n+y\n+z",
      filesTouched: ["a.ts"],
      synthesis: true,
    });
    const r = applySynthesisPreference(
      zeroBase,
      stage({ candidate: big, oracle: { agentId: "synthesis-1", passed: true, hadOracle: true } }),
      [zeroA, zeroB],
      cfg,
    );
    expect(r.decision).toBe("judge"); // guard fired even though sumSizes === 0
    expect(r.info?.recommended).toBe(false);
    expect(r.info?.fallbackReason).toContain("exceeded");
  });

  it("still prefers a zero-line synthesis when the inputs are also zero-line", () => {
    const zeroSynth = cand({
      agentId: "synthesis-1",
      diff: "--- a/c.ts\n+++ b/c.ts",
      filesTouched: ["c.ts"],
      synthesis: true,
    });
    const r = applySynthesisPreference(
      zeroBase,
      stage({ candidate: zeroSynth, oracle: { agentId: "synthesis-1", passed: true, hadOracle: true } }),
      [zeroA, zeroB],
      cfg,
    );
    expect(r.decision).toBe("synthesis"); // 0 <= 1.5 × 0 → allowed
  });
});
