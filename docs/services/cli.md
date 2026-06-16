# CLI

The CLI is the operator front door for frites: it installs and manages the gateway service, manages configuration, tails the gateway log, runs the gateway in the foreground, and runs a standalone coding-council task without the gateway. The package is `@frites/cli` (`apps/cli`); its binary is `frites` and it builds to `apps/cli/dist/index.js`.

For the full command + flag reference, see [../reference/cli.md](../reference/cli.md).

## Command surface

Dispatch happens on the first argument (`apps/cli/src/index.ts`). Anything that is not a recognized subcommand is treated as a run task.

| Command | Effect |
|---|---|
| `frites config <init\|show\|get\|set\|unset\|validate\|path>` | Manage configuration (see below). |
| `frites gateway [--port N] [--host addr]` | Run the gateway in the foreground. |
| `frites install [--port N]` | Install and start the gateway as a service. |
| `frites uninstall` | Remove the gateway service. |
| `frites start` | Alias for `install`. |
| `frites stop` | Alias for `uninstall`. |
| `frites restart` | Restart the installed service. |
| `frites status` | Show service + health status. |
| `frites logs [-f\|--follow] [-n N] [--level …]` | Tail the gateway log. |
| `frites run "<task>" …` | Run a coding-council task (standalone). |
| `frites service <install\|uninstall\|restart\|status\|logs>` | Compatibility alias for the service subcommands. |
| `frites help` / `--help` / `-h` | Print top-level usage. |

Note that `pnpm frites -- config …` forwards the literal `--` separator as the first arg; the CLI drops it so dispatch and flags work either way.

## Config management

`frites config` reads and writes JSON config files with the precedence **defaults < global < repo**. The write target is the repo config by default, or the global config with `--global`; `--repo <path>` selects which repo. Backed by `@frites/core` helpers:

- **`path`**: print the global and repo config paths (noting which are present) and the effective precedence + write target.
- **`init`**: write a starter config to the target (refuses to overwrite without `--force`).
- **`show`**: load the effective config, print it as JSON, and report its sources on stderr.
- **`get <key>`** / **`set <key> <value>`** / **`unset <key>`**: dotted-path access (e.g. `set defaultN 3`). Values are coerced via `parseConfigValue`. Every `set`/`unset` re-validates the resulting config and **refuses to write** if it would be invalid.
- **`validate`**: validate the target config file (or report that defaults will be used when absent).

## Service install and management

The service layer (`apps/cli/src/service.ts`) installs the gateway as a per-user background service that auto-starts on login, restarts on crash, and costs nothing while idle. It supports **macOS launchd** and **Linux systemd --user** only. On any other OS it instructs the user to run `frites gateway` in the foreground.

- **macOS**: writes a launchd plist at `~/Library/LaunchAgents/com.frites.gateway.plist` (`RunAtLoad` + `KeepAlive`), then bootstraps/loads it via `launchctl`.
- **Linux**: writes a systemd user unit at `~/.config/systemd/user/frites-gateway.service` (`Restart=always`), then `daemon-reload` + `enable --now` via `systemctl --user`.

Both resolve the gateway binary by importing `@frites/gateway` (falling back to known `dist`/`src` paths), run it with `process.execPath`, carry a curated environment (`PATH`, `HOME`, and any of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `FRITES_PASS_API_KEYS` that are set) plus `FRITES_GATEWAY_PORT`, and write logs to `~/.frites/gateway.log` (stdout) and `~/.frites/gateway.err` (stderr). The port defaults to `6767`.

`install` prints the snippet to point Claude Code at the gateway (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`). `status` reports whether the plist/unit exists, the launchd/systemd state, and a live health check against `/v1/models`. `frites gateway` runs the gateway directly (forwarding signals and exit code), translating `--port`/`--host` into `FRITES_GATEWAY_PORT`/`FRITES_GATEWAY_HOST`.

`frites logs` snapshots the last N lines (default 60) of `gateway.log`, appends any recent crash output from `gateway.err`, and with `-f`/`--follow` streams new lines via `tail -F`. `--level debug|info|warn|error` filters by the parsed level token while always keeping unformatted crash lines.

## Standalone run

`frites run "<task>"` (also the default for unrecognized input) runs a full coding-council task **without the gateway**, using the same engine the MCP server uses. It loads config from the repo, auto-detects the oracle, builds engine deps (worktree manager, agent runner, oracle), and runs the engine, streaming a one-line description per engine event to stderr.

Flags: `--repo <path>` (default cwd), `--n <N>`, `--agents claude,codex`, `--accept <criteria>`, `--base <ref>`, and `--apply` / `--apply-candidate <id>`. On completion it prints the decision, rationale, per-candidate summary (files, Δlines, synthesis marker), synthesis status, cost note, and the recommended candidate. With `--apply` it lands the recommended diff on a fresh branch via the worktree manager; `--apply-candidate <id>` lands a specific candidate instead and fails loudly if that candidate is missing or produced no diff. Without `--apply` it prints how to re-run to land a diff.

## Dependencies

`@frites/cli` depends on `@frites/agents`, `@frites/core`, `@frites/gateway`, and `@frites/isolation`.
