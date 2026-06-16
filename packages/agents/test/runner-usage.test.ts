import { describe, expect, it } from "vitest";
import { claudeRunner } from "../src/claude";
import { codexRunner } from "../src/codex";
import type { RunAccumulator } from "../src/runner";

/** Drive a runner's onLine over synthetic JSONL and return the mutated accumulator. */
function feed(
  runner: { onLine: (line: string, emit: (m: string) => void, acc: RunAccumulator) => void },
  lines: object[],
): RunAccumulator {
  const acc: RunAccumulator = {};
  for (const obj of lines) runner.onLine(JSON.stringify(obj), () => {}, acc);
  return acc;
}

describe("codexRunner.onLine usage (engine path)", () => {
  it("folds reasoning_output_tokens into outputTokens (so codex isn't reported as zero-token)", () => {
    const acc = feed(codexRunner, [
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 11224,
          cached_input_tokens: 9600,
          output_tokens: 20,
          reasoning_output_tokens: 13,
        },
      },
    ]);
    expect(acc.inputTokens).toBe(11224);
    expect(acc.cacheReadTokens).toBe(9600);
    expect(acc.outputTokens).toBe(33); // 20 visible + 13 reasoning — the whole point of the fix
    expect(acc.costUsd).toBeUndefined(); // ChatGPT backend reports no cost_usd
  });

  it("captures cost_usd when the backend reports it (API-key path)", () => {
    const acc = feed(codexRunner, [
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.0123 } },
    ]);
    expect(acc.outputTokens).toBe(50);
    expect(acc.costUsd).toBe(0.0123);
  });
});

describe("claudeRunner.onLine usage (engine path)", () => {
  it("sums the disjoint input categories and captures output + cost from the result event", () => {
    const acc = feed(claudeRunner, [
      { type: "system", subtype: "init" },
      {
        type: "result",
        result: "done",
        total_cost_usd: 0.186,
        usage: {
          input_tokens: 2695,
          cache_creation_input_tokens: 17206,
          cache_read_input_tokens: 0,
          output_tokens: 7,
        },
      },
    ]);
    expect(acc.inputTokens).toBe(2695 + 17206); // disjoint categories summed
    expect(acc.cacheCreationTokens).toBe(17206);
    expect(acc.cacheReadTokens).toBe(0);
    expect(acc.outputTokens).toBe(7);
    expect(acc.costUsd).toBe(0.186);
    expect(acc.summary).toBe("done");
  });
});
