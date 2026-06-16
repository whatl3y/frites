# Overview

frites is a coordinating ensemble proxy for Claude Code and Codex. Point your existing
agent at frites and every prompt is answered by a **council of agents** instead of one:
frites fans the prompt out to multiple models, has them work independently, then
synthesizes a single vetted answer — using the subscriptions you are **already logged into**
(no API keys). It decides per-prompt whether fanning out is even worth the spend.

## The problem it solves

The host CLI (Claude Code or Codex) is already a capable single agent with a tool loop over
your files. A single agent, however, gives you one attempt and one perspective. frites'
bet is that a cross-checked council of independent agents — different model families and
prompt framings, filtered and synthesized — yields a more correct and complete result than
any single agent. Diversity comes from mixing model families (`claude` × `codex`) and prompt
framing, not from a temperature knob (neither CLI exposes one).

The cost of that bet is latency and metered spend: more agents run, and programmatic use
draws on metered usage rather than free interactive limits. This is the core "better output,
slower" tradeoff — see [risks and tradeoffs](../architecture/risks-and-tradeoffs.md) for the
canonical discussion.

## Two ways to use it

frites ships two surfaces over one shared engine for two different needs.

| Surface | What it is | When to use it |
|---|---|---|
| [Gateway mode](gateway-mode.md) | A transparent proxy you point your agent at. It intercepts *every* prompt — Q&A, reasoning, and code edits — with zero "use frites" friction. **Start here.** | Everyday work: the frictionless default for handling everything. |
| [MCP worktree mode](mcp-worktree-mode.md) | An on-demand MCP tool that runs N **competing** full implementations in isolated git worktrees, with your test suite picking the winner. | Heavy code edits where you want N full implementations filtered by tests into one vetted diff. |

Gateway mode is the primary, everyday surface: run it once and every prompt goes through the
council, including plain Q&A and code edits (it emits the `Read` / `Edit` / `Bash` tool calls
your host executes). MCP worktree mode is the deliberate, heavier path for when correctness
matters more than latency — N implementations run to completion, your tests filter them, and
you get one verified diff to apply to a fresh branch.

## The council bet

The value of frites is reconciliation quality: many independent attempts, filtered by
execution and adjudication rather than by vibes. Whether to fan out at all is itself gated by
policy and prompt classification, so the council runs where it earns its cost. In gateway
mode, quality is grounded in an LLM synthesizer adjudicating independent proposals; in
worktree mode, quality is grounded in **running your tests** — the result is verified, not
just adjudicated.

For the next level of detail, continue to [Gateway mode](gateway-mode.md) or
[MCP worktree mode](mcp-worktree-mode.md).
