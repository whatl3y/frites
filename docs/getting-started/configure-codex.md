# Configure Codex

To route Codex through the frites gateway, register frites as a model provider in `~/.codex/config.toml` and select it. frites impersonates the provider endpoint, so Codex talks to the local gateway as it would to a normal provider.

## Settings

Add the following to `~/.codex/config.toml`:

```toml
model_provider = "frites"
[model_providers.frites]
base_url = "http://127.0.0.1:6767/v1"
wire_api = "responses"
env_key = "FRITES_KEY"
```

Then export the key Codex will send:

```bash
export FRITES_KEY=frites
```

- **`base_url`**: the gateway's `/v1` base. Use `http://127.0.0.1:6767/v1` for the default port; if you installed on a different port (`frites install --port 7000`), use that port.
- **`wire_api = "responses"`**: Codex talks to the gateway over the `/v1/responses` surface.
- **`env_key = "FRITES_KEY"`**: names the environment variable Codex reads to obtain the auth token it sends.

## FRITES_KEY is read by Codex, not by frites

`FRITES_KEY` is consumed by **Codex** because you named it in `env_key`; frites itself does not read it. It is simply the token Codex presents to the gateway. The gateway binds to `127.0.0.1` only and does not validate it against an upstream account. Child agents authenticate with the accounts you are already logged into (see [auth and billing](../product/auth-and-billing.md)). For the full list of variables that frites itself reads, see [environment variables](../reference/environment-variables.md).

## Next steps

- [First run](./first-run.md): confirm the gateway is reachable and watch the council work.
- [Configure Claude Code](./configure-claude-code.md): if you also use Claude Code.
- [Service management](./service-management.md): managing the always-on gateway.
