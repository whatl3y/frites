import { describe, expect, it } from "vitest";
import type { Candidate, EngineEvent, OracleResult, RunResult } from "@frites/core";
import { describeEvent, formatResultText, toStructured } from "../src/runtime";

const SYNTH_EVENTS: EngineEvent[] = [
  { type: "synthesis-skipped", reason: "only 1 candidate passed" },
  { type: "synthesis-started", inputAgents: ["claude-1", "codex-1"], seededFrom: "codex-1" },
  { type: "synthesis-progress", message: "editing files" },
  { type: "synthesis-finished", status: "succeeded", filesTouched: 3 },
  { type: "synthesis-oracle-started" },
  { type: "synthesis-oracle-finished", passed: true },
];

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

describe("describeEvent — synthesis events", () => {
  it("renders a non-empty line for every synthesis event (no silent drops)", () => {
    for (const e of SYNTH_EVENTS) {
      expect(describeEvent(e).length).toBeGreaterThan(0);
    }
  });

  it("renders the new synthesis reconcile decision", () => {
    expect(describeEvent({ type: "reconcile", decision: "synthesis", survivors: 3 })).toContain(
      "synthesis",
    );
  });
});

describe("synthesis reporting in MCP output", () => {
  const synth = cand({
    agentId: "synthesis-1",
    diff: "+x\n+y",
    filesTouched: ["a.ts", "b.ts"],
    status: "succeeded",
    synthesis: true,
    synthesizedFrom: ["claude-1", "codex-1"],
    costUsd: 1,
  });
  const result: RunResult = {
    runId: "run1",
    recommended: synth,
    candidates: [
      cand({ agentId: "claude-1", diff: "+a", filesTouched: ["a.ts"], costUsd: 0.5 }),
      cand({ agentId: "codex-1", diff: "+b", filesTouched: ["b.ts"], costUsd: 0.5 }),
      synth,
    ],
    oracle: [
      { agentId: "claude-1", passed: true, hadOracle: true } as OracleResult,
      { agentId: "codex-1", passed: true, hadOracle: true } as OracleResult,
      { agentId: "synthesis-1", passed: true, hadOracle: true } as OracleResult,
    ],
    decision: "synthesis",
    rationale: "synthesized and verified",
    costNote: "Approx total child spend: $2.000 across 3 agent(s).",
    synthesis: {
      attempted: true,
      inputs: ["claude-1", "codex-1"],
      synthesizerId: "synthesis-1",
      seededFrom: "codex-1",
      passed: true,
      recommended: true,
    },
  };

  it("toStructured exposes the synthesis block and per-candidate flag", () => {
    const s = toStructured(result) as any;
    expect(s.synthesis.recommended).toBe(true);
    expect(s.synthesis.inputs).toEqual(["claude-1", "codex-1"]);
    const row = s.candidates.find((c: any) => c.agentId === "synthesis-1");
    expect(row.synthesis).toBe(true);
    expect(row.synthesizedFrom).toEqual(["claude-1", "codex-1"]);
  });

  it("formatResultText surfaces the synthesis status line and candidateId hint", () => {
    const text = formatResultText(result);
    expect(text).toContain("synthesis-1");
    expect(text).toContain("passed the oracle and is the recommendation");
    expect(text).toContain("candidateId=");
  });

  it("formatResultText explains the fallback when synthesis was not used", () => {
    const fallback: RunResult = {
      ...result,
      recommended: result.candidates[0],
      decision: "judge",
      synthesis: {
        attempted: true,
        inputs: ["claude-1", "codex-1"],
        synthesizerId: "synthesis-1",
        passed: true,
        recommended: false,
        fallbackReason: "synthesized diff exceeded 1.5× the combined input size",
      },
    };
    const text = formatResultText(fallback);
    expect(text).toContain("not used");
    expect(text).toContain("exceeded");
  });
});
