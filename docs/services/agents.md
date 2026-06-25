# Agents

`@frites/agents` (`packages/agents`) is frites's adapter layer over the headless coding CLIs. It knows how to invoke each backend, stream and parse its events, normalize token usage and cost across providers, scrub the child environment for recursion safety, and reap a stalled child. Its only dependency is [`@frites/core`](core.md), whose structural interfaces it satisfies so the engine never spawns a process itself.

For how runners fit into the overall execution model, see [Agents and runners](../architecture/agents-and-runners.md).

## Exports

`packages/agents/src/index.ts` re-exports:

| Module | What it provides |
| --- | --- |
| `runner.js` | `CliRunnerDef`, `makeRunAgent`, `RunAccumulator`: the engine-path `RunAgentFn` factory |
| `completion.js` | `runCompletion`, `parseClaudeLine`, `parseCodexLine`, `ChildEvent`, `CompletionResult`, `StreamAcc`: the answer-council path |
| `backend-errors.js` | `classifyBackendFailure`, `ModelBackendError`, `backendFailureFrom`: normalized rate/usage/auth/context failure metadata |
| `backend-policy.js` | `BackendSuppressionController`: provider suppression and alternate-provider selection after retryable backend failures |
| `claude.js` / `codex.js` | `claudeRunner` and `codexRunner` `CliRunnerDef`s |
| `env-sandbox.js` | `buildChildEnv`, `assertDepth`, `currentDepth`: the recursion + secret boundary |
| `timeout.js` | `startIdleTimeout`: the idle/hard reaper |
| `pricing.js` | Re-exports `estimateCostUsd`, `pricingFor`, `UsageTokens` from `@frites/core` (back-compat) |

`defaultRunners` is the shipped list: `[claudeRunner, codexRunner]`.

## Backend suppression and retry policy

Backend failures are classified first, then the coordinator decides what to do with them. Provider/account-scoped failures (`usage-limit`, `rate-limit`, `quota-exceeded`, `auth`, and short backend overloads) suppress that provider kind (`claude-cli` or `codex-cli`) for later calls. Reset timestamps or retry-after values win when the backend provides them; otherwise frites uses conservative TTLs: five hours for usage limits, one hour for quota, ten minutes for auth, five minutes for rate limits, and one minute for overloads. Prompt-shape failures such as `context-length`, cancellations, and unknown exits are not suppressed.

The gateway can retry the same logical child or synthesizer call through another configured unsuppressed provider. It does not retry a final-answer synthesizer after answer text has already streamed to the client, because those tokens cannot be retracted. Background/utility turns (which pin a small, cheap model) are the exception: they are not failed over to the full-price default agents — a suppressed cheap provider simply fails the cheap turn rather than silently escalating it to a premium council agent. Worktree mode records the same suppressions and uses them to avoid suppressed providers on later stages such as synthesis, but it does not automatically rerun a failed child in the same worktree: a backend can fail after partial edits, and retrying a different provider on top of those edits would blur candidate ownership.

## Runners (`runner.ts`)

A `CliRunnerDef` describes one CLI backend: its `kind`, its `command`, a `buildArgv(spec, ctx)`, and an `onLine(line, emit, acc)` parser. `makeRunAgent({ runners, config, passApiKeys })` indexes the runners by kind and returns the `RunAgentFn` the engine calls.

Before spawning, `makeRunAgent` asserts the recursion depth, builds the scrubbed child env, and applies config defaults onto the spec so a per-child budget/timeout/reasoning value always takes effect even when the spec omits it:

- `maxBudgetUsd` ← `config.perChildBudgetUsd`
- `timeoutMs` ← `config.perChildTimeoutMs` (idle)
- `hardTimeoutMs` ← `config.perChildHardTimeoutMs` (absolute, off when unset)
- `reasoningEffort` ← `config.codexReasoningEffort` (codex only; claude ignores it)

`spawnAndStream` spawns the CLI **detached** (its own process group, so it can be tree-killed via `process.kill(-pid, …)`), pipes the prompt over **stdin** and closes it (the EOF is what stops the child waiting for input; a real transcript would exceed `ARG_MAX` and trip `spawn E2BIG` if passed as argv), buffers stdout into newline-delimited lines for `onLine`, writes a combined log to a temp file, and resolves an `AgentRunOutput` with a status of `succeeded`, `errored`, or `timed-out`. On nonzero backend exits it classifies common rate-limit, usage-limit, auth, context-length, quota, and overload failures into `backendFailure` metadata while preserving the raw temp log. On idle timeout or abort it sends `SIGTERM` then escalates to `SIGKILL` after a `3000`ms grace.

## Claude runner (`claude.ts`)

