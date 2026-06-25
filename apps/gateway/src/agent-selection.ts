import type { AgentSpec } from "@frites/core";

/**
 * Candidate providers for one logical gateway call, in preference order.
 *
 * Background/utility turns (title-gen, summarization, cheap-tier subagents) pass an `override`
 * pinning a small/cheap model. They MUST stay cheap: we deliberately do NOT append the (full-price,
 * high-reasoning) default agents as failover targets. If the cheap provider is suppressed by backend
 * policy, the cheap turn simply fails rather than silently escalating to a premium council agent —
 * the cost cap (childDirective stripping) does not bound model/reasoning spend, so escalation here
 * would defeat the "stay cheap" guarantee. Normal turns fan out across the configured default agents
 * and may fail over among them.
 */
export function candidateSpecs(
  defaultAgents: AgentSpec[],
  override?: AgentSpec | null,
): AgentSpec[] {
  return override ? [override] : defaultAgents;
}

/** Round-robin starting point for a child/synth call within the candidate list. */
export function preferredIndex(
  ctx: { role: "child" | "synth"; index: number },
  agents: AgentSpec[],
): number {
  if (ctx.role === "synth") return 0;
  return agents.length ? ctx.index % agents.length : 0;
}
