import { z } from "zod";

/** Codex reasoning depth (`model_reasoning_effort`). Higher = more analysis before acting. */
export const ReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const AgentSpecSchema = z.object({
  id: z.string(),
  kind: z.enum(["claude-cli", "codex-cli"]),
  model: z.string().optional(),
  framing: z.string().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Codex-only per-agent reasoning depth override (`model_reasoning_effort`). Falls back to
   * config.codexReasoningEffort when omitted. Ignored by claude children (claude has no such flag;
   * its depth comes from the model + the shared childDirective).
   */
  reasoningEffort: ReasoningEffortSchema.optional(),
});

/**
 * Woven into EVERY substantive child prompt (answer, action, and execute paths) so all backends —
 * not just claude — analyze and execute exhaustively. This is the provider-agnostic half of "make
 * every agent thorough": claude already reasons hard by default and codex is lifted by
 * codexReasoningEffort, but the actual marching orders ("read before answering, verify, don't stop
 * early") live here so both read from the same instruction. Background/utility turns (title-gen,
 * summarization, the fan-out judge) deliberately skip it. Set childDirective to "" to disable.
 */
export const DEFAULT_CHILD_DIRECTIVE = [
  "Work exhaustively and reason from first principles.",
  "Before you answer or change anything, read the relevant files and trace the ACTUAL execution",
  "path rather than pattern-matching to a likely cause. Consider every dimension of the problem —",
  "edge cases, failure modes, and interactions — and do not stop at the first plausible answer.",
  "When you change code, verify it: run the build and tests if they exist and confirm they pass",
  "before you finish. A shallow or partial result is not acceptable.",
].join(" ");

/** Append the shared thoroughness directive to a prompt (no-op when the directive is empty). */
export function withChildDirective(prompt: string, directive?: string): string {
  return directive && directive.trim() ? `${prompt}\n\n${directive}` : prompt;
}

/**
 * Per-model token rates ($ per MILLION tokens) used to ESTIMATE child spend when the backend
 * doesn't self-report a cost. claude-cli reports `total_cost_usd` authoritatively (so it never
 * needs this); codex against the ChatGPT backend reports no cost, so without rates its spend is
 * unknown — which made it look "free" next to claude. Rates are intentionally NOT shipped with
 * defaults (provider prices drift and aren't ours to guess); supply them per-model to opt in.
 */
export const ModelPricingSchema = z.object({
  /** Uncached (fresh) input tokens. */
  inputPerMtok: z.number().nonnegative(),
  /** Cached/reused input tokens (cache reads). Defaults to inputPerMtok when omitted. */
  cachedInputPerMtok: z.number().nonnegative().optional(),
  /** Cache-write (creation) input tokens — claude only. Defaults to inputPerMtok when omitted. */
  cacheWritePerMtok: z.number().nonnegative().optional(),
  /** Output tokens (reasoning/thinking tokens are billed here too). */
  outputPerMtok: z.number().nonnegative(),
});

