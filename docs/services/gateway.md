# Gateway

The gateway is the long-lived HTTP service that fronts your existing coding agent (Claude Code or Codex). It speaks the Anthropic Messages API and the OpenAI Responses API, so the host points at it as a drop-in base URL and never knows it is talking to a council instead of a single model. The package is `@frites/gateway` (`apps/gateway`); its binary is `frites-gateway` and it builds to `apps/gateway/dist/index.js`.

For the request-handling internals and how the council turn is assembled, see [../architecture/gateway.md](../architecture/gateway.md). For the full endpoint + SSE event reference, see [../reference/gateway-api.md](../reference/gateway-api.md).

## Transparent proxy role

The gateway is a transparent shim: it accepts the same request shapes the host already sends, runs a council turn underneath, and re-encodes the result as a normal streaming or non-streaming response. No host configuration beyond the base URL changes.

- It extracts the prompt from the incoming body (Anthropic `system` + `messages`, or Responses `instructions` + `input`), extracts any declared tools, and determines whether the request is a fresh ask or a tool-loop continuation.
- It recovers the caller's working directory from the env block that Claude Code and Codex embed in the system prompt (matching `working directory:`/`cwd:` against an absolute path that exists), so children run inside the real repo rather than an empty temp dir.
- It classifies the user's actual ask, stripping injected harness scaffolding (system-reminders, IDE context) via `stripInjectedContext`, to decide fan-out, falling back to the raw text when stripping leaves nothing.
- Background/utility traffic (title generation, summarization, classification, or an explicitly cheap-tier subagent) is detected by a small/fast model name (`haiku`/`small`/`fast`) and pinned to a single child with the exhaustiveness directive stripped, so housekeeping calls never fan out into N metered children.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages: answer or tool-use, streaming (SSE) or JSON. |
| POST | `/v1/responses` | OpenAI Responses: answer-only synthesis, streaming (SSE) or JSON. |
| POST | `/v1/messages/count_tokens` | Returns an estimated `input_tokens` for the prompt. |
| GET | `/v1/models` | Lists configured agent models plus `frites-council`. |

Unknown paths return `404`; handler exceptions return `500`. Token counts are estimated at roughly `ceil(length / 4)` characters per token; this is an estimate, not a tokenizer.

## Progress and live answer streaming

When the client streams, the gateway carries two channels back over SSE, both backed by the single-consumer `ProgressSink` (`apps/gateway/src/progress.ts`) which buffers early messages until the SSE writer attaches a listener, then replays and streams live:

- **Progress channel**: an ephemeral `thinking` block (Anthropic) or `reasoning` summary (Responses) at output index 0, carrying council milestone lines and a periodic heartbeat. It exists only when the client is streaming *and* `streamProgress` is on. It is signed with a placeholder signature and stripped on the way back in, so it never pollutes the answer or the next turn.
- **Answer channel**: the final answer block at index 1, streamed live as the synthesizer produces tokens. It exists whenever the client streams, independent of the progress setting. Only the synthesizer (or a lone non-fanned-out answer turn) routes text here; tool turns emit a parsed JSON action instead and do not stream a live answer.

Per-child visibility is configurable via `progressDetail` (env `FRITES_PROGRESS_DETAIL`): `telemetry` shows state plus throttled `~N tok · Ns` counters; `interleaved` additionally streams each child's output, agent-prefixed. A heartbeat (`FRITES_HEARTBEAT_MS`, default 5000ms) emits a "still working — Ns elapsed" line that names which agents the turn is waiting on; telemetry refresh is throttled by `FRITES_TELEMETRY_MS` (default 2000ms). Each turn ends with a one-line council recap (agents consulted, wall time, calls, cost) so a collapsed thinking block still summarizes what happened.

## Logging

Logging is structured, leveled, and turn-scoped (`apps/gateway/src/logger.ts`). The gateway writes one record per line to stdout, which lands in the service's `StandardOutPath` (`~/.frites/gateway.log`), the file `frites logs` tails.

- Levels are `debug | info | warn | error`. The effective level is resolved from `FRITES_LOG_LEVEL`, then `config.logLevel`, else `info`.
- Milestone lines go to the info log; high-frequency telemetry and interleaved text go to debug, so per-agent detail lives in `frites logs -f --level debug`.
- Format is human-readable by default with a `[turn]` prefix per request; set `FRITES_LOG_JSON=1` for newline-delimited JSON.

## Service behavior

The gateway is a single long-lived process bound to `FRITES_GATEWAY_HOST` (default `127.0.0.1`) and `FRITES_GATEWAY_PORT` (default `6767`). Because it is long-lived, it keeps in-memory per-session state:

- **Turn cap**: each session (keyed by a hash of the system prompt + first message) is capped at `config.maxTurns`; on hitting the cap it returns a stop answer instead of running another turn, to bound runaway cost.
- **Cumulative spend**: per-session USD is accumulated and logged each turn (`sessionUsd`), so the running cost of a conversation is visible in the log.
- **Optional auth**: an inbound shared secret is off by default; setting `FRITES_GATEWAY_TOKEN` requires a matching `Authorization: Bearer` / `x-api-key` (compared with a timing-safe check), otherwise requests get `401`.
- **API key passthrough**: `config.passApiKeys` or `FRITES_PASS_API_KEYS=1` forwards the host's provider keys down to the child runners.

On startup it logs the bind address and the effective policy (`fanOutPolicy`, `fanOutScope`, `maxTurns`, auth on/off, `streamProgress`, `progressDetail`, log level, and configured agents). It is normally run under launchd/systemd by the CLI (see [cli.md](cli.md)) or in the foreground with `frites gateway`.
