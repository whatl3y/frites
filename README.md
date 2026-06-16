<p align="center">
  <img src="docs/assets/frites-transparent.png" alt="french fries, nothing better, full stop" width="96" />
</p>

# frites

_frites AI: a coordinating ensemble proxy for Claude Code & Codex._

Point your Claude Code / Codex at frites and every prompt is answered by a **council of agents**
instead of one: frites fans the prompt out to multiple models, has them work independently, then
synthesizes a single vetted answer, using the subscriptions you're **already logged into** (no API
keys). It decides per-prompt whether fanning out is even worth the spend. The bet is that a
cross-checked council yields better output than any single agent; the cost is latency and metered
spend (see [the tradeoff](docs/architecture/risks-and-tradeoffs.md)).

Two ways to use it:

- **[Gateway mode](docs/product/gateway-mode.md)** (transparent proxy), zero friction: run it once
  and _every_ prompt goes through the council. Handles Q&A, reasoning, **and** code edits (it emits
  the tool calls your host runs). **← start here**
- **[MCP worktree mode](docs/product/mcp-worktree-mode.md)**: for when you want N **competing** full
  implementations run in isolated git worktrees, with your test suite picking the winner → one
  vetted diff to apply.

📖 **Full documentation: [docs/](docs/README.md)** · [table of contents](docs/SUMMARY.md)

---

## Install

**Prereqs:** `claude` and/or `codex` installed + logged in; Node >= 22; macOS or a major Linux
distribution with systemd user services.

```bash
npm install -g @frites/cli
frites install
```

That starts the transparent-proxy gateway on `http://127.0.0.1:6767` as an always-on background
service (launchd on macOS, `systemd --user` on Linux). It auto-starts on login, restarts on crash,
and idle costs nothing. Full walkthrough: [Installation](docs/getting-started/installation.md).

Point your host at the gateway, then open a new session:

**Claude Code**: add to `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:6767", "ANTHROPIC_AUTH_TOKEN": "frites" } }
```

**Codex**: add to `~/.codex/config.toml`, then `export FRITES_KEY=frites`:

```toml
model_provider = "frites"
[model_providers.frites]
base_url = "http://127.0.0.1:6767/v1"
wire_api = "responses"
env_key = "FRITES_KEY"
```

See [Configure Claude Code](docs/getting-started/configure-claude-code.md) and
[Configure Codex](docs/getting-started/configure-codex.md) for details.

## Common commands

```bash
frites install             # install/start the gateway service
frites status              # installed? loaded? reachable?
frites logs -f             # follow gateway logs live
frites restart             # restart after config changes or upgrades
frites stop                # remove the background service
frites "implement X" --repo /path/to/repo --n 2 --agents claude,codex --apply
```

Full command + flag reference: [CLI](docs/reference/cli.md). Configuration keys:
[Configuration](docs/reference/configuration.md).

## Status

126/126 unit tests passing; the gateway (both surfaces, SSE streaming, fan-out + synthesis, cost
telemetry), the launchd/systemd service, and the MCP worktree path are working and verified against
a real `claude` client. Remaining: the fan-out **quality** value-gate and Codex tool-call emission
on `/v1/responses`. Details: [Current status](docs/roadmap/current-status.md).

## Learn more

- [Product overview](docs/product/overview.md): what frites is and when to use each mode
- [Architecture overview](docs/architecture/overview.md): how it's built
- [Safety model](docs/product/safety-model.md): headless-child posture and current hardening gaps
- [Auth & billing](docs/product/auth-and-billing.md): subscription-first, metered programmatic use

## License

frites is licensed under the [Apache License 2.0](LICENSE).

Unless required by applicable law or agreed to in writing, frites is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
