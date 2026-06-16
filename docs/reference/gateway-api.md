# Gateway API

The frites gateway is an HTTP server that speaks the **Anthropic Messages** and **OpenAI Responses**
wire protocols, so Claude Code and Codex can point at it unmodified. Internally every request is run
through the [council of agents](../concepts/council-of-agents.md); externally it looks like a normal
model endpoint.

This page documents what the gateway process (`apps/gateway/src/index.ts`) actually implements.

## Bind address

The server listens on `FRITES_GATEWAY_HOST` (default `127.0.0.1`) and `FRITES_GATEWAY_PORT`
(default `6767`). The default bind to loopback only is deliberate — the gateway runs child agents
in headless/full-auto mode, so it is not exposed to the LAN by default. See the
[safety model](../product/safety-model.md) for the blast-radius rationale.

On startup it logs a single line, for example:

```
listening on http://127.0.0.1:6767 — Anthropic (/v1/messages) + OpenAI (/v1/responses)
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/messages` | Anthropic Messages — Q&A, reasoning, and tool-bearing (agentic) turns. |
| `POST` | `/v1/responses` | OpenAI Responses (Codex) — answer synthesis only (see the limitation below). |
| `POST` | `/v1/messages/count_tokens` | Returns an estimated `input_tokens` count for an Anthropic request body. |
| `GET` | `/v1/models` | Lists the configured child models plus a synthetic `frites-council` id. |

Any other method/path returns `404` with a JSON error envelope. Handler exceptions return `500`
with `{ type: "error", error: { message } }`.

### `POST /v1/messages`

Accepts a standard Anthropic Messages request. The gateway:

- extracts the system prompt + message history into a transcript;
- extracts any `tools` array into tool definitions;
- classifies the **last user message** (with injected harness scaffolding stripped) to decide
  fan-out — see [fan-out policy](../concepts/fan-out-policy.md);
- recovers the caller's working directory from the embedded env block in the system prompt (a line
  like `Primary working directory: /path`) when it points at an existing directory, so children run
  in the real repo;
- detects a **tool-loop continuation** turn (the last user message carries a `tool_result`) so
  `fanOutScope: first-turn` can reserve fan-out for the substantive request turn.

