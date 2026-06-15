import { describe, expect, it } from "vitest";
import {
  decideFanOut,
  llmJudgeFanOut,
  resolveConfig,
  runAnswerCouncil,
} from "@distrai/core";

describe("decideFanOut", () => {
  it("respects never/always", () => {
    expect(decideFanOut("anything", resolveConfig({ fanOutPolicy: "never" })).fanOut).toBe(false);
    expect(decideFanOut("hi", resolveConfig({ fanOutPolicy: "always" })).fanOut).toBe(true);
  });

  it("auto: single agent for trivial, fan out for substantive/hard prompts", () => {
    const auto = resolveConfig({ fanOutPolicy: "auto" });
    expect(decideFanOut("hi", auto).fanOut).toBe(false);
    expect(
      decideFanOut(
        "why is the sky blue and how does rayleigh scattering explain it",
        auto,
      ).fanOut,
    ).toBe(true);
  });

  it("necessary: only clearly substantial prompts", () => {
    const nec = resolveConfig({ fanOutPolicy: "necessary" });
    expect(decideFanOut("what time is it", nec).fanOut).toBe(false);
    expect(decideFanOut("compare the tradeoffs of these two designs", nec).fanOut).toBe(true);
  });
});

describe("llmJudgeFanOut", () => {
  const cfg = resolveConfig({ defaultN: 3 });
  it("maps the model verdict to a decision", async () => {
    expect((await llmJudgeFanOut("q", async () => "fan-out", cfg)).fanOut).toBe(true);
    expect((await llmJudgeFanOut("q", async () => "single", cfg)).fanOut).toBe(false);
  });
  it("falls back to the heuristic if the judge call throws", async () => {
    const r = await llmJudgeFanOut(
      "q",
      async () => {
        throw new Error("judge down");
      },
      resolveConfig({ fanOutPolicy: "always" }),
    );
    expect(r.fanOut).toBe(true); // heuristic 'always'
  });
});

describe("runAnswerCouncil", () => {
  it("fans out to N children then synthesizes", async () => {
    const config = resolveConfig({
      fanOutPolicy: "always",
      defaultN: 2,
      defaultAgents: [
        { id: "a", kind: "claude-cli", framing: "f1" },
        { id: "b", kind: "codex-cli", framing: "f2" },
      ],
    });
    const seen: Array<{ role: string; index: number }> = [];
    const complete = async (
      _p: string,
      ctx: { role: "child" | "synth"; index: number },
    ) => {
      seen.push(ctx);
      return ctx.role === "synth" ? "SYNTHESIZED" : `child-${ctx.index}`;
    };
    const r = await runAnswerCouncil("question", { complete, config });
    expect(r.fannedOut).toBe(true);
    expect(r.childAnswers).toEqual(["child-0", "child-1"]);
    expect(r.answer).toBe("SYNTHESIZED");
    expect(seen.filter((c) => c.role === "child")).toHaveLength(2);
    expect(seen.filter((c) => c.role === "synth")).toHaveLength(1);
  });

  it("single agent (no synth) when policy says don't fan out", async () => {
    const config = resolveConfig({ fanOutPolicy: "never" });
    let synthCalled = false;
    const complete = async (
      _p: string,
      ctx: { role: "child" | "synth"; index: number },
    ) => {
      if (ctx.role === "synth") synthCalled = true;
      return "only-answer";
    };
    const r = await runAnswerCouncil("hi", { complete, config });
    expect(r.fannedOut).toBe(false);
    expect(r.answer).toBe("only-answer");
    expect(synthCalled).toBe(false);
  });
});
