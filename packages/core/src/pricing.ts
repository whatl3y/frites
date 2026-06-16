import type { ModelPricing } from "./config.js";

/**
 * Normalized token usage for a single child completion. `inputTokens` is the TOTAL input
 * (all categories summed), `cacheReadTokens` the cached/reused portion of it, and
 * `cacheCreationTokens` the cache-write portion (claude only). This shape is provider-agnostic:
 * claude reports the three input categories disjointly and we sum them; codex reports a single
 * total `input_tokens` (cached is a subset) which we pass through, with cache-creation = 0.
 * `outputTokens` is reasoning-inclusive on both providers (claude bills thinking in output; for
 * codex we fold its separately-reported `reasoning_output_tokens` in — see the CLI parsers).
 */
export interface UsageTokens {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
}

/**
 * Resolve the pricing entry for a model from a config table. Exact match wins; otherwise a
 * prefix match in either direction (so a "gpt-5.5" key covers "gpt-5.5-2026-…", and a fully
 * versioned key still matches a bare alias). Returns undefined when nothing fits.
 */
export function pricingFor(
  model: string | undefined,
  table?: Record<string, ModelPricing>,
): ModelPricing | undefined {
  if (!table || !model) return undefined;
  if (table[model]) return table[model];
  const key = Object.keys(table).find((k) => model.startsWith(k) || k.startsWith(model));
  return key ? table[key] : undefined;
}

/**
 * Estimate spend in USD from normalized token counts and per-Mtoken rates. Because `inputTokens`
 * is the grand total, the uncached (fresh) portion is `input − cacheRead − cacheCreation`, which
 * is billed at the base rate; reads and writes fall back to the base rate when their dedicated
 * rate is omitted. Returns undefined when no rates are supplied (estimation is opt-in).
 */
export function estimateCostUsd(
  rates: ModelPricing | undefined,
  u: UsageTokens,
): number | undefined {
  if (!rates) return undefined;
  const input = u.inputTokens ?? 0;
  const read = u.cacheReadTokens ?? 0;
  const create = u.cacheCreationTokens ?? 0;
  const fresh = Math.max(0, input - read - create);
  const output = u.outputTokens ?? 0;
  const readRate = rates.cachedInputPerMtok ?? rates.inputPerMtok;
  const createRate = rates.cacheWritePerMtok ?? rates.inputPerMtok;
  return (
    (fresh * rates.inputPerMtok +
      read * readRate +
      create * createRate +
      output * rates.outputPerMtok) /
    1_000_000
  );
}
