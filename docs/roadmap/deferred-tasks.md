# Deferred tasks

This page is the index of implementation plans that are intentionally not part of the current committed scope but are detailed enough to pick up later, alongside notable tasks that have since been completed.

## Planned (not implemented)

| Task | Status | Detail |
|---|---|---|
| Gemini provider support | Planned, not implemented | Add Gemini children alongside Claude and Codex, API-first then a later CLI spike. See [Gemini provider](gemini-provider.md). |
| OpenAI-compatible provider support (xAI Grok & open-source models) | Planned, not implemented | One generic `openai-compatible` adapter (configurable base URL) covering xAI Grok plus self-hosted / open-source models, with `xai` as a thin preset. See [OpenAI-compatible providers](openai-compatible-providers.md). |

## Completed

| Task | Status | Notes |
|---|---|---|
| Restructure docs for GitBook sync | Done (2026-06-16) | The migration that produced this GitBook docs tree: focused, cross-linked pages under `docs/`, with `docs/SUMMARY.md` owning navigation and `docs/README.md` as the landing page. This page is itself the deferred-task index the restructure plan required once the migration was performed. |
| Synthesize a winning implementation from multiple passing child diffs | Implemented and shipped to `main` (2026-06-16) | Worktree mode folds the strongest ideas from multiple oracle-passing child diffs into one synthesized, oracle-verified candidate. `synthesisMode` defaults to `passing-only` (on); set `"off"` for winner-take-one. See [Synthesis and reconciliation](../concepts/synthesis-and-reconciliation.md) and [Worktree oracle](../concepts/worktree-oracle.md). |

For the current implementation status of shipped surfaces and the remaining work that is in active scope, see [Current status](current-status.md).
