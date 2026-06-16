# Cost & telemetry

frites is deliberately verbose about what the council is doing and what it costs. Because a single turn can fan out to several metered child agents plus a synthesizer, every turn surfaces live per-agent telemetry while it runs, a consolidated recap when it closes, and durable, after-the-fact spend detail in the gateway log.

This page explains the cost and telemetry model. For the rate-table format and worked examples see [../reference/pricing.md](../reference/pricing.md); for the durable log lines and verbosity controls see [../reference/logging.md](../reference/logging.md).

## Live per-agent telemetry

While a turn runs, frites streams progress on the host's *thinking* (Claude) / *reasoning* (Codex) channel: which agents it is consulting, a live **per-agent counter** (tokens streamed so far + elapsed) that climbs as each child works, when each one finishes (with duration, tokens, and cost), synthesis, and a "still working — Ns elapsed" heartbeat so a long multi-model turn never looks stuck.

By default the panel shows per-agent **telemetry** only (state + counters). Setting `progressDetail` to `interleaved` (`config set progressDetail interleaved` or `FRITES_PROGRESS_DETAIL=interleaved`) *also* streams each child's actual output live, line-buffered and agent-prefixed (`[1] …`, `[2] …`), so you can watch every agent think in parallel before the synthesized answer. Turn the whole channel off with `config set streamProgress false`.

This channel is live and per-turn: the "is it working?" view, not a durable record. Most editors collapse it once the turn ends. Not every turn shows the whole council: with `fanOutScope: first-turn` only the substantive request turn fans out, and background/utility calls always run a single agent, so `single agent — tool-loop continuation` on follow-up turns is expected.

## Per-child counters and reported metrics

Each child completion is normalized into a provider-comparable set of counters: total input tokens (with the cached/reused portion called out), output tokens, and cost. When a child finishes, frites emits a per-agent line such as `✓ <agent> responded (…)` (or `✓ synthesis complete (…)` for the synthesizer) carrying its duration, token usage, and cost. These per-agent figures roll up into the turn's total spend so the total is never blind to any one agent's contribution.

## Estimated (~) vs authoritative spend

Cost visibility differs by backend, and frites marks the difference explicitly:

- **claude** reports cost authoritatively, `claude -p` returns actual spend, shown as a plain `$` figure.
- **codex** on the ChatGPT backend reports no cost. Without a rate table its spend reads as unknown (it previously looked free next to claude).

When a backend does not self-report cost, frites **estimates** it from the configured `pricing` table and marks the estimated figure with a leading `~` (for example `~$0.0123`). If no rate matches, the line reads `cost n/a`. The effective cost, reported or estimated, is what rolls into the turn total, so the total reflects codex's contribution rather than dropping it.

## Config-driven pricing table

Estimation is opt-in: there are no built-in rates. The `pricing` config key is a per-model rate table, in dollars per million tokens:

```json
{ "<model>": { "inputPerMtok": 0, "outputPerMtok": 0, "cachedInputPerMtok": 0, "cacheWritePerMtok": 0 } }
```

`inputPerMtok` and `outputPerMtok` are required; `cachedInputPerMtok` (cache reads) and `cacheWritePerMtok` (cache-write/creation input, claude only) are optional and default to `inputPerMtok` when omitted. A model is matched by exact key first, otherwise by prefix in either direction, so a `gpt-5.5` key covers `gpt-5.5-2026-…`, and a fully versioned key still matches a bare alias. The full schema and examples live in [../reference/pricing.md](../reference/pricing.md).

## The council recap line

A single consolidated recap line closes out the progress channel, so even after the client collapses the live block its summary view states at a glance what the council did this turn (agents consulted, wall time, call count, and cost):

```text
◆ council recap — N agents + synth · 18.3s · 4 call(s) · $0.072
```

The head varies by turn: a fanned-out turn reads `N agents + synth`, a background turn reads `1 background agent [<model>]`, and an un-fanned turn reads `single agent`. The cost suffix is the turn's accumulated reported-or-estimated spend (omitted when it is zero). The recap is the at-a-glance summary; the full per-agent breakdown (request, fan-out decision, each child's start/finish/cost, synthesis, and total spend) is written to the durable gateway log. See [../reference/logging.md](../reference/logging.md) for tailing and verbosity.

## Cost levers

Spend scales with how often frites fans out. The default `fanOutScope: first-turn` keeps an agentic task to one council (the request turn) instead of one per tool round-trip, and the host's background haiku traffic (titles, summaries, topic detection) never fans out. Both are the main cost levers besides `fanOutPolicy` and `defaultN`.
