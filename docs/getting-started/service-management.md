# Service management

The frites gateway runs as an always-on background service. `frites install` sets it up; the commands below manage its lifecycle. For the complete CLI command and flag list, see [the CLI reference](../reference/cli.md).

## Commands

```bash
frites install             # install/start the gateway service
frites install --port 7000 # install/start on a different port
frites status              # installed? loaded? reachable?
frites restart             # restart after config changes or upgrades
frites stop                # remove the background service
frites uninstall           # same as stop
```

- **`frites install`**: installs and starts the service on `http://127.0.0.1:6767`. It auto-starts on login, restarts on crash, and idle costs nothing.
- **`frites install --port <N>`**: installs on a different port. Use the same port in your editor config and in `frites status`.
- **`frites status`**: reports whether the service file is installed, whether the service manager has it loaded, and whether the gateway is reachable over HTTP (it probes `http://127.0.0.1:<port>/v1/models`).
- **`frites restart`**: restart the service, e.g. after changing config or upgrading `@frites/cli`. Errors if the service is not installed.
- **`frites stop`** / **`frites uninstall`**: remove the background service. These are aliases for the same action.

## Platform behavior

`frites install` adapts to your OS. macOS and systemd Linux are supported; on any other OS the service commands exit with an error and direct you to run `frites gateway` in the foreground instead.

### macOS: launchd

On macOS, `frites install` writes a launchd user agent (`com.frites.gateway`) to `~/Library/LaunchAgents/com.frites.gateway.plist` and loads it. The agent runs at load and is kept alive, so it auto-starts on login and restarts on crash. `frites status` reports the plist path and the `launchctl list` line for the agent. `frites restart` unloads and reloads the agent; `frites stop` unloads and removes the plist.

### Linux: systemd --user

On Linux, `frites install` writes a `systemd --user` unit (`frites-gateway.service`) to `~/.config/systemd/user/frites-gateway.service`, then runs `systemctl --user daemon-reload` and `systemctl --user enable --now`. The unit uses `Restart=always`, so it restarts on crash, and it is wired to `default.target` so it starts on login. `frites status` reports the unit path plus its `is-active` / `is-enabled` state. `frites restart` runs `systemctl --user restart`; `frites stop` disables and removes the unit, then reloads the daemon.

In both cases the service writes its logs under `~/.frites/` (`gateway.log` for output, `gateway.err` for crashes).

## Compatible `frites service ...` form

Every management command above also has a longer, equivalent form under `frites service`, which remains supported for compatibility:

```bash
frites service install [--port N]
frites service status
frites service restart
frites service uninstall
frites service logs
```

The direct commands (`frites install`, `frites status`, and so on) are the intended UX; the `frites service <...>` form does the same thing. See [the CLI reference](../reference/cli.md) for the full command and flag list.
