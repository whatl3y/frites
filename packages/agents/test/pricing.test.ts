import type { ModelPricing } from "@distrai/core";
import { describe, expect, it } from "vitest";
import { estimateCostUsd, pricingFor } from "../src/pricing";

describe("pricingFor", () => {
  const table: Record<string, ModelPricing> = {
    "gpt-5.5": { inputPerMtok: 1.25, cachedInputPerMtok: 0.125, outputPerMtok: 10 },
    "claude-opus-4-8": { inputPerMtok: 15, outputPerMtok: 75 },
  };

  it("returns undefined with no table or no model", () => {
    expect(pricingFor("gpt-5.5", undefined)).toBeUndefined();
    expect(pricingFor(undefined, table)).toBeUndefined();
  });

  it("matches exactly", () => {
    expect(pricingFor("gpt-5.5", table)?.outputPerMtok).toBe(10);
  });

  it("matches a versioned id by prefix (key is a prefix of the model)", () => {
    expect(pricingFor("gpt-5.5-2026-01-01", table)?.outputPerMtok).toBe(10);
  });

  it("matches a bare alias when the key is the versioned id (model is a prefix of the key)", () => {
    const versioned = { "gpt-5.5-2026-01-01": { inputPerMtok: 2, outputPerMtok: 8 } };
    expect(pricingFor("gpt-5.5", versioned)?.outputPerMtok).toBe(8);
  });

  it("returns undefined when nothing matches", () => {
    expect(pricingFor("gemini-3", table)).toBeUndefined();
  });
});

describe("estimateCostUsd", () => {
  it("returns undefined without rates (estimation is opt-in)", () => {
    expect(estimateCostUsd(undefined, { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined();
  });

  it("prices codex usage: fresh input billed at base, cached subset at the cheaper rate", () => {
    // codex: inputTokens is the inclusive total (11163), cached is a subset (9600), no cache-write.
    // fresh = 11163 - 9600 = 1563 @ $1.25/M; cached 9600 @ $0.125/M; output 370 @ $10/M.
    const rates: ModelPricing = { inputPerMtok: 1.25, cachedInputPerMtok: 0.125, outputPerMtok: 10 };
    const usd = estimateCostUsd(rates, { inputTokens: 11163, cacheReadTokens: 9600, outputTokens: 370 });
    const expected = (1563 * 1.25 + 9600 * 0.125 + 370 * 10) / 1_000_000;
    expect(usd).toBeCloseTo(expected, 10);
  });

  it("prices claude-shaped usage where input is the summed total (fresh recovered correctly)", () => {
    // claude: inputTokens = fresh+read+create = 19901, read 0, create 17206 → fresh recovers to 2695.
    const rates: ModelPricing = { inputPerMtok: 15, cacheWritePerMtok: 18.75, outputPerMtok: 75 };
    const usd = estimateCostUsd(rates, {
      inputTokens: 19901,
      cacheReadTokens: 0,
      cacheCreationTokens: 17206,
      outputTokens: 7,
    });
    const expected = (2695 * 15 + 17206 * 18.75 + 7 * 75) / 1_000_000;
    expect(usd).toBeCloseTo(expected, 10);
  });

  it("falls back to the base input rate for cached/cache-write when their rates are omitted", () => {
    const rates: ModelPricing = { inputPerMtok: 2, outputPerMtok: 8 };
    const usd = estimateCostUsd(rates, { inputTokens: 1000, cacheReadTokens: 400, outputTokens: 100 });
    // fresh 600 @ 2, cached 400 @ 2 (fallback) = all 1000 input @ 2; output 100 @ 8.
    expect(usd).toBeCloseTo((1000 * 2 + 100 * 8) / 1_000_000, 10);
  });
});
