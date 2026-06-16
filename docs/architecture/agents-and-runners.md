# Agents & runners

The `@frites/agents` package (`packages/agents`) is the child-execution layer. It turns an `AgentSpec` plus an `AgentRunContext` (cwd, prompt, abort signal, progress callback) into an `AgentRunOutput`, spawning the headless Claude or Codex CLI, streaming its NDJSON output, accumulating cost/token telemetry, and enforcing timeouts. It also owns the [environment sandbox](isolation.md) recursion guard. See the package overview in [services/agents](../services/agents.md).

## The runner abstraction

A `CliRunnerDef` (`packages/agents/src/runner.ts`) describes one backend:

- `kind`: `claude-cli` or `codex-cli`.
- `command`: the binary (`claude` / `codex`).
- `buildArgv(spec, ctx)`: the argument vector.
- `onLine(line, emit, acc)`: parses one stdout line (typically NDJSON), emitting progress messages and accumulating results into a `RunAccumulator`.

`makeRunAgent({ runners, config, passApiKeys })` builds the `RunAgentFn` the engine calls. For each spawn it:

1. Looks up the runner by `spec.kind` (errors if none is registered).
2. Reads `currentDepth()` and calls `assertDepth(depth, config.maxDepth)`, the recursion fuse.
3. Builds the allowlist child env via `buildChildEnv`.
4. Applies config defaults to the spec so per-child budget/timeout/reasoning take effect even when the spec omits them: `maxBudgetUsd ?? perChildBudgetUsd`, `timeoutMs ?? perChildTimeoutMs`, `hardTimeoutMs ?? perChildHardTimeoutMs`, and (codex only) `reasoningEffort ?? codexReasoningEffort`.
5. Spawns and streams.

## Spawn and streaming

`spawnAndStream` (`packages/agents/src/runner.ts`) runs the child:

- **Detached process group** (`detached: true`) so the whole tree can be killed via `process.kill(-pid, signal)`.
- **Prompt over stdin, not argv.** Real transcripts exceed `ARG_MAX`, so passing the prompt as an argument would spawn `E2BIG`. The runner writes the prompt to stdin and closes it; the EOF stops the child waiting for more input (both `claude -p` and `codex -` read to EOF). `EPIPE` is swallowed if the child dies before draining.
- **Line-buffered NDJSON.** stdout is split on newlines; each non-empty line is handed to `def.onLine`, wrapped in a try/catch so schema drift never crashes the runner.
- **Logging.** All stdout/stderr is buffered and written to a per-run log file in `tmpdir()` (`frites-<id>-<ts>.log`); the path is returned as `logPath`.
- **Close handling.** On close, status is `timed-out` if a timeout fired, else `succeeded` (exit 0) or `errored`. An aborted child reports error `aborted`; a non-zero exit reports `exit code <n>`.

## Timeout behavior

