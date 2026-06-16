# Repository structure

frites is a [pnpm](https://pnpm.io) monorepo. The workspace globs (`pnpm-workspace.yaml`) pull in two groups of packages:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- **`apps/*`** are the runnable surfaces — the gateway, the MCP server, and the CLI.
- **`packages/*`** are the libraries those surfaces are built from.

The apps are deliberately thin: nearly all logic lives in `packages/core`, so every surface shares one engine.

## Layout

```
apps/
  gateway/  @frites/gateway  transparent proxy: /v1/messages (Claude) + /v1/responses (Codex)
  mcp/      @frites/mcp      MCP worktree tool: frites_implement + frites_apply
  cli/      @frites/cli      terminal tool: frites run + config + service
packages/
  core/        @frites/core        engine, oracle, judge, config, answer-council (no I/O coupling)
  isolation/   @frites/isolation   git worktree lifecycle + apply-to-branch
  agents/      @frites/agents       headless claude/codex runners + completions + env sandbox
```

## Apps (runnable)

| Directory | Package | Responsibility |
|---|---|---|
| `apps/gateway` | `@frites/gateway` | Transparent model-provider proxy exposing `/v1/messages` (Claude) and `/v1/responses` (Codex). See [services/gateway.md](../services/gateway.md). |
| `apps/mcp` | `@frites/mcp` | MCP worktree tool exposing `frites_implement` + `frites_apply`. See [services/mcp-server.md](../services/mcp-server.md). |
| `apps/cli` | `@frites/cli` | Terminal entry point: `frites run`, config management, and service install/management. See [services/cli.md](../services/cli.md). |

## Packages (libraries)

| Directory | Package | Responsibility |
|---|---|---|
| `packages/core` | `@frites/core` | Shared engine, oracle, judge, config, and answer-council with no I/O coupling. See [services/core.md](../services/core.md). |
| `packages/isolation` | `@frites/isolation` | Git worktree lifecycle and apply-to-branch behavior. See [services/isolation.md](../services/isolation.md). |
| `packages/agents` | `@frites/agents` | Headless claude/codex runners, completion helpers, and the child env sandbox. See [services/agents.md](../services/agents.md). |

## Apps are thin; logic lives in core

Every app depends on `@frites/core` (and most depend on `@frites/agents` / `@frites/isolation`) via `workspace:*` dependencies. Because the surfaces share one engine, behavior such as fan-out, synthesis, and the test-as-oracle path is implemented once and reused everywhere. Adding a new surface means wiring the engine to a new transport, not reimplementing the council.

For the day-to-day dev loop (`pnpm typecheck` · `pnpm test` · `pnpm gateway` · `pnpm mcp` · `pnpm frites`), see [local-development.md](local-development.md).
