# Overview

frites is a coordinator that dispatches a task to **multiple full coding agents**, has each do real work, then **diffs / tests / judges** their results into one vetted answer, driven from your normal Claude Code or Codex session. The value is *reconciliation quality*: many independent attempts filtered by execution, not vibes. The moat is the selector, not the fan-out.

This page is the entry point for the architecture cluster. It covers the repo-level shape, the high-level decisions that drove it, and the layer diagram. Each subsystem has its own page linked below.

## Repository shape

frites is a TypeScript pnpm monorepo split into thin **apps** (runnable entry points) and the heavy logic in **packages** (libraries with no entry points). The deliberate goal is to keep all reconciliation logic in `packages/core` so it stays transport-agnostic and fully unit-testable with mocked runners and oracles.

```
apps/                              # runnable tools (deployables / entry points)
  gateway/     @frites/gateway    TRANSPARENT PROXY (primary surface): impersonates /v1/messages
                                   (Claude Code) + /v1/responses (Codex); intercepts every prompt,
                                   answer/action-council fan-out per fanOutPolicy + fanOutScope,
                                   SSE streaming, per-turn cost telemetry. Stance-A: synthesizes the
                                   assistant turn — emits host-executed tool_use on coding turns.
  mcp/         @frites/mcp        on-demand MCP tool surface (Stance B): frites_implement +
                                   frites_apply — heavy multi-agent file edits in worktrees → diffs
  cli/         @frites/cli        standalone `frites run` + `frites config` — same engine
packages/                          # libraries (no entry points)
  core/        @frites/core       engine (funnel) + oracle + judge + config + answer-council
  isolation/   @frites/isolation  git worktree lifecycle, diff capture, apply-to-branch
  agents/      @frites/agents      headless claude/codex runners + completions + cost estimation
                                   + EnvSandbox (recursion guard)
```

The apps stay thin: each transport adapts a wire format and streams progress, but the funnel, oracle, judge, config, and councils all live in `packages/core`.

## Two surfaces, one engine

frites ships two transports over one shared engine, for different needs:

| Surface | Stance | Best for |
|---|---|---|
| **Gateway** (transparent proxy) | Stance A: answer/action synthesizer | The frictionless everyday brain: Q&A, reasoning, and coding edits on *every* prompt, metered |
| **MCP** (worktree mode) | Stance B: agentic broker | Deliberate heavy multi-agent file edits in worktrees, filtered by tests |

The gateway is the **primary, everyday surface and is Stance A**: children are stateless completions, the host keeps its tool loop, and frites fans out per turn and synthesizes the assistant turn. On a coding turn it emits the `tool_use` the host executes (the children *decide* the action; they don't edit files). The MCP path is Stance B: children are full agents that do real file edits in isolated worktrees, and frites reconciles their work with the test suite as the ground-truth oracle.

The standalone CLI (`frites run` / `frites config`) calls the same engine for testing, CI, and power use.

## High-level decisions

- **Both stances ship.** The transparent-proxy gateway is the primary, lowest-friction surface (Stance A, verified editing real code end-to-end via host-executed `tool_use`, no API key). The MCP `frites_implement` path is Stance B, for when you want N competing full implementations filtered by tests.
- **"N-way merge" is the wrong mental model.** frites never mechanically merges N divergent edit trees. Reconciliation is LLM-mediated best-of-N selection, with the test suite as the ground-truth oracle and the judge scoped to *only* tie-break test-passing survivors. See [Synthesis & reconciliation](../concepts/synthesis-and-reconciliation.md).
- **Diversity comes from model-mix + prompt-framing, not temperature.** Neither `claude` nor `codex` exposes a temperature flag, so candidate diversity must come from mixing model families (claude × codex) and prompt framing. The default leans toward N=2 (1 claude + 1 codex).
- **Fan-out is scoped to the substantive turn.** The gateway does not fan out a full council on every mechanical tool-loop step or on background/utility traffic. See [Fan-out scope](../concepts/fan-out-scope.md).
- **Language: TypeScript, pnpm monorepo.** I/O-bound orchestration glue around finicky wire formats, where the official SDKs are TS-first.

## Engine state machine

The engine is a state machine over a funnel and holds zero CLI/MCP coupling:

```
DISPATCH → EXECUTE (N children in worktrees, concurrent)
        → ORACLE-FILTER (run repo tests/build/lint per candidate)
        → reconcile:  1 survivor → done
                      0 survivors → one grounded feedback round → re-filter;
                                    else surface best near-miss
                      ≥2 survivors → JUDGE (pairwise tie-break, prefer smaller diff)
        → optional gated SYNTHESIS (re-validated through oracle)
        → PRESENT (recommended diff + per-candidate comparison)
        → APPLY (on approval: git switch -c frites/<runId> && git apply --3way)
```

The engine internals, event model, and failure modes are documented in [Core engine](core-engine.md).

## The rest of the architecture cluster

- [Gateway](gateway.md): transparent proxy design, `/v1/messages` + `/v1/responses`, SSE, action synthesis, tool-call emission.
- [MCP worktree mode](mcp-worktree-mode.md): MCP transport quirks, worktree execution, candidate diffs, oracle filtering, apply flow.
- [Core engine](core-engine.md): engine internals, synthesis engine shape, event model, failure modes.
- [Agents & runners](agents-and-runners.md): headless claude/codex runners and completions.
- [Isolation](isolation.md): git worktree lifecycle, diff capture, apply-to-branch.
- [Data flow](data-flow.md): end-to-end request flow for both surfaces.
- [Risks & tradeoffs](risks-and-tradeoffs.md): the "better output, slower" tradeoff and the top risks.

For the safety and permission posture, see the canonical [Safety model](../product/safety-model.md). For child auth and billing, see [Auth & billing](../product/auth-and-billing.md).
