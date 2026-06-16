# MCP worktree mode

MCP worktree mode (`apps/mcp`, `@frites/mcp`) is frites's **Stance B** surface: an on-demand MCP tool that runs N competing full implementations as real agents in isolated git worktrees, filters them through the repo's test suite as the ground-truth oracle, and recommends one vetted diff. It exposes two tools over stdio: `frites_implement` and `frites_apply`.

Impersonation is the wrong fit here: returning N candidate diffs plus a comparison and running minutes-long worktree agents needs a tool call, not a single model turn. So the heavy multi-agent file-edit work lives on the MCP surface rather than the gateway.

## MCP transport and host quirks

The tools run over stdio. Several MCP host behaviors are load-bearing and were verified against the real hosts:

- **Progress notifications are display-only. They do NOT extend either host's deadline.** Size timeouts to worst-case wall-clock up front.
- **Claude Code:** set the per-tool `timeout` to `600000` and `alwaysLoad: true` so the tool isn't hidden behind Tool Search. It renders `notifications/progress` inline.
- **Codex:** `tool_timeout_sec` defaults to **60s and MUST be raised to 600** or every run dies.
- **Result size:** Claude warns at ~10k tokens and hard-caps at ~25k. Return compact `structuredContent` plus a `resource_link` to each diff, never inline N full diffs.
- **No MCP `sampling` for the judge:** Claude Code doesn't implement a sampling client and Codex explicitly refused to. frites calls models with its own credentials instead.

## Worktree execution

When the host calls `frites_implement {task, repoPath, n?, agents?}`, the engine:

1. Selects N agents from the task or config and resolves the base commit.
2. Creates one isolated git worktree per agent (managed by `@frites/isolation`).
3. Spawns detached headless children that edit in their own worktree concurrently, each launched with an allowlist env built by the `EnvSandbox` (auth kept, base-URLs scrubbed, `FRITES_DEPTH` incremented).
4. Streams `notifications/progress` ("agent 2 editing app.ts / running tests") as the children work.

The worktree lifecycle, diff capture, and cleanup are documented in [Isolation](isolation.md).

## Candidate diffs and oracle filtering

Each child's work is captured as a candidate diff (`git diff --staged`). The engine then runs the configured or auto-detected oracle commands (build, lint, test) against each candidate and reconciles them into one recommendation:

- Candidates that errored, timed out, were empty, or touched no files are ignored.
- If oracle commands exist, only candidates whose oracle passed are kept; the closest near-miss is surfaced if none pass.
- One passing candidate is recommended directly; multiple passing candidates are tie-broken by the deterministic smallest-blast-radius `heuristicJudge` (fewest changed lines, then fewest files).

An optional, on-by-default synthesis stage can integrate the passing candidates' deltas into one re-validated candidate. The full reconciliation and synthesis algorithm is canonical in [Synthesis & reconciliation](../concepts/synthesis-and-reconciliation.md), and the oracle mechanics are detailed in [Worktree oracle](../concepts/worktree-oracle.md).

## Apply flow

The MCP path lands changes only via an explicit, gated apply. It never auto-merges or pushes:

1. `frites_implement` returns `structuredContent` plus `resource_link`s to each candidate diff. The caller persists diffs and run metadata for review.
2. The user reviews the recommended diff and the per-candidate comparison.
3. `frites_apply {runId}` lands the diff on a fresh branch: `git switch -c frites/<runId> && git apply --3way`. It accepts a `candidateId` so a reviewer can land a tighter passing child instead of the recommended candidate.

This explicit apply is the one mandatory human gate. The permission posture for worktree children (bypassed permissions for Claude, `-s workspace-write` with approvals disabled for Codex) is canonical in the [Safety model](../product/safety-model.md).

## Related pages

- [Isolation](isolation.md): worktree lifecycle, diff capture, apply-to-branch.
- [Worktree oracle](../concepts/worktree-oracle.md): the test/build/lint oracle.
- [MCP tools](../reference/mcp-tools.md): the `frites_implement` / `frites_apply` tool reference.
- [Core engine](core-engine.md): the shared engine state machine.
- [Data flow](data-flow.md): the end-to-end worktree sequence.
