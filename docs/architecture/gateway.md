# Gateway

The gateway (`apps/gateway`, `@frites/gateway`) is frites's primary, everyday surface: a **transparent proxy** that impersonates the model endpoint and intercepts every prompt with zero "use frites" friction. It is the implementation of **Stance A**: children are stateless completions, the host keeps its tool loop, and frites synthesizes the assistant turn per turn.

This page covers the proxy design. For the wire-level request/response shapes and SSE event sequence, see [Gateway API](../reference/gateway-api.md).

## Transparent proxy design

frites impersonates the provider endpoint so the host CLI talks to frites instead of the real backend:

- **Claude Code** points `ANTHROPIC_BASE_URL` at the gateway and posts to `/v1/messages`.
- **Codex** points its provider `base_url` at the gateway and posts to `/v1/responses`.

Because frites is the brain for every prompt, all traffic is metered (there is no free interactive top-level). The gateway binds to `127.0.0.1` only. The recursion risk (children inheriting `ANTHROPIC_BASE_URL` and recursively calling the gateway) is handled by env-scrubbing every child; see the [Safety model](../product/safety-model.md).

The two endpoints are:

| Endpoint | Host | Status |
|---|---|---|
| `POST /v1/messages` | Claude Code (Anthropic Messages) | Answer + action council, including `tool_use` emission |
| `POST /v1/responses` | Codex (OpenAI Responses) | Answer synthesis only; `function_call` emission is a follow-up |
| `POST /v1/messages/count_tokens` | Claude Code | Token counting passthrough |

## Per-turn flow

Each inbound request is one host turn. The gateway classifies the traffic, decides whether to fan out, runs the relevant council, and streams the result back over SSE.

- **Answer/reasoning turns** call `runAnswerCouncil`: N children independently answer, then the synthesizer adjudicates them into one final answer.
- **Coding turns with tools** call `runActionCouncil`: N children each propose exactly one next action as JSON, and the synthesizer selects one concrete next action for the host to execute.

Whether a turn fans out at all is gated by `fanOutPolicy` (`always | auto | necessary | never`) and, under `auto`, a cheap LLM fan-out judge with a heuristic short-circuit on trivially-simple prompts. **Which** turns get the question is bounded by `fanOutScope`, see [Fan-out scope](../concepts/fan-out-scope.md). Background/utility traffic (host haiku calls for title generation, summarization, classification) never fans out and is pinned to a single child.

The synthesis and selection rules are canonical in [Synthesis & reconciliation](../concepts/synthesis-and-reconciliation.md).

## Action synthesis and tool-call emission

On a coding turn the gateway drives the host's full agentic loop **with no API key**. Subscription `claude -p` children decide the next action via `runActionCouncil`, and the gateway constructs the host-executed `tool_use` envelope:

- Each child is prompted as a decision engine and must return exactly one JSON object: `{"kind":"tool", ...}` to ask the host to call a tool, or `{"kind":"answer", ...}` to finish with text.
- The synthesizer selects one proposed tool call **verbatim** (it is instructed never to blend tool names or inputs from different proposals); for an answer action it may synthesize freely.
- The gateway then encodes the selected action as an Anthropic `tool_use` content block with `stop_reason: "tool_use"`, which the host executes under its own permission model. The deeper semantic check happens when the host returns the tool result on the next turn.

This was verified end-to-end (real `claude` → gateway → Read → Edit → answer, bug fixed, `npm test` passed) with no API key. Codex `/v1/responses` `function_call` emission is the standing ceiling, not yet built; the Responses endpoint does answer synthesis only for now.

## The synthesizer is `defaultAgents[0]`

The synthesizer is **not** a separate model. It is `config.defaultAgents[0]`, invoked with `role: "synth"` (see `specFor` in `apps/gateway/src/index.ts`). Children round-robin the same `defaultAgents` array, so slot 0 is both the synthesizer and child index 0, and reordering `defaultAgents` changes both. There is no separate synthesizer model setting.

This synthesizer is distinct from the *fan-out judge*, the cheap classifier under `fanOutPolicy: auto` that decides **whether** to fan out.

## Progress streaming

The gateway streams over SSE. For answer turns, only the synthesizer streams live into the final answer block; child output normally goes to progress telemetry, not the user-facing answer. In interleaved progress mode child output can be shown in the progress channel, but it stays separate from the final answer, so users normally see progress plus one final synthesized answer, not a visible debate between children.

Each turn also carries per-turn cost telemetry (config-driven `pricing` estimation for backends that don't self-report cost, e.g. codex) and emits a closing **council recap** line. The in-editor thinking/reasoning channel is live-only and the host collapses it once the turn ends, so the durable per-turn detail lives in the gateway log.

## Related pages

- [Gateway API](../reference/gateway-api.md): the wire-level endpoint and SSE reference.
- [Data flow](data-flow.md): the full request → council → result sequence.
- [Fan-out scope](../concepts/fan-out-scope.md): which turns fan out.
- [Synthesis & reconciliation](../concepts/synthesis-and-reconciliation.md): how answers and actions are reconciled.
- [Auth & billing](../product/auth-and-billing.md): why every gateway prompt is metered.
