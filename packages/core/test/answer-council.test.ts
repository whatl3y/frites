import { describe, expect, it } from "vitest";
import {
  decideFanOut,
  llmJudgeFanOut,
  parseFanOutVerdict,
  resolveConfig,
  runAnswerCouncil,
  stripInjectedContext,
} from "@frites/core";

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

  it("fails CLOSED on a non-compliant reply that merely mentions 'multiple'/'yes'", async () => {
    // Regression for the prod bug: a confused judge replied in prose instead of one word, and the
    // old /fan-?out|multiple|yes/ scan tripped on the stray words → wrong (expensive) fan-out.
    const babble =
      "I don't see a user request to evaluate—just say what you'd like and yes, I can consult multiple agents.";
    const r = await llmJudgeFanOut("q", async () => babble, resolveConfig({ defaultN: 4 }));
    expect(r.fanOut).toBe(false);
    expect(r.n).toBe(1);
    expect(r.reason).toContain("unclear→single");
  });
});

describe("parseFanOutVerdict", () => {
  const cfg = resolveConfig({ defaultN: 3 });
  it("accepts a clear fan-out verdict, with formatting noise", () => {
    for (const v of ["fan-out", "fanout", "fan out", "Fan-out.", '"fan-out"', "**fan-out**"]) {
      expect(parseFanOutVerdict(v, cfg).fanOut).toBe(true);
    }
    expect(parseFanOutVerdict("fan-out", cfg).n).toBe(3);
    expect(parseFanOutVerdict("fan-out", cfg).reason).toBe("llm-judge: fan-out");
  });
  it("treats a clear 'single' verdict as no fan-out", () => {
    expect(parseFanOutVerdict("single", cfg).fanOut).toBe(false);
    expect(parseFanOutVerdict("single.", cfg).reason).toBe("llm-judge: single");
  });
  it("does NOT fan out when 'fan-out' only appears mid-sentence (not anchored)", () => {
    const v = "This looks single to me, though you could fan-out if unsure.";
    expect(parseFanOutVerdict(v, cfg).fanOut).toBe(false);
  });
  it("quotes the offending text in the reason when the verdict is unclear", () => {
    expect(parseFanOutVerdict("I cannot determine that", cfg).reason).toContain('"I cannot determine');
  });
});

describe("stripInjectedContext", () => {
  it("removes a system-reminder block but keeps the real question", () => {
    const text =
      "<system-reminder>Today's date is 2026-06-16. Lots of irrelevant context here.</system-reminder>\nWhat does this error mean?";
    expect(stripInjectedContext(text)).toBe("What does this error mean?");
  });
  it("removes multiline reminders and ide_selection, case-insensitively", () => {
    const text =
      "<IDE_SELECTION>\nconst x = 1;\n</IDE_SELECTION>\nReal ask\n<system-reminder>\nline one\nline two\n</system-reminder>";
    expect(stripInjectedContext(text)).toBe("Real ask");
  });
  it("leaves genuine user markup untouched (only known harness tags are stripped)", () => {
    const text = "How do I render <div>hello</div> in React?";
    expect(stripInjectedContext(text)).toBe(text);
  });
  it("returns empty when the turn is ALL scaffolding (caller falls back to raw)", () => {
    expect(stripInjectedContext("<system-reminder>just context</system-reminder>")).toBe("");
  });
  it("leaves no dangling delimiter for nested same-type tags", () => {
    const nested = "<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>";
    const out = stripInjectedContext(nested);
    expect(out).not.toContain("system-reminder");
    expect(out).not.toContain("<");
  });
  it("drops the delimiter of an unclosed tag but keeps following prose", () => {
    expect(stripInjectedContext("<system-reminder>noise\nReal ask")).toBe("noise\nReal ask");
  });

  it("composed gateway fallback: returns raw when stripping empties the basis", () => {
    // Mirrors `stripInjectedContext(rawBasis) || rawBasis` in the gateway.
    const raw = "<system-reminder>only scaffolding</system-reminder>";
    expect(stripInjectedContext(raw) || raw).toBe(raw);
  });

  it("integration: a trivial ask wrapped in a huge reminder decides single, not fan-out", () => {
    // The exact shape behind the prod bug: scaffolding inflates the basis past the heuristic's
    // length/newline trip wires. Stripping first lets decideFanOut see the real (trivial) ask.
    const auto = resolveConfig({ fanOutPolicy: "auto" });
    const raw = `<system-reminder>${"x ".repeat(200)}\nlots of context</system-reminder>\nhi`;
    expect(decideFanOut(raw, auto).fanOut).toBe(true); // naive: long + newlines → fans out
    expect(decideFanOut(stripInjectedContext(raw), auto).fanOut).toBe(false); // cleaned: trivial
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
