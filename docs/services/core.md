# Core

`@frites/core` (`packages/core`) is the shared engine, configuration, and type layer for frites. It is the brain that fans a task out to multiple child agents, filters their results through an executable oracle, optionally synthesizes a single best implementation, and reconciles everything into one recommended candidate.

The package is deliberately **I/O-free**: it has no CLI, MCP, git, or process-spawning code of its own. Everything it touches the outside world with is expressed as a structural interface that `@frites/agents` and `@frites/isolation` satisfy at runtime. The only runtime dependency is [`zod`](https://www.npmjs.com/package/zod) for config validation. This keeps the engine fully unit-testable with fakes.

For the deeper internals (the engine event model, the stage-by-stage flow, and failure modes), see [Core engine](../architecture/core-engine.md).

## Exports

`packages/core/src/index.ts` re-exports the public surface:

| Module | What it provides |
| --- | --- |
| `types.js` | `AgentSpec`, `Task`, `Candidate`, `OracleResult`, `OracleCommands`, `CommandResult`, `ReconcileDecision`, `SynthesisInfo`, `RunResult` |
| `events.js` | `EngineEventHandler`, `noopEventHandler`, and the engine event union |
| `config.js` | `FritesConfigSchema`, `FritesConfig`, `resolveConfig`, `DEFAULT_CHILD_DIRECTIVE`, `withChildDirective`, pricing schemas |
| `config-io.js` | Config loading helpers |
| `pricing.js` | `estimateCostUsd`, `pricingFor`, `UsageTokens` |
| `answer-council.js` | `runAnswerCouncil`, `decideFanOut`, `llmJudgeFanOut`, `parseFanOutVerdict`, `stripInjectedContext` |
| `agent-loop.js` | The agentic turn loop |
| `oracle.js` | `detectOracle`, `runOracle`, `runCommand` |
| `judge.js` | `heuristicJudge`, `diffSize` |
| `synthesis.js` | Synthesis eligibility, synthesizer selection, prompt construction, reconcile preference |
| `engine.js` | `runEngine` and its structural dependency interfaces |

## The engine (`engine.ts`)

`runEngine(task, deps, onEvent)` is the worktree-mode entry point. It takes a `Task`, a set of structural `EngineDeps`, and an event handler, and returns a `RunResult`.

### Structural dependencies

The engine never imports git or a CLI directly. Instead `EngineDeps` is satisfied by injected implementations:

- `worktrees: WorktreeManagerLike`: `resolveBase`, `create`, `captureDiff`, `cleanup`, and an optional `applyDiffToWorktree` (satisfied by [`@frites/isolation`](isolation.md)).
- `runAgent: RunAgentFn`: runs one `AgentSpec` in a worktree and returns status, summary, cost, and normalized token usage (satisfied by [`@frites/agents`](agents.md)).
- `runOracle: RunOracleFn`: runs build/lint/test against a worktree.
- `oracleCommands: OracleCommands`, `config: FritesConfig`, `newRunId: () => string`, and an optional external-cancellation `signal`.

### Flow

1. **Select agents.** `selectAgents` uses `task.agents` if present, else clones `config.defaultAgents` up to `n` (capped 1-5), suffixing duplicate ids.
2. **Resolve base.** `worktrees.resolveBase` pins the base ref and SHA every worktree branches from.
3. **Dispatch + execute (concurrent).** Each agent gets its own worktree (created and registered before the prompt runs, so the `finally` always reaps it), runs `runAgent`, and has its diff captured into a `Candidate`. A candidate's status becomes `empty` when it succeeded but touched no files.
4. **Oracle-filter (concurrent).** Each succeeded candidate is run through `runOracle`. With no executable oracle, candidates carry `hadOracle: false`.
5. **Synthesis (optional).** See below.
6. **Reconcile.** A pure `reconcile()` picks a winner over the original candidate pool, then `applySynthesisPreference` may override it with the synthesis candidate.

The whole run is wrapped in a `try/finally` that `Promise.allSettled`s `worktrees.cleanup` over every registered handle, so worktrees are reaped even on a throw.

### Reconciliation

`reconcile()` is pure and emits a `ReconcileDecision`:

| Decision | Meaning |
| --- | --- |
| `single` | Only one agent; it passed the oracle. |
| `tests` | The oracle filtered many candidates down to exactly one survivor. |
| `judge` | Multiple survivors; tie-broken by `heuristicJudge`. |
| `synthesis` | An oracle-passing synthesized candidate was preferred over the originals. |
| `near-miss` | No candidate passed (or none was usable); the closest is surfaced with a warning. |
| `no-oracle` | No executable oracle existed; a best-effort pick by smallest diff, explicitly *not* verified. |

## The oracle (`oracle.ts`)

The oracle is frites's objective filter. `detectOracle` returns explicit `build`/`test`/`lint` commands when given, otherwise (when `autoDetect` is on) reads `package.json` scripts and prefixes them with the detected package manager (`pnpm`, `yarn`, `bun`, or `npm`, chosen from lockfiles). `runOracle` runs the commands in **build → lint → test** order, short-circuiting on the first failure, and passes only when at least one discriminating command ran and every one that ran exited 0. `runCommand` spawns via a shell, keeps a `4000`-char output tail, and supports an `AbortSignal` plus a wall-clock `timeoutMs` (which the engine wires to `config.perChildTimeoutMs`).

## The judge (`judge.ts`)

`heuristicJudge` is the v1 tie-breaker among oracle-passing survivors: it prefers the **smallest diff** (smallest blast radius) by `diffSize` (counted added/removed lines, excluding headers), then the fewest files touched. An LLM pairwise judge is a later phase.

## Config (`config.ts`)

`FritesConfigSchema` is the single zod source of truth for every tunable, and `resolveConfig(partial)` parses (and defaults) any partial input. It defines child defaults (`defaultN`, `defaultAgents`), idle/hard timeouts, budgets, oracle detection, the recursion fuse (`maxDepth`), fan-out policy and scope, progress/logging knobs, optional per-model `pricing`, and the full `synthesis*` family. `DEFAULT_CHILD_DIRECTIVE` is the thoroughness instruction woven into every substantive child prompt (`withChildDirective`). The complete key-by-key reference lives in [Configuration](../reference/configuration.md).

## The answer council (`answer-council.ts`)

The answer council is the transparent-proxy brain for **answer/reasoning** turns (Stance-A text synthesis): no worktrees or tools; heavy file-editing lives in the engine/MCP path.

- `decideFanOut` is the heuristic gate, honoring `config.fanOutPolicy` (`never`/`always`/`necessary`/`auto`). The `auto` and `necessary` paths inspect prompt length and a `HARD_SIGNAL` keyword regex (why, compare, design, debug, prove, optimize, …).
- `llmJudgeFanOut` upgrades that to a one-word LLM verdict, parsed **strictly** and **fail-closed** by `parseFanOutVerdict` (only a reply beginning with `fan-out` fans out; anything else resolves to a single agent). It falls back to the heuristic on any error.
- `stripInjectedContext` removes known harness wrapper tags (`system-reminder`, `ide_selection`) before classification so the judge sees the real ask.
- `runAnswerCouncil` runs N children with diverse framings (drawn from `defaultAgents`), each carrying the child directive and a Markdown-formatting directive, then asks one synthesizer to merge them into a single vetted answer, keeping agreements, adjudicating disagreements, and dropping unsupported claims, without revealing that multiple responses existed.

## Synthesis (`synthesis.ts`)

The synthesis stage integrates the strongest ideas from oracle-passing candidates into one implementation, verified by the **same** oracle, never a mechanical diff merge.

- `evaluateSynthesisEligibility` requires synthesis enabled, an executable oracle, and at least `synthesisMinCandidates` usable, oracle-passing candidates.
- `selectSynthesizer` picks `config.synthesisAgent`, else the first `claude-cli` child (so `synthesisBudgetUsd` actually bites via `--max-budget-usd`), else the first agent, mapping the `synthesis*` budget/timeout overrides onto the returned spec.
- `reservedSynthesisId` allocates a collision-free `synthesis-N` id.
- `buildSynthesisPrompt` constructs the strict integration prompt, embedding non-seed candidate diffs smallest-first up to `synthesisMaxDiffChars` and falling back to a file list + read-only worktree path past the cap.
- `applySynthesisPreference` prefers the synthesized candidate only when it is usable, passed the oracle, and its blast radius is within `synthesisMaxBlastFactor ×` the combined input size; otherwise it falls back to the best original passing candidate and records the reason.

The full design rationale, reconciliation policy, and non-goals live in [Synthesis and reconciliation](../concepts/synthesis-and-reconciliation.md).

## Exported types (`types.ts`)

The type layer is the contract every other package speaks:

- `AgentSpec`: id, `kind` (`claude-cli` | `codex-cli`), optional model, framing, budget, idle/hard timeout overrides, and codex `reasoningEffort`.
- `Task`: instructions, `repoPath`, optional `baseRef`, acceptance criteria, `n`, or an explicit `agents` list.
- `Candidate`: a child's worktree, diff, `filesTouched`, status (`succeeded`/`empty`/`errored`/`timed-out`), summary, cost, normalized token usage, and synthesis provenance.
- `OracleResult` / `CommandResult`: per-command output and the overall pass.
- `RunResult`: `runId`, `recommended`, all candidates/oracle results, the `decision` + `rationale`, a `costNote`, and (when enabled) `synthesis: SynthesisInfo`.

These types carry no I/O coupling, which is what lets the engine stay pure.