If the request has `stream: true`, the response is SSE (see [Streaming](#streaming-sse)); otherwise a
single JSON `message` is returned. A tool-bearing turn can resolve to either a `text` answer or a
`tool_use` block (the synthesized `Read`/`Edit`/`Bash` call the host then executes).

### `POST /v1/responses`

Accepts an OpenAI Responses request (`instructions` + `input`). It extracts the prompt and last user
text the same way, recovers the working directory, and detects a continuation turn (last input item
is a `function_call_output`). It supports both streaming (SSE) and non-streaming JSON.

> **Known limitation — Codex tool calls.** The Responses surface synthesizes an **answer only**. The
> turn is always run with an empty tool list, so the gateway never emits a Codex `function_call` on
> `/v1/responses`. Codex tool-call (`function_call`) emission is a planned follow-up; the Anthropic
> `/v1/messages` surface already emits `tool_use`. See
> [roadmap: current status](../roadmap/current-status.md).

### `POST /v1/messages/count_tokens`

Parses the body as an Anthropic request, extracts the prompt text, and returns
`{ "input_tokens": <estimate> }`. The estimate is a length heuristic (roughly `ceil(chars / 4)`),
not a tokenizer call. A body that fails to parse yields an estimate of `0`.

### `GET /v1/models`

Returns a `data` array of model objects. The ids are the distinct `model` values from
`config.defaultAgents`, plus the synthetic id `frites-council`. Each entry has the shape
`{ type: "model", id, display_name, created_at }`.

## Streaming (SSE)

When a request sets `stream: true`, the gateway responds with
`content-type: text/event-stream` and keeps the connection alive. Both surfaces emit a keep-alive
event roughly every 3 seconds (`ping` on Anthropic, `response.in_progress` on Responses).

Two distinct channels ride the stream:

- **Progress channel** — present only when the client is streaming **and** `streamProgress` is on.
  On Anthropic it is an ephemeral `thinking` block at index 0; on Responses it is a `reasoning`
  summary output item. It carries the live council narration: which agents are being consulted, a
  throttled per-agent token/elapsed counter, each agent's finish line (duration, usage, cost), and a
  `still working — Ns elapsed` heartbeat (default every 5s, `FRITES_HEARTBEAT_MS`). This block is
  ephemeral: the gateway strips it on the way back in, so echoing it back never pollutes the answer
  or the next turn.
- **Answer channel** — present whenever the client is streaming, regardless of `streamProgress`.
  Once the synthesizer begins producing the final answer, the progress block is closed and the
  answer is streamed **live**, token by token (`text_delta` / `output_text.delta`).

The per-agent telemetry cadence is controlled by `FRITES_TELEMETRY_MS` (default 2000ms), and the
verbosity by `FRITES_PROGRESS_DETAIL` / `config.progressDetail` (`telemetry` vs `interleaved`). See
[cost telemetry](../concepts/cost-telemetry.md) and [logging](logging.md).

### Live answer vs. tool calls

Only **pure answer turns** (no tools) stream the final answer live, because the synthesizer's text
deltas equal its final result. **Tool-bearing turns** instead run the whole council on the progress
channel, close with a one-line council recap, then emit the synthesized `tool_use` (or answer) when
the turn resolves — a tool action is a parsed JSON action, not prose, so it is not streamed
delta-by-delta. On the Anthropic surface, a tool action is emitted as a `tool_use` content block
(`message_delta` stop reason `tool_use`).

## Traffic classification

The gateway classifies each request before deciding how hard to work:

- **Background / utility traffic** — when the requested `model` matches `haiku`, `small`, or `fast`
  (case-insensitive), the turn is treated as host housekeeping (title generation, conversation
  summarization, topic classification, or an explicitly cheap-tier subagent). It **never fans out**:
  a single child is pinned to the exact model the host asked for, and the exhaustiveness directive is
  stripped so it stays cheap.
- **Tool-loop continuation** — under `fanOutScope: first-turn`, a continuation turn (detected from
  the request shape) runs a single agent; fan-out re-engages on the next substantive request.
- **Substantive turns** — fan-out is decided per the configured `fanOutPolicy` (heuristic, or the
  LLM fan-out judge under `auto`).

## Sessions and the turn cap

The gateway is long-lived, so it derives a stable session key from a hash of the system prompt plus
the first user message and tracks `{ turns, usd }` per session. When a session reaches
`config.maxTurns`, the gateway forces a stop and returns a canned answer explaining the cap, rather
than running another metered council. Cumulative spend is logged per turn.

## Authentication

Inbound auth is **off by default** to keep the quickstart frictionless. Set
`FRITES_GATEWAY_TOKEN` to require a shared secret; when set, every request must present it via the
`Authorization: Bearer <token>` header or the `x-api-key` header. The comparison is constant-time
(`timingSafeEqual` on equal-length buffers). A missing or mismatched token returns `401` with
`{ type: "error", error: { message: "unauthorized" } }`.

This is the gateway-side token (what Claude Code's `ANTHROPIC_AUTH_TOKEN` / Codex's `FRITES_KEY`
present). For the full env var list, see [environment variables](environment-variables.md).

## Related

- [Gateway architecture](../architecture/gateway.md) — internal request/turn flow.
- [Configuration](configuration.md) — `fanOutPolicy`, `fanOutScope`, `maxTurns`, `streamProgress`,
  `progressDetail`, and the rest.
- [Environment variables](environment-variables.md) — host, port, token, heartbeat/telemetry knobs.
- [Logging](logging.md) — the durable per-turn log.
