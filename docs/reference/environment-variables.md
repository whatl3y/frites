# Environment variables

frites is configured primarily through its [config file](configuration.md). Environment variables
cover process-level knobs (host, port, auth) and a few overrides. This page lists **only** variables
that are actually read in the frites source.

The variables fall into three groups:

1. [Consumed by frites](#consumed-by-frites) — read by frites' own code.
2. [Set by you, read by Codex](#set-by-you-read-by-codex-frites_key) — the Codex `env_key` label.
3. [Evaluation-only](#evaluation-only) — used by the benchmark harness, documented elsewhere.

## Consumed by frites

These are read in frites' source. Most have a config-file equivalent; where the env var and config
overlap, the env var wins for that process.

### Gateway process

| Variable | Default | Effect |
|---|---|---|
| `FRITES_GATEWAY_HOST` | `127.0.0.1` | Bind address for the gateway server. Loopback-only by default. |
| `FRITES_GATEWAY_PORT` | `6767` | Bind port for the gateway server. |
| `FRITES_GATEWAY_TOKEN` | _(unset)_ | Optional shared secret. When set, inbound requests must present it via `Authorization: Bearer …` or `x-api-key`; otherwise the gateway returns `401`. Off by default. |
| `FRITES_HEARTBEAT_MS` | `5000` | How often (ms) to emit a `still working — Ns` heartbeat to the client during a long turn. |
| `FRITES_TELEMETRY_MS` | `2000` | How often (ms) to refresh the per-agent `~N tok · Ns` telemetry line while a child streams. |
| `FRITES_PROGRESS_DETAIL` | _(config `progressDetail`)_ | Per-agent progress verbosity: `telemetry` or `interleaved`. Overrides `config.progressDetail` when set. |

See the [Gateway API](gateway-api.md) page for how host/port/token affect the server, and
[cost telemetry](../concepts/cost-telemetry.md) for the heartbeat/telemetry lines.

### Logging

| Variable | Default | Effect |
|---|---|---|
| `FRITES_LOG_LEVEL` | _(config `logLevel`, else `info`)_ | Gateway log verbosity: `debug`, `info`, `warn`, `error`. The env var wins over config. |
| `FRITES_LOG_JSON` | _(unset)_ | Set to `1` for newline-delimited JSON log lines instead of the human format. |

See [logging](logging.md) for the full logging model.

### Auth / key passthrough

| Variable | Default | Effect |
|---|---|---|
| `FRITES_PASS_API_KEYS` | _(config `passApiKeys`)_ | Set to `1` to forward `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` through to child agents (metered API mode). Subscription-first by default — keys are withheld so CLIs use OAuth. Read by the gateway, MCP, and CLI. |
| `ANTHROPIC_API_KEY` | _(unset)_ | Forwarded to children **only** when `passApiKeys` is on. Otherwise withheld. |
| `OPENAI_API_KEY` | _(unset)_ | Forwarded to children **only** when `passApiKeys` is on. Otherwise withheld. |
| `CLAUDE_CODE_OAUTH_TOKEN` | _(unset)_ | Headless Claude subscription token (from `claude setup-token`). On the [child allowlist](#child-environment), so it reaches children — the way Claude auths where the macOS Keychain is unavailable (containers/CI). |

The child auth and billing model is the canonical topic of
[auth and billing](../product/auth-and-billing.md).

### Config resolution

| Variable | Default | Effect |
|---|---|---|
| `FRITES_GLOBAL_CONFIG` | _(unset)_ | Override the path to the global config file (normally `~/.frites/config.json`). |

### Child environment

These are managed by frites' env sandbox (`packages/agents/src/env-sandbox.ts`) — you do not normally
set them yourself, but they are part of the contract.

| Variable | Role |
|---|---|
| `FRITES_DEPTH` | Recursion fuse. The parent reads it (default `0`); each child is launched with `depth + 1`. When it would reach `maxDepth`, frites refuses to spawn — preventing a child from invoking frites again. |
| `FRITES_CHILD` | Set to `1` in every spawned child environment, marking it as a frites-launched child. |

Child environments are built by **allowlist**, never by copying `process.env`. The allowlist that is
carried through (when present) is: `HOME`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`,
`TERM`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TZ`, `CODEX_HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `XDG_DATA_HOME`, and `CLAUDE_CODE_OAUTH_TOKEN`. See the
[isolation architecture](../architecture/isolation.md) and [safety model](../product/safety-model.md).

### Provider base-URL variables (scrubbed)

To prevent a child from pointing back at the gateway (a recursive fork-bomb), frites **scrubs** these
base-URL variables out of every child environment, even if reintroduced via `extraEnv`:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_API_URL`
- `OPENAI_BASE_URL`
- `OPENAI_API_BASE`
- `CODEX_BASE_URL`

`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are still meaningful **on the host side**: they are
what you set in `~/.claude/settings.json` to point Claude Code at the gateway
(`ANTHROPIC_BASE_URL=http://127.0.0.1:6767`, `ANTHROPIC_AUTH_TOKEN=frites`). frites only scrubs them
from the **child** environment it spawns — see [configure Claude Code](../getting-started/configure-claude-code.md).

## Set by you, read by Codex (`FRITES_KEY`)

`FRITES_KEY` is **not read by frites.** It is the variable named in Codex's `env_key` setting: you
set it (`export FRITES_KEY=frites`), and Codex reads it to populate the auth token it presents to the
gateway. It is documented here only because the Codex setup mentions it.

```toml
# ~/.codex/config.toml
model_provider = "frites"
[model_providers.frites]
base_url = "http://127.0.0.1:6767/v1"
wire_api = "responses"
env_key = "FRITES_KEY"
```

Whatever you export as `FRITES_KEY` is the token Codex sends; if you have set
`FRITES_GATEWAY_TOKEN` on the gateway, `FRITES_KEY` must match it. See
[configure Codex](../getting-started/configure-codex.md).

## Evaluation-only

The benchmark harness under `eval/` uses its own `FRITES_BENCH_*` and `AIDER_*` variables (e.g.
`FRITES_BENCH_HARNESS`, `FRITES_BENCH_URL`, `FRITES_BENCH_GATEWAY_HOST`, `AIDER_REPO`,
`AIDER_EDIT_FORMAT`). These are not part of the runtime product and are not duplicated here — see the
evaluation runbook at [../../eval/README.md](../../eval/README.md) and
[evaluation](../development/evaluation.md).
