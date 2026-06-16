<p align="center">
  <img src="assets/frites-transparent.png" alt="frites logo" width="96" />
</p>

# frites

_frites AI — a coordinating ensemble proxy for Claude Code & Codex._

Point your Claude Code or Codex at frites and every prompt is answered by a **council of agents** instead of one. frites fans the prompt out to multiple models, has them work independently, then synthesizes a single vetted answer — using the subscriptions you're **already logged into** (no API keys). It decides per-prompt whether fanning out is even worth the spend. The bet is that a cross-checked council yields better output than any single agent; the cost is latency and metered spend (see [the tradeoff](architecture/risks-and-tradeoffs.md)).

## Two ways to use it

- **Gateway mode (transparent proxy)** — zero friction: run it once and _every_ prompt goes through the council. It handles Q&A, reasoning, **and** code edits by emitting the tool calls your host runs.
- **MCP worktree mode** — for when you want N **competing** full implementations run in isolated git worktrees, with your test suite picking the winner, yielding one vetted diff to apply.

## Where to start

| I want to…                   | Go to                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| Install                      | [Installation](getting-started/installation.md)             |
| Use the gateway              | [Gateway mode](product/gateway-mode.md)                     |
| Run competing implementations | [MCP worktree mode](product/mcp-worktree-mode.md)          |
| Configure                    | [Configuration](reference/configuration.md)                 |
| Understand the design        | [Architecture overview](architecture/overview.md)          |
| Safety                       | [Safety model](product/safety-model.md)                     |
| Current status               | [Current status](roadmap/current-status.md)                 |

## Repository and license

frites is an open-source monorepo. See the [repository structure](development/repository-structure.md) for how the packages fit together, and consult the repository root for full license details.
