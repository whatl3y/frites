# Current status

Snapshot dated **2026-06-16**. This is the canonical, detailed status enumeration for frites. For the user-facing summary of what works and what the known limits are, see [Status and limits](../product/status-and-limits.md).

## What is working and tested

Working and tested against the unit suite (typecheck clean) plus a live smoke against a real `claude` client:

### Gateway (transparent proxy)

- **Both surfaces** — `/v1/messages` (Claude Code) and `/v1/responses` (Codex).
- **SSE streaming** — live answer streaming on pure answer turns; live per-agent progress telemetry on tool-bearing turns.
- **Traffic classification** — answer turns vs. action (coding) turns vs. background/utility traffic.
- **Fan-out + synthesis** — answer/action-council fan-out per `fanOutPolicy`, with the synthesizer being `defaultAgents[0]` invoked with `role: "synth"`.
- **LLM fan-out judge** — under `fanOutPolicy: auto`, a cheap classifier decides *whether* a turn is worth fanning out, with a heuristic short-circuit on trivially-simple prompts.
- **`fanOutScope` first-turn scoping** — the council runs on the substantive request turn, then a single agent drives the mechanical tool loop via stateless continuation detection. The host's background haiku-tier traffic (titles, summaries, topic classification) never fans out.
- **Council recap** — a closing per-turn one-line council recap (e.g. `◆ council recap — N agents + synth · 18.3s · $0.072`).
- **Cost telemetry** — per-turn cost telemetry with config-driven `pricing` estimation for backends that do not self-report cost (e.g. codex on the ChatGPT backend).

**Gateway code-editing works (verified end-to-end).** On a coding turn frites emits the `Read` / `Edit` / `Bash` `tool_use` the host executes on the real files — proven end-to-end (a real `claude` client through the gateway read a file, edited it, fixed a bug, and `npm test` passed), with **no API key**: subscription `claude -p` children decide the next action via `runActionCouncil` and the gateway constructs the `tool_use` envelope the host executes.

### MCP worktree path

- `frites_implement` + `frites_apply`: full agents run in isolated git worktrees, candidate diffs are filtered through the tests-as-oracle spine, a heuristic judge tie-breaks survivors, an optional cross-candidate synthesis step folds passing diffs into one verified candidate, and the vetted diff is applied to a fresh branch.
- Progress notifications stream over stdio.

### Service management

- The **launchd** user agent (macOS) is built and tested; on Linux a `systemd --user` unit is written and enabled.

### Config CLI

- `frites config` (`init` / `show` / `get` / `set` / `unset` / `validate` / `path`) with global + repo layering.

## Remaining work

- **Value gate (quality validation).** It is not yet validated that fan-out *quality* beats a single agent on real tickets at acceptable cost. This is the standing question the project must answer with data.
- **Codex `/v1/responses` `function_call` emission.** The gateway drives coding turns by emitting Anthropic `/v1/messages` `tool_use` (done). Emitting Codex `/v1/responses` `function_call` envelopes is not yet built.

Further hardening and feature work tracked elsewhere includes sandbox-runtime wrapping of children, an LLM (vs. heuristic) synthesis/worktree judge, and the OpenAI OAuth-replay child. See [Deferred tasks](deferred-tasks.md).