Timeouts are **idle**, not wall-clock (`packages/agents/src/timeout.ts`). `startIdleTimeout` arms a countdown of `idleMs` (the spec's `timeoutMs`, default `perChildTimeoutMs` = 600000 = 10 min) that resets on every stdout/stderr chunk via `idle.touch()`. A child that keeps streaming events runs as long as it stays productive; only genuine silence (a deadlock, a stalled read, an output-less spin) reaps it. This replaced an older fixed wall-clock deadline that killed exhaustive runs mid-flight.

An optional non-resetting absolute ceiling (`hardMs` / `hardTimeoutMs` / `perChildHardTimeoutMs`) is the secondary backstop for the "spinning forever while still emitting bytes" case; it is off by default for normal children. When a timeout fires, the runner sends `SIGTERM` to the process group, then escalates to `SIGKILL` after a 3-second grace (`KILL_GRACE_MS`). The same path handles external aborts (client disconnect via `ctx.signal`).

## Claude headless runner

`claudeRunner` (`packages/agents/src/claude.ts`) invokes `claude` with:

```
-p --output-format stream-json --verbose
--permission-mode bypassPermissions
--strict-mcp-config --setting-sources project
```

Plus `--model` and `--max-budget-usd` when the spec supplies them. Headless Claude reuses the machine's subscription OAuth (keychain), so no API key is needed; for headless use this draws the metered Agent-SDK credit. `--strict-mcp-config` and `--setting-sources project` keep the child from auto-loading frites itself (recursion guard). `--permission-mode bypassPermissions` lets the worktree child edit without interactive approvals; the worktree plus the final human diff review is the boundary (see [safety model](../product/safety-model.md)).

`onLine` parses the stream-json events: a `system/init` emits "session started", `assistant` content emits `using <tool>` for `tool_use` blocks and accumulates text into `summary`, and the final `result` event captures `total_cost_usd` (authoritative) and usage. Claude reports fresh / cache-read / cache-write input as disjoint categories; the accumulator sums them into the total `inputTokens` and records the cache subsets. `output_tokens` already includes thinking, so no reasoning fold is needed.

## Codex headless runner

`codexRunner` (`packages/agents/src/codex.ts`) invokes `codex` with:

```
exec --ignore-user-config --json --skip-git-repo-check
-s workspace-write -C <cwd> -c approval_policy="never"
```

Plus `-c model_reasoning_effort="<effort>"` when set, `-m <model>` when set, and a trailing `-` so codex reads the prompt from stdin. Codex reuses the machine's ChatGPT sign-in (`~/.codex/auth.json`). `--ignore-user-config` prevents loading `config.toml` (which might route back to the gateway, causing recursion). Approval is disabled via `-c approval_policy="never"` (the `--ask-for-approval` flag exits 2); `-s workspace-write` lets it edit within the worktree.

**Reasoning effort.** `codexReasoningEffort` defaults to `"high"` so codex analyzes as hard as claude before acting; a per-agent `reasoningEffort` overrides it. Only `low`/`medium`/`high` are safe: `"minimal"` returns a 400 on the stock codex model because it is incompatible with the built-in web_search/image_gen tools. Claude has no equivalent flag; its depth comes from the model plus the shared directive.

The codex NDJSON schema drifts between versions, so `onLine` is intentionally defensive: it reads `obj.type ?? obj.msg?.type`, maps command/patch/message events to coarse progress strings ("running a command", "editing files", "thinking"), and accumulates `summary` from whichever text field is present. Codex `input_tokens` is already the inclusive total (cached is a subset), so it is passed through; hidden `reasoning_output_tokens` are folded into `outputTokens` so the total is comparable with claude. The ChatGPT backend usually omits `cost_usd`; when present (API-key path) it is authoritative.

## Child directive and completions

Every substantive child prompt (answer, action, and execute paths) has the shared thoroughness directive appended (`childDirective`, default `DEFAULT_CHILD_DIRECTIVE` in `packages/core/src/config.ts`). It tells all backends to read before answering, trace the actual execution path, consider edge cases, and verify by running the build/tests. This is the provider-agnostic half of "make every agent thorough": it lifts codex to claude-like depth. Background/utility turns (title generation, summarization, the fan-out judge) deliberately skip it; set `childDirective` to `""` to disable. The agents package also exposes answer-only completions for the gateway answer/action councils, which use the same runners with answer-only permission constraints (see [safety model](../product/safety-model.md)).

## Pricing hooks

Both runners normalize token usage into the same `AgentRunOutput`/`Candidate` shape (`inputTokens` total, `cacheReadTokens`/`cacheCreationTokens` subsets, reasoning-inclusive `outputTokens`). Claude reports authoritative `costUsd`; codex against the ChatGPT backend reports none, so the engine estimates its spend from the configured `pricing` table and captured tokens. See [cost telemetry](../concepts/cost-telemetry.md) and the [pricing reference](../reference/pricing.md).

## Env-sandbox integration

Before any spawn, `makeRunAgent` calls `assertDepth` and `buildChildEnv`, which build the child environment by allowlist (never copying `process.env`), withhold API keys unless opted in, scrub base-URL variables, and increment `FRITES_DEPTH`. This is the recursion guard and secret-minimization boundary, detailed in [isolation](isolation.md) and the canonical [safety model](../product/safety-model.md).

## Related

- [Agents service](../services/agents.md): package overview.
- [Isolation](isolation.md): worktree lifecycle and the env sandbox.
- [Core engine](core-engine.md): how the engine drives runners.
- [Safety model](../product/safety-model.md): permission posture per surface.