export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const FritesConfigSchema = z.object({
  /** Default number of children when a task doesn't specify. Capped at 5 in v1. */
  defaultN: z.number().int().min(1).max(5).default(2),
  defaultAgents: z.array(AgentSpecSchema).default([
    {
      id: "claude-1",
      kind: "claude-cli",
      framing: "Make the smallest correct change that satisfies the task.",
    },
    {
      id: "codex-1",
      kind: "codex-cli",
      framing: "Prefer a clean, well-structured solution.",
    },
  ]),
  perChildTimeoutMs: z.number().int().positive().default(600_000),
  perChildBudgetUsd: z.number().positive().default(2),
  oracle: z
    .object({
      build: z.string().optional(),
      test: z.string().optional(),
      lint: z.string().optional(),
      /** Auto-detect commands from package.json scripts when none are given. */
      autoDetect: z.boolean().default(true),
    })
    .default({ autoDetect: true }),
  /** Recursion fuse: refuse to spawn children when FRITES_DEPTH would exceed this. */
  maxDepth: z.number().int().min(1).default(1),
  /** Per-session safety cap on agentic turns the gateway will drive before forcing a stop. */
  maxTurns: z.number().int().positive().default(60),
  /**
   * How aggressively the transparent-proxy coordinator fans out to child agents:
   * - "always": fan out on every main turn
   * - "auto" (default): coordinator decides per-prompt (heuristic; LLM-judge upgrade later)
   * - "necessary": only for clearly hard/contested prompts
   * - "never": single agent, no fan-out (cheapest)
   */
  fanOutPolicy: z.enum(["always", "auto", "necessary", "never"]).default("auto"),
  /**
   * WHICH turns within a single agentic request are allowed to fan out:
   * - "first-turn" (default): fan out only on the substantive REQUEST turn (the initial
   *   reasoning/planning), then run a SINGLE agent through the mechanical tool-loop
   *   continuation turns (the ones where the host is just feeding a tool result back). This
   *   is the big cost/latency win — a task that takes N tool round-trips no longer pays for
   *   N full councils, only the first one. Fan-out still re-engages for each new user request.
   * - "per-turn": fan out on EVERY turn the policy allows, including each tool-loop step
   *   (maximum cross-checking, maximum metered spend).
   * Continuation turns are detected from the request shape (the host feeding tool_result /
   * function_call_output back), so this needs no server-side session memory.
   */
  fanOutScope: z.enum(["first-turn", "per-turn"]).default("first-turn"),
  /**
   * Headless/metered mode: pass ANTHROPIC_API_KEY/OPENAI_API_KEY through to children.
   * Default false = subscription-first (children use the host's OAuth). Set true (or
   * env FRITES_PASS_API_KEYS=1) when running where no keychain/OAuth exists (e.g. CI).
   */
  passApiKeys: z.boolean().default(false),
  /**
   * Thoroughness directive woven into every substantive child prompt (all backends, all paths) so
   * they analyze and execute exhaustively rather than stopping at the first plausible answer. This
   * is what makes codex behave like claude on depth, not just claude. Background/utility turns
   * (title-gen, summarization, the fan-out judge) skip it. Set to "" to disable. See
   * DEFAULT_CHILD_DIRECTIVE for the shipped text.
   */
  childDirective: z.string().default(DEFAULT_CHILD_DIRECTIVE),
  /**
   * Codex children's reasoning depth, injected as `-c model_reasoning_effort="<v>"` on every codex
   * invocation (answer + execute paths). Defaults to "high" so codex reasons as hard as claude does
   * by default. A per-agent AgentSpec.reasoningEffort overrides this. (Claude has no equivalent flag
   * — its depth comes from the model plus childDirective.)
   * NOTE: "minimal" is NOT safe with the stock codex model — it 400s ("cannot be used with
   * reasoning.effort 'minimal': image_gen, web_search"). Use low/medium/high; high is the default.
   */
  codexReasoningEffort: ReasoningEffortSchema.default("high"),
  /**
   * Stream live progress back to the prompting client during long council turns — which
   * agents are being consulted, when each result arrives, and a heartbeat — so it's obvious
   * work is happening and nothing is stuck. Surfaced on an ephemeral "thinking"/reasoning
   * channel that never pollutes the answer or the next turn's transcript. Default on.
   */
  streamProgress: z.boolean().default(true),
  /**
   * How much per-child detail rides the progress channel during fan-out:
   * - "telemetry" (default): per-agent STATE + live token/elapsed/cost counters and completion
   *   summaries, but NOT each child's answer text. Tight, readable panel.
   * - "interleaved": everything telemetry shows PLUS each child's actual output streamed live,
   *   line-buffered and agent-prefixed (e.g. `[2] …`). Maximum transparency; the panel can get
   *   long. The env var FRITES_PROGRESS_DETAIL overrides this when set.
   * Either way the FINAL synthesized answer streams live into the answer block as it's produced
   * (so nothing waits to be fully consumed before rendering). Only meaningful when streamProgress
   * is on and the request is streaming.
   */
  progressDetail: z.enum(["telemetry", "interleaved"]).default("telemetry"),
  /**
   * Gateway log verbosity: debug | info | warn | error. The env var FRITES_LOG_LEVEL
   * overrides this when set. Tail the logs with `frites logs -f`.
   */
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /**
   * Optional per-model token rates, keyed by model id (e.g. "gpt-5.5"), used to estimate a
   * child's spend when its backend reports none — so the per-agent telemetry line shows a
   * comparable cost for every agent instead of leaving codex looking free. Lookup is exact-match
   * first, then a prefix match (so "gpt-5.5" covers "gpt-5.5-2026-…"). Omit to disable estimation.
   */
  pricing: z.record(z.string(), ModelPricingSchema).optional(),
});

export type FritesConfig = z.infer<typeof FritesConfigSchema>;

export function resolveConfig(partial?: unknown): FritesConfig {
  return FritesConfigSchema.parse(partial ?? {});
}
