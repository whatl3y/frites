# Auth & billing

frites runs on the subscriptions you are **already logged into**: there are **no API keys** to
configure for everyday use. Children authenticate the same way you do interactively: Claude through
its keychain OAuth (`claude` login), Codex through your ChatGPT sign-in (`codex` login). What
changes once frites is in the loop is *where the spend lands*, because billing is decided by the
invocation **surface**, server-side, not by client identity.

## Subscription-first, no API keys

When the council runs, each child is spawned headless against your local credentials. Claude
children use the keychain OAuth token; Codex children use your ChatGPT account. frites withholds
API keys from children by default (`passApiKeys: false`), so the CLIs fall back to OAuth rather than
per-token API billing. This is the boundary that keeps frites on your subscription instead of a
metered key. See the [safety model](./safety-model.md) for how the child environment is built and
why keys are withheld.

## Programmatic use is metered

The catch is that *interactive* subscription limits and *programmatic* (headless) limits are not the
same bucket. When frites drives the same accounts non-interactively:

- **Claude** draws the **metered Agent-SDK credit**: $20 Pro / $100 Max5x / $200 Max20x per month,
  at full API rates, no rollover, hard stop. This is **not** the unlimited interactive limit; it is
  a separate, metered allowance tied to the Agent-SDK / `claude -p` surface.
- **Codex** draws your **ChatGPT plan's Codex usage**: `codex exec` rides the ChatGPT plan's Codex
  limits.

The asymmetry between providers (which auth paths work, which are sanctioned, and which are banned)
is detailed under [agents and runners](../architecture/agents-and-runners.md). The single load-bearing fact: spending
scales with how often you fan out, so the council's reach is governed by
[fan-out policy](../concepts/fan-out-policy.md) and [fan-out scope](../concepts/fan-out-scope.md).

## Why interactive limits can't be reused for headless fan-out

This is the most counter-intuitive part, and it is by design. Billing is **surface-based**: the
vendor decides which bucket your call hits from the endpoint it arrives on, not from who is calling.

- Replaying a raw Anthropic subscription token directly against `api.anthropic.com` is **dead and
  banned**. Anthropic added server-side validation on Jan 9 2026 and returns `401 "only for use
  with Claude Code"`. Spoofing Claude Code to borrow its unlimited interactive limit is broken,
  ToS-violating, and pointless.
- The sanctioned headless path (`claude -p` / Agent SDK) therefore lands on the **metered**
  Agent-SDK credit, not the interactive limit.

So there is **no** way for anyone to get unlimited interactive-subscription limits for *headless*
fan-out. Any tool that claims otherwise is either emulating Claude Code (broken/banned) or quietly
billing a key. frites does not pretend the free interactive bucket is reusable; it meters honestly
and keeps spend visible.

## Optional API-key overflow

API keys are an **overflow** path, not the default. Configure a key only when you want to exceed the
subscription's metered allowance, or to reach non-subscription models that your plan does not cover.
Two levers opt in:

- Set `passApiKeys: true` in config, **or**
- Set the environment variable `FRITES_PASS_API_KEYS=1`.

Either one lets the allowlisted child environment carry `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
through to the children, so the CLIs bill per-token instead of drawing the subscription. frites owns
the fallback router because the vendors do not auto-fall-back from a depleted subscription to a key.
The `passApiKeys` posture is part of the [safety model](./safety-model.md). Leaving it off is the
recommended default, and is also what keeps you subscription-first.

## Cost visibility differs by backend

How much you can *see* of what was spent depends on which backend ran the child:

| Backend | Reports cost? | What you see |
|---|---|---|
| `claude -p` (Claude) | Yes, authoritatively | Actual spend per child and per turn |
| `codex` on the ChatGPT backend | No | Nothing: reads as unknown (and once looked "free") |

Because Codex on the ChatGPT backend self-reports no cost, frites can only **estimate** its spend.
Provide a per-model `pricing` rate table and frites fills in an estimate, shown with a leading `~`
to mark it as derived rather than reported. Without rates, Codex spend reads as blank. The full
shape of the `pricing` key lives in [reference/configuration.md](../reference/configuration.md), and
how per-turn cost is surfaced is covered in
[concepts/cost-telemetry.md](../concepts/cost-telemetry.md).

## Two billing modes

Because the surface decides the bucket, frites exposes two billing modes:

1. **Interactive (cheapest, higher friction).** Your real Claude Code stays the brain on its
   interactive subscription limits and only calls frites's MCP worktree tool for deliberate heavy
   edits. Maximum free subscription usage, but it requires you at the session and to invoke the tool
   explicitly. This mode lives on the [MCP worktree path](./mcp-worktree-mode.md).
2. **Transparent / metered (the default, friction-first).** Your Claude Code / Codex points at the
   [gateway](./gateway-mode.md), so frites is the brain for *every* prompt. Children use your local
   subscriptions but programmatically, so spend is **metered** (Agent-SDK credit / ChatGPT plan),
   with optional API-key overflow.

frites defaults to mode 2 for UX (friction-over-cost) and keeps spend in check with
[fan-out policy](../concepts/fan-out-policy.md), [fan-out scope](../concepts/fan-out-scope.md), and
per-turn [cost telemetry](../concepts/cost-telemetry.md). Mode 1 stays available for cost-sensitive
heavy edits.
