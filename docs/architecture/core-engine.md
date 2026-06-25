# Core engine

The engine is the transport-agnostic heart of frites. It lives in `packages/core/src/engine.ts` (the `@frites/core` package) and holds zero CLI/MCP/git coupling, so it is fully unit-testable with mocked runners and oracle. It powers the heavy-edit worktree path behind `frites_implement` and the CLI runner; the gateway answer/action councils are a separate path (see [the gateway architecture](gateway.md)).

The engine is a state machine over a funnel:

```
DISPATCH → EXECUTE (N children in worktrees, concurrent)
        → ORACLE-FILTER (run repo tests/build/lint per candidate)
        → optional gated SYNTHESIS (re-validated through oracle)
        → RECONCILE (1 survivor → done; 0 → near-miss; ≥2 → judge tie-break)
        → PRESENT (recommended diff + per-candidate comparison)
        → APPLY (on approval, on a fresh frites/apply/<runId> branch)
```

## Engine boundaries

The engine declares its dependencies as structural interfaces in `EngineDeps`, satisfied by `@frites/isolation` and `@frites/agents` at the edges:

- `WorktreeManagerLike`: `resolveBase`, `create`, `captureDiff`, `cleanup`, and optional `applyDiffToWorktree` (see [isolation](isolation.md)).
- `RunAgentFn` (`runAgent`) spawns one child in a worktree and returns an `AgentRunOutput` (status, summary, cost, normalized token usage). See [agents and runners](agents-and-runners.md).
- `RunOracleFn` (`runOracle`) and `oracleCommands` run build/lint/test against one candidate worktree.
- `config` (`FritesConfig`), `newRunId`, and an optional external `signal` for client-disconnect cancellation.

`runEngine(task, deps, onEvent)` drives the whole funnel and returns a `RunResult`. All worktree cleanup runs in a single `finally` over the shared `handles` map, so every worktree (children and synthesis) is reaped even on a throw.

## Dispatch and selectAgents

`selectAgents(task, config)` resolves the agent roster:

- If the task supplies `agents`, they are used as-is.
- Otherwise it takes `config.defaultAgents` and round-robins to `n` specs, where `n = max(1, min(task.n ?? config.defaultN, 10))` (capped at 10). Indices past the base array get a suffixed id (e.g. `claude-1-2`).

Each agent runs concurrently via `Promise.all` over `runOneAgent`. `runOneAgent` creates the worktree, registers its handle in `handles` immediately (so cleanup always covers it), emits `agent-started`, runs the child with a prompt from `buildPrompt`, then calls `captureDiff`. A candidate is `succeeded` only when the child exited succeeded AND touched at least one file; otherwise `empty`, `errored`, or `timed-out`.

`buildPrompt` assembles the child prompt from the task instructions, optional acceptance criteria, the agent's `framing`, a fixed "work only within this repository / keep tests green" instruction, and the shared `childDirective`.

## Oracle filter

`runOracleFor` runs the configured `oracleCommands` against each succeeded candidate's worktree. Commands run in `build → lint → test` order, and a build failure short-circuits the rest (`packages/core/src/oracle.ts`). A candidate `passed` only when every command that ran exited 0; if no command ran, `hadOracle` is false and the candidate does not pass. Oracle commands are either explicit config or auto-detected from `package.json` scripts via the detected package manager (pnpm/yarn/bun/npm). With no `package.json` and no override, the oracle is empty.

## Synthesis stage

When `synthesisMode` is `"passing-only"` (the default; `"off"` restores winner-take-one) and at least `synthesisMinCandidates` (default 2) candidates pass the oracle, `maybeRunSynthesis` runs after oracle filtering and before final reconciliation. It only affects this worktree path, never the gateway. The canonical design rationale lives in [synthesis and reconciliation](../concepts/synthesis-and-reconciliation.md); the engine-level shape is:

1. **Eligibility**: `evaluateSynthesisEligibility` requires synthesis enabled, an executable oracle, and `≥ synthesisMinCandidates` usable, oracle-passing candidates. If not eligible (or the run is already aborted), it emits `synthesis-skipped` with a reason and records `attempted: false`.
2. **Seed**: `heuristicJudge` picks the smallest passing diff as the seed. A fresh worktree is created from the same base SHA and seeded with the seed candidate's diff via `applyDiffToWorktree` (`git apply --3way`), so the synthesizer refines a known-good tree. If the seed cannot apply (or the manager has no `applyDiffToWorktree`), it falls back to fresh-from-base.
3. **Synthesizer**: `selectSynthesizer` picks `config.synthesisAgent`, else the first claude child (so `--max-budget-usd` / `synthesisBudgetUsd` actually bites), else the first agent. A reserved id (`synthesis-1`, …) is guaranteed not to collide with any child id. The synthesis worktree handle is registered in `handles` the instant it is created, so the engine's `finally` reaps it on any later throw.
4. **Prompt**: `buildSynthesisPrompt` gives the synthesizer the task, acceptance criteria, base ref/SHA, and the OTHER passing candidates' diffs (smallest first, embedded up to `synthesisMaxDiffChars`; past the cap a candidate is reduced to its file list plus its read-only worktree path). The instruction is to integrate the strongest ideas, never to mechanically concatenate patches.
5. **Capture + verify**: the synthesis diff is captured with the same `captureDiff` and run through the SAME oracle.

