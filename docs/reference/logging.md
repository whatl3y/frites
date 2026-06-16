# Logging

frites keeps two distinct views of what the council is doing: a **live,
per-turn** progress channel in your editor, and a **durable** gateway log on
disk. The live channel shows what's happening right now and most editors collapse
it once a turn ends. It's the "is it working?" view, not a record. The gateway
log is the durable detail view: scroll back to any past turn long after the editor
has moved on. This page covers the durable log and the `frites logs` tailer.

## The gateway log

The gateway writes one structured, leveled, turn-scoped record per line to
stdout, which the background service captures to `~/.frites/gateway.log`
(launchd `StandardOutPath` / systemd `StandardOutput`). Crashes and unformatted
stderr land in `~/.frites/gateway.err`. Every turn writes detailed,
timestamped, turn-correlated logs: request, the continuation/fan-out decision,
each child's start/finish/cost, synthesis, and total spend.

Each text record is formatted as:

```text
<iso-timestamp> LEVEL  [turn] message  key=value …
```

The `turn` id is a first-class prefix so per-request lines are easy to scan and
grep; remaining fields follow the message as `key=value` pairs.

## `frites logs`

```bash
frites logs [-f|--follow] [-n N|--lines N] [--level debug|info|warn|error]
```

`frites logs` tails `~/.frites/gateway.log` (and appends recent crash lines from
`~/.frites/gateway.err`).

| Flag | Default | Meaning |
|---|---|---|
| `-f`, `--follow` | off | After printing the snapshot, stream new lines live until interrupted (Ctrl-C). |
| `-n N`, `--lines N` | `60` | Show the last `N` lines of the main log. |
| `--level <level>` | none | Only show lines at or above this minimum level. An unknown level is rejected with an error. |

Examples:

```bash
frites logs                         # last 60 lines
frites logs -f                      # follow live
frites logs -f --level debug        # include prompt/decision previews
frites logs -n 200 --level warn     # only warnings + errors
```

Without follow, `frites logs` prints the last `N` lines of `gateway.log`, then,
if present, a `── gateway stderr (crashes) ──` section with the last 20 lines of
`gateway.err`. With `--follow` it also streams new lines from both files as they
arrive. If neither log file exists yet, it prints a hint to start the gateway or
install the service first.

## Log levels

Levels are ordered `debug` < `info` < `warn` < `error`. The `--level` filter
keeps lines at or above the chosen minimum. Lines that aren't level-formatted
(raw stderr, crash output) are never hidden by the filter, so you never lose
crash output the gateway didn't format.

The gateway's own verbosity is set by the `logLevel` config key (default
`info`), overridden by the `FRITES_LOG_LEVEL` environment variable when set. To
capture more detail, crank verbosity with `frites config set --global logLevel
debug` (or `FRITES_LOG_LEVEL=debug`), then `frites restart` so the service picks
it up. The `frites logs --level` flag filters what's *displayed*; `logLevel`
controls what's *written*, so a level can only be shown if it was recorded.

## JSON output

Set `FRITES_LOG_JSON=1` to make the gateway emit newline-delimited JSON records
(`{ ts, level, msg, …fields }`) instead of the human format. This is useful for
ingestion by other tooling.

## Durable detail vs live progress

| | Live progress channel | Gateway log |
|---|---|---|
| Where | Editor thinking/reasoning channel | `~/.frites/gateway.log` |
| Scope | One turn, right now | Every turn, retained |
| Lifetime | Collapsed by the editor when the turn ends | Durable; scroll back any time |
| Use | "Is it working?" | After-the-fact detail of any turn |

The live channel is governed by the `streamProgress` and `progressDetail` config
keys (see [Configuration](configuration.md)). Note that not every turn shows the
whole council: with `fanOutScope: first-turn` only the substantive request turn
fans out, and the host's background/utility calls always run a single agent, so
single-agent continuation lines on follow-up turns are expected.

## See also

- [Environment variables](environment-variables.md): `FRITES_LOG_LEVEL`, `FRITES_LOG_JSON`, and related vars.
- [Configuration](configuration.md): the `logLevel`, `streamProgress`, and `progressDetail` keys.
- [CLI](cli.md): the `frites logs` command and service management.