Headless Claude Code, invoked as `claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --strict-mcp-config --setting-sources project`, with `--model` and `--max-budget-usd` appended from the spec. It reuses the machine's subscription OAuth (keychain), so no API key is needed. `--strict-mcp-config` plus `--setting-sources project` keep the child from auto-loading frites's own MCP (a recursion guard). The `onLine` parser emits progress for tool uses, captures the assistant text/`result` as the summary, reads `total_cost_usd` as the authoritative cost, and sums Anthropic's **disjoint** input categories (fresh + cache-read + cache-creation) into the normalized input total; `output_tokens` already includes thinking, so no reasoning fold is needed.

## Codex runner (`codex.ts`)

Headless Codex, invoked as `codex exec --ignore-user-config --json --skip-git-repo-check -s workspace-write -C <cwd> -c approval_policy="never"`, then `-c model_reasoning_effort="<v>"` (when set), `-m <model>` (when set), and `-` (read prompt from stdin). It reuses the machine's ChatGPT sign-in (`~/.codex/auth.json`); approval is set via `-c approval_policy="never"` because the `--ask-for-approval` flag exits 2, and the `workspace-write` sandbox lets it edit within the worktree. `--ignore-user-config` prevents loading `config.toml` (which could route to the gateway and recurse). The NDJSON schema drifts between versions, so the parser is defensive: it pattern-matches event types for progress, captures the latest message as the summary, passes `input_tokens` through (codex's value is already the inclusive total, with cached as a subset), and **folds `reasoning_output_tokens` into `output_tokens`** so the total is comparable with claude. `cost_usd` is honored when present (the API-key path); the ChatGPT backend usually omits it.

> `model_reasoning_effort="minimal"` is **not** safe on the stock codex model. It 400s because it is incompatible with the built-in `web_search`/`image_gen` tools. frites ships `high` as the default, so use `low`/`medium`/`high`.

## Completions (`completion.ts`)

`runCompletion(kind, prompt, opts)` is the **answer-only** path used by the answer council: a single agent runs read-only (no worktree, no editing) and returns its text plus normalized cost/tokens, streaming `ChildEvent`s (`start`/`text`/`reasoning`/`tool`/`usage`) live via `opts.onEvent`.

- **Claude** runs with `--output-format stream-json --verbose --include-partial-messages` for token-level deltas, `--strict-mcp-config`, `--setting-sources project` (never `user`, which could set `ANTHROPIC_BASE_URL` to the gateway and fork-bomb), and `--disallowedTools Edit Write NotebookEdit` as a read-only guard.
- **Codex** runs with `-s read-only` and `-o <file>` (a final-message fallback written outside the repo if the event stream yields no `agent_message`), matching the execute path's reasoning depth.

It runs in the caller's real repo when `opts.cwd` is a valid absolute path (so reads actually work), otherwise in a temp scratch dir; only scratch dirs frites creates are cleaned up. `parseClaudeLine` and `parseCodexLine` are pure, fixture-tested per-line parsers shared by this path, handling both codex's newer `thread/turn/item` events and the legacy `msg`-wrapped shape.

## Environment sandbox (`env-sandbox.ts`)

The child environment is built by **allowlist**, never by copying `process.env`. This is the recursion guard and secret-minimization boundary for full-auto agents.

- `buildChildEnv` copies only the `ALLOWLIST` vars (`HOME`, `PATH`, locale, `CODEX_HOME`, `CLAUDE_CODE_OAUTH_TOKEN`, the XDG dirs, …), optionally passes `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` when `passApiKeys` is set, then (as defense in depth) deletes every base-URL var in `SCRUB_EXACT` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `CODEX_BASE_URL`) so a child can never be pointed back at frites. It then sets `FRITES_DEPTH = depth + 1` and `FRITES_CHILD = 1`.
- `currentDepth` reads `FRITES_DEPTH` from the env; `assertDepth(depth, maxDepth)` throws the recursion-fuse error when `depth >= maxDepth`.

## Timeouts (`timeout.ts`)

`startIdleTimeout({ idleMs, hardMs, onFire })` reaps a child that has gone **silent**, not one that is merely slow. `touch()` (called on every chunk of child output) resets the idle countdown, so a child that keeps streaming runs as long as it stays productive. Only a genuine deadlock, stalled read, or output-less spin trips it. `hardMs` is an optional non-resetting absolute ceiling for the pathological "spinning forever while still dribbling bytes" case (off when undefined/0). `onFire` runs at most once, with whichever timer tripped first, and `touch()` is inert afterward. Both the runner and completion paths drive their reaping through this controller.

## Pricing (`pricing.ts`)

A thin back-compat re-export of `estimateCostUsd`, `pricingFor`, and `UsageTokens` from [`@frites/core`](core.md), so the engine path and the answer-council path estimate child spend identically from one source of truth. See [Cost telemetry](../concepts/cost-telemetry.md) and [Pricing](../reference/pricing.md).