The synthesis candidate is a normal `Candidate` (tagged `synthesis: true`, with `synthesizedFrom`). It is appended to both `result.candidates` and `result.oracle`, so cost telemetry, persistence, the comparison table, and the survivor count all flow through one source of truth.

### Synthesis preference

`applySynthesisPreference` is a thin wrapper applied on top of the pure `reconcile` result over the original candidates. The synthesized candidate is preferred (yielding decision `"synthesis"`) only when it is usable, passed the same oracle, AND its blast radius (`diffSize`) is within `synthesisMaxBlastFactor ×` (default 1.5) the combined changed-line count of the passing inputs. Otherwise frites falls back to the best original passing candidate and records a `fallbackReason` on the `SynthesisInfo`. Gating the preference preserves the smallest-blast-radius safety stance: passing the oracle is the same bar the children already cleared, so an unconditional preference for a usually-larger synthesis would invert that stance when the oracle is weak.

### Synthesis event model

In addition to the per-agent events, synthesis emits a dedicated event sequence (`packages/core/src/events.ts`) so a long synthesis run is observable:

| Event | Meaning |
|---|---|
| `synthesis-skipped` | synthesis not eligible (with `reason`) |
| `synthesis-started` | `inputAgents` and `seededFrom` (the seed candidate id, if seeding applied) |
| `synthesis-progress` | streamed synthesizer output / seed-failure notice |
| `synthesis-finished` | candidate `status` + `filesTouched` |
| `synthesis-oracle-started` / `synthesis-oracle-finished` | synthesis oracle run + `passed` |

### Synthesis failure modes

The stage fails safe in every case, always falling back to the best original passing candidate (recorded via `SynthesisInfo.fallbackReason`):

- **Empty diff**: the synthesizer touched no files, so its status becomes `empty`, `usable` is false, and it falls back with "produced no usable change".
- **Errored / timed-out**: the synthesizer process fails or is reaped by the idle/hard timeout, so it is not usable and falls back. The synthesizer ships a concrete `synthesisHardTimeoutMs` (default 30 min) ceiling unlike the off-by-default per-child hard timeout.
- **Oracle fail**: the synthesis runs and produces a diff but fails the SAME build/lint/test oracle, so it falls back with "failed the oracle".
- **Over-broad**: synthesis passes but exceeds the `synthesisMaxBlastFactor ×` ceiling, so it falls back to avoid an over-broad change.
- **Aborted before synthesis**: if `deps.signal.aborted` before the stage, it is skipped (the engine does not check `.aborted` between phases otherwise).

In all fallback cases the best original passing candidate is still recommended. Synthesis can only ever improve on, never lose, a verified child result.

## Reconciliation and the judge

`reconcile` is pure over the original candidates:

1. Keep only `usable` candidates (`succeeded` with ≥1 file touched). If none → decision `near-miss`, no recommendation.
2. If there is no executable oracle → `heuristicJudge` picks a best-effort winner; decision `no-oracle` with an explicit "NOT verified by tests" rationale.
3. Filter usable candidates to oracle survivors. If none → surface the closest near-miss via `heuristicJudge`; decision `near-miss`.
4. Exactly one survivor → recommend it; decision `single` (only one agent ran) or `tests`.
5. ≥2 survivors → `heuristicJudge` tie-break; decision `judge`.

`heuristicJudge` (`packages/core/src/judge.ts`) is the deterministic smallest-blast-radius tie-breaker: it ranks survivors by smallest changed-line count (`diffSize`), then fewest files touched. This is the v1 selector; an LLM pairwise judge called with frites's own credentials is later work. frites never mechanically N-way merges divergent trees.

`ReconcileDecision` is one of `single | tests | judge | synthesis | near-miss | no-oracle`. Note `decision` is not compiler-enforced at render sites (it is string-interpolated), so every surface must handle the `synthesis` value explicitly.

## Cost telemetry

`costNote` sums per-candidate spend across all candidates (including synthesis). It prefers the backend's self-reported `costUsd` (claude reports `total_cost_usd`) and falls back to a `pricing`-table estimate from captured tokens when a backend reports no cost (codex against the ChatGPT backend). Estimation is opt-in: it only runs when `pricing` rates are configured. See [cost telemetry](../concepts/cost-telemetry.md).

## Configuration

Every config key that controls the engine (`defaultN`, `defaultAgents`, `perChildTimeoutMs`, `perChildHardTimeoutMs`, `perChildBudgetUsd`, `oracle`, `maxDepth`, the `synthesis*` keys, and the `pricing` table) is documented canonically in [configuration](../reference/configuration.md).

## Related

- [Synthesis and reconciliation](../concepts/synthesis-and-reconciliation.md): the design rationale and reconciliation policy.
- [Configuration](../reference/configuration.md): all config keys.
- [Agents and runners](agents-and-runners.md): how children are spawned.
- [Isolation](isolation.md): worktree lifecycle and diff capture.
