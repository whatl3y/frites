# Council of agents

frites answers a prompt with a **council** of independent child agents instead of one. The council fans the prompt out to several configured children, has each work autonomously, then asks a synthesizer to fold their outputs into a single vetted result. The bet is that many cross-checked attempts yield better output than any single agent; the cost is latency and metered spend.

## Independent children

When a turn fans out, frites runs N child agents concurrently. Each child receives the user prompt — optionally with a configured **framing** — and works on its own, with no visibility into the other children. Children are collected with `Promise.all`, so they run truly in parallel; if one fails, its failure is converted into a textual failure block and still handed to the synthesizer rather than aborting the whole council.

What a child produces depends on the turn:

- **Pure answer turns** (no tools): each child returns prose. The synthesizer adjudicates the children's answers into one final response.
- **Tool/action turns** (the Claude Code agentic loop): each child acts as a decision engine and proposes exactly one next action as a JSON object — a tool call or a final answer. The synthesizer **selects** one proposed tool call verbatim rather than blending proposals.

Children normally stream to the per-agent progress telemetry, not into the user-facing answer, so users see live progress plus one synthesized result, not a visible debate.

## The synthesizer is `defaultAgents[0]`

There is **no separate synthesizer model setting.** The synthesizer is `config.defaultAgents[0]`, invoked with `role: "synth"`. Children round-robin the same array by index:

```ts
return ctx.role === "synth" ? agents[0] : agents[ctx.index % agents.length];
```

The consequence is **slot 0 is both the synthesizer and child index 0** — the first agent in `defaultAgents` does double duty. Reordering `defaultAgents` changes which agent synthesizes *and* which model child 0 runs, in lockstep. To change only the synthesizer, you reorder the array, but be aware that the new slot 0 is then also the new child 0.

This synthesizer (the cheap classifier that decides *whether* to fan out under `fanOutPolicy: auto`) is a distinct concept — see [Fan-out policy](fan-out-policy.md).

## Default agent ordering and model mix

The default `defaultAgents` is a two-agent mix, in this order:

| Slot | `kind` | Framing |
|---|---|---|
| 0 | `claude-cli` | `Make the smallest correct change that satisfies the task.` |
| 1 | `codex-cli` | `Prefer a clean, well-structured solution.` |

So by default the synthesizer (and child 0) is the Claude child, child 1 is the Codex child, and `defaultN` is 2. Each entry is a `{ kind: "claude-cli" | "codex-cli", model, framing }` spec; `defaultN` (1–5) controls how many children actually run, drawn round-robin from this list.

## Prompt framing

Each child carries its own **framing** string, prepended to the prompt, that steers it toward a different point in the solution space — the default pairs "smallest correct change" against "clean, well-structured solution." On substantive prompts, frites also appends a shared child directive telling every child to reason exhaustively, inspect relevant context, and verify when changing code. (That exhaustiveness directive is stripped for cheap background/utility calls so a throwaway haiku call isn't told to read the whole repo.)

## Why diversity is not temperature-based

Candidate diversity is what justifies paying N×, and frites deliberately does **not** get it from temperature. Neither the `claude` nor the `codex` CLI exposes a `--temperature` flag, so it isn't available even if it were wanted. Same-model, same-prompt fan-out produces near-duplicates that add cost without adding signal.

Instead, diversity comes from two levers:

1. **Model-mix** — running different model families (claude × codex) so the candidates reason differently.
2. **Prompt-framing** — giving each child a different framing ("minimal change" vs. "clean refactor") so even same-family children attack the problem differently.

This is why the default mix is N=2 (1 claude + 1 codex) rather than several same-model children, and why frites defaults conservatively until measured divergence justifies more children.

All council-shaping keys — `defaultN`, `defaultAgents`, `fanOutPolicy`, `fanOutScope`, per-child guardrails, and the synthesis tuning keys — are documented in [Configuration](../reference/configuration.md).
