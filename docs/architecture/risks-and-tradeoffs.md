# Risks & tradeoffs

frites trades latency and metered spend for output quality. This page is the canonical home for that tradeoff, the top risks, the cost and latency model, hardening gaps, and the transport tradeoffs.

## The core tradeoff: better output, slower

frites's whole premise is *reconciliation quality*: many independent attempts, filtered by execution rather than vibes. The value is the selector, not the fan-out. That quality is not free:

- **The council costs latency and spend.** Fanning out to N children multiplies metered usage and runs multiple full agents instead of one. On the gateway, an LLM synthesizer then adjudicates their outputs; on the worktree path, every candidate runs the full build/lint/test oracle and an optional synthesis stage runs a further agent. Each stage adds wall-clock time.
- **The worktree result is verified, not just adjudicated.** In exchange for that cost, the MCP/worktree path returns a candidate that actually passed the repo's test suite as a ground-truth oracle. It is verified, not merely the most persuasive answer. The gateway answer/action path is lighter: it improves answer/action quality through independent proposals and synthesis, then relies on the host tool loop to execute and validate selected actions.

The two surfaces sit at different points on this curve by design: the gateway keeps everyday interaction friction low, while the worktree path spends more for stronger verification when you want competing full implementations reviewed before applying a diff. `fanOutPolicy`, `fanOutScope`, and `synthesisMode` are the levers that bound where you pay the cost.

## Top risks

1. **Reconciliation quality / verifier gap (HIGH).** Fan-out raises the ceiling; a weak selector recovers little of it. Mitigation: the tests-as-oracle spine; the LLM judge only tie-breaks survivors; honesty in the UX when no tests discriminate (a "vibes pick", surfaced as the `no-oracle` decision). Fan-out is gated behind a measured win (see the value gate below).
2. **Cost is metered, not free (HIGH).** Headless Claude burns the Agent-SDK credit then the API key; agents run roughly 4× chat tokens. Mitigation: tests-as-judge, single-survivor short-circuit, complexity-gated N, ≤1 feedback round, `--max-budget-usd`, and cost telemetry from P1.
3. **Multi-minute latency UX (HIGH).** Mitigation: size host timeouts to worst-case (Codex defaults to a 60s wall-clock and must be raised), stream rich progress, and run children truly concurrently.
4. **Full-auto safety (HIGH).** Children run headless without interactive approval. See the canonical [safety model](../product/safety-model.md).
5. **Context propagation (MED).** Isolation-cleaned children lack the project `CLAUDE.md`; curated context is forwarded in the prompt instead.
6. **Worktree / .git contention (MED).** The pnpm shared store amortizes installs; cleanup uses `worktree remove --force` + `prune` even on crash; `node_modules`/`dist` are excluded from diffs.

## Cost model

Spend is metered either way, because billing is decided by the invocation surface, not client identity (see [auth and billing](../product/auth-and-billing.md)). Controls:

- `fanOutPolicy` (`always` | `auto` | `necessary` | `never`) decides *whether* a turn fans out; `auto` uses a cheap classifier and short-circuits trivial prompts.
- `fanOutScope` (`first-turn` | `per-turn`) bounds *which* turns of a request fan out, so a task that takes N tool round-trips pays for one council, not N.
- Per-child `perChildBudgetUsd` / `--max-budget-usd` caps (claude-enforced) and `synthesisBudgetUsd` for the synthesis stage.
- Per-turn cost telemetry plus a closing council recap make spend visible; codex's footprint is estimated from the configured `pricing` table because the ChatGPT backend reports no cost. See [cost telemetry](../concepts/cost-telemetry.md).

## Latency model

- Children run concurrently, so a council's wall-clock is bounded by the slowest child, not their sum.
- Timeouts are idle (reset on output) so an actively-working child is not killed mid-flight, with an optional hard ceiling as a backstop; the synthesis stage ships a concrete 30-minute hard ceiling because it is a serialized tail step.
- Host deadlines do not extend on progress notifications, so MCP timeouts must be sized to worst-case wall-clock up front (Claude `timeout` `600000`; Codex `tool_timeout_sec` raised from 60 to 600).

## The value gate

Fan-out plus oracle must beat single-agent first-review-accept rate at acceptable cost, measured on roughly 10 real tickets. If it fails, the thin slice is the product. The value gate result is still open work: whether fan-out quality beats a single agent on real tickets has not been measured yet.

## Hardening gaps

frites is a high-trust local automation tool with known, documented gaps:

- No strong OS/container sandbox wraps Claude children yet.
- Secret deny-read rules for paths such as `~/.ssh`, `~/.aws`, and `.env` are planned but not enforced.
- There is no prompt-preserving child mode; child agents can inspect and (in action/worktree paths) modify the repo without per-command approval.
- Hardened `sandbox-runtime` / container execution with default-deny egress remains planned.

These belong to the safety posture detailed canonically in [the safety model](../product/safety-model.md).

## Transport tradeoffs

frites ships two transports over one engine, each suited to a different need:

- **Transparent proxy / gateway (primary).** Lowest friction: intercepts every prompt with no "use frites" ceremony, ideal for answer/reasoning turns and host-executed coding edits, no API key. Cost: everything is metered (frites is the brain, so there is no free interactive top-level). The recursion risk of children inheriting `ANTHROPIC_BASE_URL` is handled by env-scrubbing every child.
- **MCP server / worktree mode (heavy edits).** Returning N candidate diffs and running minutes-long worktree agents needs a tool call, not a single model turn, so impersonation is the wrong fit. Stance-B worktree work lives on MCP. This is the path that yields a verified result. Result size is constrained (Claude warns ~10k tokens, hard-caps ~25k), so frites returns compact `structuredContent` + `resource_link`s, never inline N full diffs. frites also does not depend on MCP `sampling` for the judge (neither host implements a usable sampling client); models are called with frites's own credentials.

## Related

- [Safety model](../product/safety-model.md): canonical permission posture and blast-radius controls.
- [Current status](../roadmap/current-status.md): what is built, tested, and still open.
- [Core engine](core-engine.md): the reconciliation funnel.
- [Auth and billing](../product/auth-and-billing.md): why spend is metered.
