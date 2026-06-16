# First run

Once the gateway is installed and your editor is pointed at it, your next prompt is answered by the council. This page walks through confirming reachability and reading the live progress on your first request.

## Confirm the gateway is reachable

Before sending a prompt, check that the service is installed, loaded, and responding:

```bash
frites status
```

`frites status` reports three things: whether the service file is installed, whether the service manager has it loaded (launchd on macOS, systemd on Linux), and whether the gateway is reachable over HTTP. It probes `http://127.0.0.1:6767/v1/models` and prints `reachable ✓` on success. If it is not reachable, see [service management](./service-management.md).

## Send the request and watch live progress

Open a new session in Claude Code or Codex (so it picks up the gateway endpoint) and send a prompt. While the turn runs, frites streams live progress on the host's *thinking* channel (Claude) or *reasoning* channel (Codex), visually separate from the answer, so it never pollutes the result or the next turn.

By default the panel shows per-agent **telemetry**: which agents frites is consulting, a live per-agent counter (tokens streamed so far plus elapsed time) that climbs as each child works, and when each one finishes (with duration, tokens, and cost), then synthesis. A **heartbeat** line (`still working — Ns elapsed`) keeps a long multi-model turn from ever looking stuck.

How the result lands depends on the turn:

- A **tool-bearing turn** (the usual Claude Code agentic loop) runs the whole council on the thinking channel, closes with a one-line **council recap**, and then emits the synthesized tool call or answer.
- A **pure answer turn** (no tools: Q&A, the Codex/Responses surface) instead streams the final answer live, token by token, as the synthesizer produces it.

This channel is live and per-turn. It shows what is happening right now, and most editors collapse it once the turn ends. It is the "is it working?" view, not a durable record. For the full after-the-fact detail of any turn, read the gateway log (see [logging](../reference/logging.md)).

## What the council recap means

On a tool-bearing turn, frites closes with a one-line council recap, for example:

```
◆ council recap — N agents + synth · 18.3s · $0.072
```

It summarizes the turn just completed: how many agents were consulted plus the synthesizer (`N agents + synth`), the wall-clock duration (`18.3s`), and the total metered spend for the turn (`$0.072`). For how spend is measured and estimated per backend, see [cost telemetry](../concepts/cost-telemetry.md).

## Not every turn shows the whole council

Seeing a single agent on some follow-up turns is expected, not a bug. With the default `fanOutScope: first-turn`, only the substantive request turn fans out; the mechanical tool-loop steps that follow run a single agent, so you may see `single agent — tool-loop continuation` on those turns. The host's background and utility calls (titles, summaries, topic detection) also always run a single agent.

## Next steps

- [Cost telemetry](../concepts/cost-telemetry.md): what the per-agent costs and recap totals mean.
- [Logging](../reference/logging.md): the durable, after-the-fact log of every turn.
- [Service management](./service-management.md): restart, stop, and uninstall the gateway.
