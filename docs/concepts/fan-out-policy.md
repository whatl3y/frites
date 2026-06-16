# Fan-out policy

`fanOutPolicy` controls **how aggressively** frites fans a turn out to the full council. Because every council call is metered (children run on your subscriptions programmatically, which bills), fanning out on every turn is the dominant cost lever. The policy decides whether a given turn is worth the spend at all.

It has four settings:

| Value | Behavior |
|---|---|
| `always` | Always fan out. Maximum cross-checking, maximum metered spend. |
| `auto` | The coordinator judges per-prompt whether fanning out is worth it (see below). |
| `necessary` | Fan out only on hard or contested prompts; otherwise run a single agent. |
| `never` | Never fan out. Always run a single agent. |

## The LLM classifier in `auto`

`auto` is the cost-aware default. It decides fan-out per request in two stages:

1. **Heuristic short-circuit.** frites first applies a cheap heuristic. On trivially simple prompts it skips fan-out outright, with no extra model call.
2. **LLM fan-out judge.** When the heuristic says fan-out *might* be worth it, frites asks a small LLM classifier to make the final call for the current request: fan out, or run a single agent.

This LLM fan-out judge is a separate role from the council synthesizer. The synthesizer (`defaultAgents[0]`) merges the children's outputs *after* fan-out; the fan-out judge is the cheap classifier that decides **whether** to fan out in the first place. See [Council of agents](council-of-agents.md) for the synthesizer.

## Cost implications

Fan-out worthiness is a property of the **current request**, not the whole transcript, so the policy re-decides on each new request. Spend scales with how often the policy says "yes":

- `always` pays for the full N-child council on every allowed turn, the most expensive setting.
- `auto` spends only when the heuristic plus the LLM judge agree a turn benefits from cross-checking, avoiding council cost on simple prompts.
- `necessary` is more conservative still, reserving the council for hard or contested prompts.
- `never` collapses to a single agent: no council premium, no cross-checking.

`fanOutPolicy` decides *whether* a turn fans out; [`fanOutScope`](fan-out-scope.md) decides *which* turns of a multi-turn agentic task even get asked. Together they bound a long task to a small, predictable number of councils. See [Configuration](../reference/configuration.md) for the full key list and defaults.
