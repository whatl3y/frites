# Gateway mode

Gateway mode is the primary, everyday surface. frites runs as a transparent proxy that
impersonates the model endpoint — `ANTHROPIC_BASE_URL` for Claude Code, the provider
`base_url` for Codex — and intercepts **every** prompt with zero "use frites" friction. Run
it once and every prompt goes through the council.

## A transparent proxy for everything

The gateway handles **both** everyday Q&A / reasoning **and** code edits. It does not edit
files directly: on a coding turn it has the council decide the next action, then emits the
normal `Read` / `Edit` / `Bash` `tool_use` your host executes against the real files under
the host's own permission model. This is verified end-to-end — a real `claude` client
through the gateway has read, edited, and fixed a bug with the tests passing — and it runs
with **no API key** (subscription `claude -p` children decide the action; the gateway
constructs the `tool_use` envelope).

## Fan-out behavior

For each intercepted prompt, frites decides whether fanning out is worth the metered spend,
then runs N child agents independently and synthesizes their work into one result. Two levers
shape this:

- **Whether** a turn fans out is governed by `fanOutPolicy` — see
  [fan-out policy](../concepts/fan-out-policy.md).
- **Which** turns of a request may fan out is governed by `fanOutScope` — see
  [fan-out scope](../concepts/fan-out-scope.md). By default (`first-turn`), only the
  substantive request turn fans out a full council; the mechanical tool-loop continuations
  that follow run a single agent, and the host's background/utility traffic (haiku-tier
  title, summary, and topic-detection calls) always runs a single agent regardless.

Because of this scoping, **not every turn shows the whole council**. Seeing `single agent —
tool-loop continuation` on follow-up turns is expected, not a bug.

## Answer turns vs tool turns

How the result lands depends on the turn:

- **Tool-bearing turns** (the usual Claude Code agentic loop) run the whole council on the
  host's *thinking* / *reasoning* channel, close with a one-line council recap
  (`◆ council recap — N agents + synth · 18.3s · $0.072`), then emit the synthesized tool
  call or answer when it resolves. Tool actions are **selected, not merged** — the
  synthesizer picks exactly one proposed tool call verbatim rather than blending inputs.
- **Pure answer turns** (no tools — Q&A, the Codex/Responses surface) instead **stream the
  final answer live**, token by token, as the synthesizer produces it.

Either way, the progress channel is visually separate from the answer and never pollutes it
or the next turn.

## Live progress stream

frites is deliberately verbose so you can see the council working. While a turn runs it
streams live progress on the host's thinking (Claude) / reasoning (Codex) channel: which
agents it is consulting, a live per-agent counter (tokens streamed and elapsed time) that
climbs as each child works, when each finishes (with duration, tokens, and cost), synthesis,
and a "still working — Ns elapsed" heartbeat so a long multi-model turn never looks stuck.

This channel is **live and per-turn** — it shows what is happening right now, and most
editors collapse it once the turn ends, so it is the "is it working?" view, not a durable
record. By default the panel shows per-agent telemetry only (state plus counters); set
`progressDetail` to `interleaved` to also stream each child's actual output live, agent-prefixed
(`[1] …`, `[2] …`). For the full, after-the-fact detail of any turn, read the gateway log.

## Limitations

- The progress channel is live-only; the host collapses it after the turn, so the durable
  per-turn record lives in the gateway log, not the editor.
- With `fanOutScope: first-turn`, tool-loop continuation turns deliberately run a single agent
  — only the substantive request turn gets the full council.
- Codex tool-call emission on `/v1/responses` (`function_call`) is not yet built; the
  Anthropic `/v1/messages` `tool_use` path is done.
- Gateway mode adjudicates an answer or action; it does not run your tests. For
  test-verified results, use [MCP worktree mode](mcp-worktree-mode.md).

For the HTTP surface, endpoints, and streaming details, see the
[gateway API reference](../reference/gateway-api.md).
