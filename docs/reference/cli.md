# CLI

The `frites` command (`@frites/cli`) is the terminal entrypoint. It manages the
gateway background service, edits config, tails logs, and runs a one-off agent
council against a repository. Run `frites help` (`--help` / `-h`) for the inline
usage summary.

## Command dispatch

The first argument selects the subcommand. Any invocation that doesn't match a
known subcommand is treated as a run task, so `frites "implement X"` works
without a leading `run`.

| Command | Purpose |
|---|---|
| `frites install` | Install and start the gateway as a background service (alias: `frites start`). |
| `frites status` | Report whether the service is installed, loaded, and reachable. |
| `frites restart` | Restart the service (e.g. after a config change or upgrade). |
| `frites stop` | Remove the background service (alias of `uninstall`). |
| `frites uninstall` | Remove the background service. |
| `frites logs` | Tail the gateway's detailed log. See [Logging](logging.md). |
| `frites gateway` | Run the gateway in the foreground. |
| `frites config <sub>` | Read or write configuration. See [Configuration](configuration.md). |
| `frites run "<task>"` | Run a one-off agent council (also the default when no subcommand matches). |
| `frites service <sub>` | Legacy compatibility form for service management. |
| `frites help` | Print the top-level usage. |

## Service management

`frites install`, `start`, `stop`, `uninstall`, `restart`, and `status` are thin
front-ends over the service manager. On macOS the service is a launchd user agent
(`com.frites.gateway`); on Linux it is a `systemd --user` unit
(`frites-gateway.service`). Service install/uninstall/restart/status is only
supported on macOS and Linux — on other platforms use `frites gateway` to run in
the foreground.

| Command | Flags | Effect |
|---|---|---|
| `frites install` | `--port N` | Write and load the service (default port `6767`), auto-start on login, restart on crash. |
| `frites start` | `--port N` | Alias of `install`. |
| `frites restart` | — | Reload (macOS) or `systemctl --user restart` (Linux) the service. Errors if not installed. |
| `frites stop` | — | Alias of `uninstall`. |
| `frites uninstall` | — | Unload and remove the service files. |
| `frites status` | `--port N` | Show the plist/unit path, launchd/systemd load state, and an HTTP health probe against `http://127.0.0.1:<port>/v1/models`. |

`--port` defaults to `6767`. The health probe in `status` uses the port you pass
(also default `6767`), so pass the same `--port` you installed with.

## Run the gateway in the foreground

```bash
frites gateway [--port N] [--host addr]
```

Runs the gateway process directly (no service). `--port` sets
`FRITES_GATEWAY_PORT` and `--host` sets `FRITES_GATEWAY_HOST` in the spawned
gateway's environment.

## Logs

```bash
frites logs [-f|--follow] [-n N|--lines N] [--level debug|info|warn|error]
```

Tails `~/.frites/gateway.log`. See [Logging](logging.md) for full detail on the
flags, level filtering, and follow behavior.

## Configuration

```bash
frites config <init|show|get|set|unset|validate|path> [--global] [--repo path] [--force]
```

| Subcommand | Arguments | Effect |
|---|---|---|
| `init` | — | Write a starter config to the target file. Refuses to overwrite an existing file unless `--force`. |
| `show` | — | Print the effective merged config (defaults < global < repo) as JSON; the source files are noted on stderr. |
| `get` | `<key>` | Print one resolved value by dotted path (e.g. `oracle.test`). |
| `set` | `<key> <value>` | Set a value in the target file (e.g. `set defaultN 3`); validated before writing. |
| `unset` | `<key>` | Remove a value from the target file; validated before writing. |
| `validate` | — | Validate the target config file against the schema. |
| `path` | — | Print the global and repo config paths, which exist, and the write target. |

Targeting flags:

- `--global` targets `~/.frites/config.json`; without it, the target is
  `.frites/config.json` in the repo.
- `--repo path` chooses the repository directory (default: current working
  directory).
- `--force` allows `config init` to overwrite an existing file.

See [Configuration](configuration.md) for the full key list and layering rules.

## Run a one-off council

```bash
frites "<task>" [--repo path] [--n N] [--agents claude,codex] \
  [--accept "<criteria>"] [--base ref] [--apply | --apply-candidate <id>]
```

The leading `run` keyword is optional — `frites run "<task>"` and
`frites "<task>"` are equivalent. The task instructions are every non-flag
argument, joined with spaces.

| Flag | Meaning |
|---|---|
| `--repo path` | Target git repository (default: current working directory). |
| `--n N` | Number of child agents to consult. |
| `--agents claude,codex` | Comma list of agent kinds. A token starting with `codex` maps to `codex-cli`, one starting with `claude` maps to `claude-cli`; others are ignored. |
| `--accept "<criteria>"` | Acceptance criteria passed to the agents and the oracle. |
| `--base ref` | Git ref to branch each worktree from (default `HEAD`). |
| `--apply` | After the run, land the recommended candidate's diff onto a fresh branch. |
| `--apply-candidate <id>` | Land a specific candidate's diff (implies `--apply`). |

The run streams progress events to stderr (agents starting/finishing, oracle
results, synthesis, reconciliation) and prints the decision, per-candidate
summary, synthesis status, and cost note to stdout. A synthesized candidate is
marked with a `⚗︎` glyph.

Apply resolution mirrors the MCP `frites_apply` tool (see
[MCP tools](mcp-tools.md)):

- `--apply-candidate <id>` wins over the recommendation. If no candidate with
  that id exists in the run, it fails loudly and lists the available ids.
- A requested candidate that produced no diff (errored, empty, or timed out)
  fails rather than silently falling back.
- When applied, the diff lands on a new `frites/<runId>` branch; it is never
  auto-committed or pushed.

## Legacy `frites service` form

```bash
frites service <install|uninstall|restart|status|logs> [--port N]
```

The longer `service` form remains supported for compatibility, but the direct
commands (`frites install`, `frites status`, etc.) are the intended UX. `frites
service logs` forwards to the same log tailer as `frites logs`.

## See also

- [Configuration](configuration.md) — every config key and the layering rules.
- [Logging](logging.md) — the gateway log and `frites logs` flags.
- [MCP tools](mcp-tools.md) — the worktree `frites_implement` / `frites_apply` tools.
