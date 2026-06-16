# MCP server

The MCP server is the worktree mode of frites: a Model Context Protocol server that dispatches a coding task to multiple full agents in isolated git worktrees, vets each with the repo's tests, and returns one recommended diff. The package is `@frites/mcp` (`apps/mcp`); its binary is `frites-mcp` and it talks to the MCP client over stdio.

For the full tool input/output schemas, see [../reference/mcp-tools.md](../reference/mcp-tools.md).

## How it runs (read this first)

`@frites/mcp` is deliberately unbuilt and unpublished:

- `apps/mcp/package.json` has **no `description`** and **no `build` script** — there is no `tsconfig.build.json` step and no compiled output.
- It is marked `"private": true`, so it is **not published to npm**.
- Both `main` and `bin` point at the **TypeScript source** (`./src/index.ts`), and the shebang is `#!/usr/bin/env -S npx tsx`, so it is executed directly through `tsx`.

There is **no `apps/mcp/dist`** — do not configure a client to run `apps/mcp/dist/index.js`. The MCP client launches the server through a wrapper chain (pnpm → tsx → node) against the source file.

Because that wrapper chain does not forward shutdown to the grandchild server, the server self-terminates the moment its client goes away. It watches every disconnect path: stdin `end`/`close` (the client closed the pipe), `SIGTERM`/`SIGINT`, and reparenting to PID 1 (the launcher died and orphaned it, polled every 5s). This prevents stray servers from piling up across sessions. stdout is the MCP channel, so all logging goes to stderr.

## Tools

The server registers two tools (`apps/mcp/src/index.ts`):

### `frites_implement`

Dispatches a coding task to multiple full agents (claude/codex) in isolated git worktrees, filters them with the repo's tests, and returns one vetted diff plus a comparison. It is long-running (minutes).

Inputs: `task` (what to implement or fix), `repoPath` (absolute path to the target git repo), optional `n` (1–5 agents), optional `agents` (comma list of kinds, e.g. `claude,codex`), optional `acceptanceCriteria`, and optional `baseRef` (git ref to branch from, default HEAD).

It loads config from `repoPath`, builds the engine dependencies, runs the engine, and forwards engine events as MCP `notifications/progress` (when the client supplied a `progressToken`). On completion it persists the run under `<repoPath>/.frites/runs/<runId>/` — one `.diff` per candidate plus a `result.json` — and returns a formatted comparison text, a `resource_link` to each candidate diff, and structured content. On failure it returns an error result with the message.

### `frites_apply`

Applies a diff from a previous `frites_implement` run onto a **fresh** branch `frites/<runId>`. It applies the recommended candidate by default, or a specific one via `candidateId` (e.g. to land a tighter passing child instead of the synthesized result). It requires a clean working tree and **never pushes**.

Inputs: `runId`, `repoPath`, optional `candidateId`. It reads the persisted `result.json`, resolves the chosen candidate (erroring clearly if the named candidate is missing or has no diff), and applies it to a new branch via the worktree manager, returning the branch name for review and commit.

## Runtime

The runtime helpers live in `apps/mcp/src/runtime.ts`:

- `buildEngineDeps` wires the worktree manager (`@frites/isolation`), the agent runner (`makeRunAgent` over `defaultRunners` from `@frites/agents`, honoring `passApiKeys` / `FRITES_PASS_API_KEYS`), the oracle (auto-detected per repo via `detectOracle`), and a run-id generator. It threads the MCP request's `AbortSignal` into the engine so a cancelled call cancels the run.
- `parseAgents` turns a `claude,codex` string into agent specs (prefix-matched to `claude-cli` / `codex-cli`).
- `persistRun` / `readResult` own the on-disk run record under `.frites/runs/<runId>/`.
- `describeEvent` maps each engine event to a one-line progress message; `formatResultText` renders the human-facing comparison table (agent, kind, status, files, Δlines, tokens, oracle) and the synthesis/cost summary; `toStructured` produces the machine-readable result returned as `structuredContent`.

The actual council/synthesis/reconciliation logic is the shared engine in `@frites/core` — see [core.md](core.md) — not reimplemented here.

## Dependencies

`@frites/mcp` depends on `@frites/agents`, `@frites/core`, `@frites/isolation`, the MCP SDK (`@modelcontextprotocol/sdk`), and `zod` for the tool input schemas.
