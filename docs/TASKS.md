# frites Tasks

## Current task: benchmark oracle-gated worktree synthesis

Add a benchmark path that exercises the worktree engine's `synthesisMode:
"passing-only"` flow for multi-child agent runs. The existing Aider/polyglot
matrix points a model harness at the gateway, so it measures lightweight answer
synthesis over raw child text. It does **not** measure the highest-value fusion
workflow: multiple full child implementations, oracle filtering, synthesis from
the oracle-passing candidates, re-running the same oracle against the synthesized
diff, and falling back to the best original passer when synthesis is not safe.

The new benchmark should call `runEngine`/`frites run` style worktree execution
directly instead of routing through `/v1/messages`. It should compare:

- Single-child baselines: `claude`, `codex`.
- Multi-child selection with `synthesisMode: "off"`: oracle filters candidates
  and recommends the best passing child.
- Multi-child synthesis with `synthesisMode: "passing-only"`: oracle filters
  candidates, synthesizes from multiple passers, tests the synthesized candidate,
  and recommends it only when the existing synthesis guardrails allow it.

Acceptance criteria:

- Add a new benchmark harness or matrix, e.g. `eval/worktree-matrix.ts`, that
  creates isolated git repos per case and runs the shared worktree engine.
- Configure explicit oracle commands per case; generated code execution should
  stay sandboxed, preferably by wrapping the oracle command in the existing
  benchmark Docker image.
- Record quality and fusion-specific metrics: final pass rate, original
  candidate pass count, `decision`, `synthesis.attempted`,
  `synthesis.recommended`, fallback reason, cost, and duration.
- Keep the existing Aider gateway benchmark, but document that it measures
  gateway answer fusion rather than oracle-gated worktree synthesis.
- Update `eval/README.md` with the distinction and the recommended command for
  running the new synthesis benchmark.

> **This document has moved.** Deferred and roadmap content is now part of the structured docs.
> This page is kept as a compatibility redirect so existing links keep resolving. The full original
> planning text (including the completed synthesis design record, its review refinements, test plan,
> and acceptance criteria) remains in git history.

- Deferred task index → [Deferred tasks](roadmap/deferred-tasks.md)
- Gemini provider plan → [Gemini provider](roadmap/gemini-provider.md)
- OpenAI-compatible providers plan (xAI Grok & open-source models) → [OpenAI-compatible providers](roadmap/openai-compatible-providers.md)
- Shipped synthesis design → [Synthesis & reconciliation](concepts/synthesis-and-reconciliation.md),
  [Core engine](architecture/core-engine.md), [Configuration](reference/configuration.md)
- Current status → [Current status](roadmap/current-status.md)
