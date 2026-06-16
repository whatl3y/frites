# Fan-out scope

`fanOutScope` controls **which turns** of a multi-turn request fan out to the council. Where [`fanOutPolicy`](fan-out-policy.md) decides *whether* a turn is worth fanning out, `fanOutScope` decides *which* turns of an agentic task even get asked, and together they bound a long task to a small, predictable number of councils.

The host (Claude Code especially) runs a long tool loop for a single request: one turn to plan, one per tool round-trip, one to conclude. The gateway sees each of these as a separate inbound request. Fanning out a full council on *every* one of them multiplies metered spend by the loop length for near-zero added value on the mechanical steps (run this grep, read that file).

## first-turn (default) vs per-turn

| Value | Behavior |
|---|---|
| `first-turn` (default) | Fan out on the substantive **request** turn (the initial reasoning/planning), then drive the mechanical tool-loop continuations with a single agent. A task that takes N tool round-trips pays for **one** council, not N. Fan-out re-engages on each new user request. |
| `per-turn` | Restore fan-out on every allowed turn, including each tool step. Maximum cross-checking, maximum spend. |

## Stateless continuation detection

frites distinguishes a fresh request from a tool-loop continuation **without any server-side session memory**. A turn is a continuation when its request carries a tool result back: an Anthropic `tool_result` in the last user message, or a Responses `function_call_output`. That signal is read from the request *shape* alone, so the decision is correct across server restarts and across concurrent sessions, with no stored state to get out of sync.

Under `first-turn`, a continuation turn runs a single agent; a fresh request turn re-engages the council.

## Background/utility traffic always bypasses the council

The host emits cheap small/fast-model calls (title generation, conversation summarization, topic classification) on a haiku-tier model. These **never** fan out, regardless of `fanOutScope`. frites detects them by model name (matching `haiku`, `small`, or `fast`) and pins them to a *single* child on the model the host actually asked for, tools or not. Fanning a throwaway housekeeping call out to N metered children would be pure waste.

> **Single agent, tool-loop continuation is expected.** With `fanOutScope: first-turn`, only the substantive request turn fans out; the mechanical tool-loop steps that follow run a single agent, and the host's background/utility calls always run a single agent. So seeing `single agent — tool-loop continuation` on follow-up turns is the design working, not a bug.

(Caveat: detection keys on the model name, so running the host itself on a haiku *main* model would read every turn as background and never fan out.)

## Why first-turn is the default

The substantive reasoning (where independent children disagree, surface different approaches, and earn the cost of a council) happens on the request turn. The continuations that follow are mostly mechanical tool execution where a council adds near-zero value but full metered cost. Scoping fan-out to the first turn captures the quality lift where it matters while keeping an entire agentic task to a single council, making spend predictable. `per-turn` is available when you want maximum cross-checking and accept the higher spend.

See [Configuration](../reference/configuration.md) for the `fanOutScope` key alongside `fanOutPolicy`, `defaultN`, and `defaultAgents`.
