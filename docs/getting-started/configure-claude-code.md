# Configure Claude Code

To route Claude Code through the frites gateway, point its model endpoint at the local gateway URL. frites impersonates the Anthropic endpoint, so Claude Code talks to frites exactly as it would to `api.anthropic.com`.

## Settings

Add the following `env` block to `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:6767", "ANTHROPIC_AUTH_TOKEN": "frites" } }
```

- **`ANTHROPIC_BASE_URL`**: the gateway URL. Use `http://127.0.0.1:6767` for the default port. If you installed the service on a different port (`frites install --port 7000`), use that port instead.
- **`ANTHROPIC_AUTH_TOKEN`**: set to `frites`. The gateway binds to `127.0.0.1` only and does not validate this token against an upstream account; child agents authenticate using the accounts you are already logged into (see [auth and billing](../product/auth-and-billing.md)).

## Open a new session

Claude Code reads `~/.claude/settings.json` when a session starts, so **open a new session** after editing the file. Existing sessions keep their old endpoint until restarted. From then on, every prompt in that session flows through the frites council.

## Next steps

- [First run](./first-run.md): confirm the gateway is reachable and watch the council work.
- [Configure Codex](./configure-codex.md): if you also use Codex.
- [Service management](./service-management.md): managing the always-on gateway.
