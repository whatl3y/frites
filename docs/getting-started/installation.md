# Installation

frites is a coordinating ensemble proxy for Claude Code and Codex. You point your existing agent at frites, and every prompt is answered by a council of agents instead of one, using the subscriptions you are already logged into (no API keys).

The fastest path is the always-on transparent-proxy gateway. Install it once, point your editor at it, and every prompt flows through the council from then on.

## Prerequisites

- **`claude` and/or `codex` installed and logged in.** frites drives the agents you already have. Children use the accounts you are already authenticated against: Claude keychain OAuth, Codex ChatGPT sign-in. No API keys are required. (For how auth and billing work, see [auth and billing](../product/auth-and-billing.md).)
- **Node.js >= 22.**
- **macOS**, or a major Linux distribution with **systemd user services**.

## Install

```bash
npm install -g @frites/cli
frites install
```

`frites install` starts the transparent-proxy gateway on `http://127.0.0.1:6767` as an always-on background service.

- On **macOS**, it writes a launchd user agent.
- On **Linux**, it writes and enables a `systemd --user` unit.

In both cases the service auto-starts on login and restarts on crash. To install on a different port, pass `--port`:

```bash
frites install --port 7000
```

For the full set of install/status/restart/stop/uninstall commands and the launchd vs systemd details, see [service management](./service-management.md).

## What the gateway does

The gateway is a transparent proxy: it impersonates the model endpoint your editor talks to and intercepts every prompt with zero "use frites" friction. It handles Q&A and reasoning turns, and it drives the host's full agentic loop by emitting the `Read` / `Edit` / `Bash` tool calls your editor executes on the real files. For each prompt it decides whether fanning the request out to a council is worth the spend, runs the agents independently, then synthesizes a single vetted answer.

## Idle costs nothing

The service is always running, but it only spends when you send prompts. While idle it sits on `127.0.0.1` waiting, so idle = $0. Cost scales with how often you fan out (see [cost telemetry](../concepts/cost-telemetry.md)).

## Next steps

Point your editor at the gateway, then open a new session:

- [Configure Claude Code](./configure-claude-code.md): set `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.
- [Configure Codex](./configure-codex.md): add the `frites` model provider to `~/.codex/config.toml`.
- [First run](./first-run.md): confirm reachability and watch the council work on your first request.
- [Service management](./service-management.md): install, status, restart, stop, and uninstall.
