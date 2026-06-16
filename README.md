<p align="center">
  <img src="docs/assets/frites.jpg" alt="frites logo" width="96" />
</p>

# frites

*frites AI — a coordinating ensemble proxy for Claude Code & Codex.*

Point your Claude Code / Codex at frites and every prompt is answered by a **council of agents**
instead of one: frites fans the prompt out to multiple models, has them work independently, then
synthesizes a single vetted answer — using the subscriptions you're **already logged into** (no API
keys). It decides per-prompt whether fanning out is even worth the spend.

Two ways to use it:

- **Transparent proxy (gateway)** — zero friction: run it once and *every* prompt goes through the
  council. Handles Q&A, reasoning, **and** code edits (it emits the tool calls your host runs). **← start here**
- **MCP tool (worktree mode)** — for when you want N **competing** full implementations run in
  isolated git worktrees, with your test suite picking the winner → one vetted diff to apply.

Full design & rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Install and use

**Prereqs:** `claude` and/or `codex` installed + logged in; Node >= 22; macOS or a major Linux distribution with systemd user services.

```bash
npm install -g @frites/cli
frites install
```

That starts the transparent-proxy gateway on `http://127.0.0.1:6767` as an always-on background service. On macOS, `frites install` writes a launchd user agent. On Linux, it writes and enables a `systemd --user` unit. In both cases it auto-starts on login, restarts on crash, and idle costs nothing because it only spends when you send prompts.

Point Claude Code and/or Codex at the gateway, then open a new session:

**Claude Code** — add to `~/.claude/settings.json`:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:6767", "ANTHROPIC_AUTH_TOKEN": "frites" } }
```

**Codex** — add to `~/.codex/config.toml`, then `export FRITES_KEY=frites`:

```toml
model_provider = "frites"
[model_providers.frites]
base_url = "http://127.0.0.1:6767/v1"
wire_api = "responses"
env_key = "FRITES_KEY"
```

Common commands:

```bash
frites install             # install/start the gateway service
frites install --port 7000 # install/start on a different port
frites status              # installed? loaded? reachable?
frites logs                # show recent gateway logs
frites logs -f             # follow gateway logs live
frites logs -f --level debug
frites restart             # restart after config changes or upgrades
frites stop                # remove the background service
frites uninstall           # same as stop
frites gateway             # run the gateway in the foreground instead
frites gateway --port 7000 --host 127.0.0.1
frites config init --global
frites config set --global fanOutPolicy auto
frites config set --global fanOutScope first-turn
frites config set --global defaultN 3
frites config show --global
frites "implement X" --repo /path/to/repo --n 2 --agents claude,codex --apply
```

The longer `frites service <install|status|restart|logs|uninstall>` form remains supported, but the direct commands above are the intended UX.

---

## Managing the service

```bash
frites status              # installed? loaded? reachable?
frites restart             # e.g. after upgrading @frites/cli
frites stop                # remove the background service
frites install --port 7000 # use a different port
```

The longer `frites service <status|restart|uninstall|install>` form remains supported for compatibility.

---

## Watching what's happening

frites is deliberately verbose so you can always see the council working — both from the
prompting side and from the server side.

**In your editor (Claude Code / Codex).** While a turn runs, frites streams live progress on the
host's *thinking* (Claude) / *reasoning* (Codex) channel — which agents it's consulting, a live
**per-agent** counter (tokens streamed so far + elapsed) that climbs as each child works, when each
one finishes (with duration, tokens, and cost), synthesis, and a "still working — Ns elapsed"
heartbeat so a long multi-model turn never looks stuck. How the result lands depends on the turn: a
**tool-bearing turn** (the usual Claude Code agentic loop) runs the whole council on the thinking
channel, closes with a one-line **council recap** (`◆ council recap — N agents + synth · 18.3s ·
$0.072`), then emits the synthesized tool call or answer when it resolves; a **pure answer turn**
(no tools — Q&A, the Codex/Responses surface) instead **streams the final answer live**,
token-by-token, as the synthesizer produces it. Either way the progress channel is visually separate
from the answer and never pollutes it or the next turn.

This channel is **live and per-turn**: it shows what's happening *right now*, and most editors
collapse it once the turn ends and move on — so it's the "is it working?" view, not a durable
record. For the full, after-the-fact detail of *any* turn, read the gateway log (below). Also note
that **not every turn shows the whole council** — with `fanOutScope: first-turn` only the
substantive request turn fans out (the mechanical tool-loop steps that follow run a single agent),
and the host's background/utility calls always run a single agent, so seeing `single agent —
tool-loop continuation` on follow-up turns is expected, not a bug.

By default the panel shows per-agent **telemetry** only (state + counters). Flip
`config set progressDetail interleaved` (or `FRITES_PROGRESS_DETAIL=interleaved`) to *also* stream
each child's actual output live, line-buffered and agent-prefixed (`[1] …`, `[2] …`), so you can
watch every agent think in parallel before the synthesized answer. Turn the whole channel off with
`config set streamProgress false`.

**On the gateway.** This is the **durable detail view** — scroll back to any past turn long after
the editor has collapsed its live panel. Every turn writes detailed, timestamped, turn-correlated
logs — request → continuation/fan-out decision → each child's start/finish/cost → synthesis → total
spend. Tail them with:

```bash
frites logs                         # last 60 lines
frites logs -f                       # follow live
frites logs -f --level debug         # include prompt/decision previews
frites logs -n 200 --level warn      # only warnings + errors
```

Crank verbosity with `config set --global logLevel debug` (or `FRITES_LOG_LEVEL=debug`), then
`service restart`. Logs are at `~/.frites/gateway.log`; set `FRITES_LOG_JSON=1` for JSON lines.

---

## Configure

frites reads `.frites/config.json` in the repo, layered over `~/.frites/config.json` (global).
Manage it with the CLI — no hand-editing:

```bash
frites config init --global                    # scaffold ~/.frites/config.json
frites config set --global fanOutPolicy auto   # always | auto | necessary | never
frites config set --global fanOutScope first-turn  # first-turn | per-turn
frites config set --global defaultN 3
frites config show --global
```

| Key | Meaning |
|---|---|
| `fanOutPolicy` | how aggressively to fan out (= metered spend): `always`, `auto` (coordinator judges per-prompt), `necessary` (only hard/contested), `never` (single agent) |
| `fanOutScope` | which turns of a request may fan out: `first-turn` (default — fan out on the substantive request turn, then a single agent drives the mechanical tool-loop; re-engages each new user request) or `per-turn` (fan out on every allowed turn, incl. each tool step — max cross-checking, max spend). Background/utility calls (haiku-tier title/summary/topic traffic from the host) always run a single agent regardless. |
| `defaultN` | how many child agents (1–5) |
| `defaultAgents` | which agents + models — each `{ kind: "claude-cli"\|"codex-cli", model, framing }`. **Order is load-bearing:** `defaultAgents[0]` doubles as the synthesizer that merges the council (there is no separate synthesizer setting); children round-robin the whole list. Reorder to change which agent synthesizes — but note slot 0 is then also child index 0. |
| `perChildBudgetUsd` / `perChildTimeoutMs` | per-child guardrails |
| `pricing` | optional per-model rate table (`{ "<model>": { inputPerMtok, outputPerMtok, cachedInputPerMtok?, cacheWritePerMtok? } }`, in $/million tokens) used to **estimate** child spend when a backend doesn't self-report it. claude reports cost authoritatively; codex on the ChatGPT backend reports none, so without rates its spend reads as unknown (and looked "free"). Opt-in — no built-in rates; estimated figures are marked `~`. Keys match a model exactly, else by prefix either direction. |
| `streamProgress` | stream live council progress to the client during a turn (default `true`) |
| `progressDetail` | per-agent panel detail: `telemetry` (default — state + token/time/cost counters) or `interleaved` (also stream each child's output live, agent-prefixed) |
| `logLevel` | gateway log verbosity: `debug`, `info` (default), `warn`, `error` |

After changing config, `frites service restart` to pick it up.

---

## Auth & billing (read this)

Children use the accounts you're already logged into — **no API keys** (Claude keychain OAuth,
Codex ChatGPT sign-in). But programmatic use is **metered**: Claude draws the monthly Agent-SDK
credit, Codex draws your ChatGPT plan's Codex usage. frites is subscription-first; configure an API
key only for overflow or non-subscription models. (You can't get free *interactive* limits for this
— see [ARCHITECTURE §2.4–2.5](docs/ARCHITECTURE.md).)

Cost visibility differs by backend: `claude -p` reports actual spend; codex on the ChatGPT backend
reports none, so set a `pricing` table (above) to see estimated codex spend (shown with a `~`) instead
of blanks. Spend scales with how often you fan out. The default `fanOutScope: first-turn` keeps an agentic task
to **one** council (the request turn) instead of one per tool round-trip, and the host's background
haiku traffic (titles, summaries, topic detection) never fans out — both are the main cost levers
besides `fanOutPolicy` and `defaultN`.

---

## Heavy code edits (MCP worktree mode)

The gateway already edits code inline (it emits the `Read`/`Edit`/`Bash` calls your host executes).
The worktree path is for when you want N **competing** full implementations run in parallel, with
your test suite filtering them, yielding **one vetted diff** to apply to a fresh branch.

Register once for Claude Code (available in every repo):

```bash
claude mcp add --scope user frites -- pnpm --dir ~/nodejs/frites mcp
```

Or register once for Codex in `~/.codex/config.toml` (the 60s default timeout **must** be raised):

```toml
[mcp_servers.frites]
command = "pnpm"
args = ["--dir", "/Users/whatl3y/nodejs/frites", "mcp"]
tool_timeout_sec = 600
```

Then in a session: *"use frites to implement X"* → review the diff → *"use frites_apply with
runId …"*. Or run it standalone:

```bash
frites "implement X" --repo /path/to/repo --n 2 --agents claude,codex --apply
```

---

## Repository structure

pnpm monorepo — **`apps/*`** are runnable tools, **`packages/*`** are libraries:

```
apps/
  gateway/  @frites/gateway  transparent proxy: /v1/messages (Claude) + /v1/responses (Codex)
  mcp/      @frites/mcp      MCP worktree tool: frites_implement + frites_apply
  cli/      @frites/cli      terminal tool: frites run + config + service
packages/
  core/        @frites/core        engine, oracle, judge, config, answer-council (no I/O coupling)
  isolation/   @frites/isolation   git worktree lifecycle + apply-to-branch
  agents/      @frites/agents      headless claude/codex runners + completions + env sandbox
```

Apps are thin; all logic lives in `packages/core`, so all surfaces share one engine. Dev loop:
`pnpm typecheck` · `pnpm test` · `pnpm gateway` · `pnpm mcp` · `pnpm frites`.

---

## Status & limits

Working and tested (67/67 unit tests + live smoke against a real `claude` client): the gateway (both
surfaces, SSE streaming, live per-agent telemetry + live answer streaming, fan-out + synthesis,
LLM fan-out judge, `fanOutScope` first-turn scoping + background-model bypass, per-turn council
recap, cost telemetry), the launchd service, the MCP worktree path (worktrees → tests-as-oracle →
vetted diff → apply), and the config CLI.

The gateway handles **both Q&A/reasoning and code edits** — on a coding turn it emits the
`Read`/`Edit`/`Bash` `tool_use` your host executes on the real files (verified end-to-end: a real
`claude` client → gateway fixed a bug and the tests passed). The MCP worktree mode stays distinct
for "run N **competing** implementations, tests pick the winner."

**Remaining:** validating that fan-out *quality* beats a single agent (the value-gate), and Codex
tool-call emission on `/v1/responses` (Anthropic `/v1/messages` is done). See
[ARCHITECTURE.md §8](docs/ARCHITECTURE.md).

---

## Safety

frites deliberately runs child agents in unattended/headless mode, so treat it as a high-trust local
automation tool rather than a permission-prompt-preserving wrapper.

**Gateway mode.** The transparent gateway asks child agents to reason about the turn, then emits the
normal `Read` / `Edit` / `Bash` tool calls back to your host. The host still executes those tool calls
under its own permission model. However, the child council itself is spawned without interactive
approval prompts: Claude Code children are launched with `--permission-mode bypassPermissions`, and
Codex children are launched with `approval_policy="never"`. For answer-only council calls, frites
adds extra guards (`Edit`, `Write`, and `NotebookEdit` are disallowed for Claude children; Codex uses
`-s read-only`). For action-producing turns, do not assume every child decision has gone through your
usual per-command approval UI before the gateway returns a synthesized tool call.

**MCP worktree mode.** `frites_implement` starts full agents in isolated git worktrees. Claude uses
bypassed permissions; Codex uses `workspace-write` with approvals disabled. This is intentional so N
agents can run to completion without prompting each other to a halt. The safety boundary is the
worktree plus the final human gate: frites returns candidate diffs, and `frites_apply` applies the
chosen diff to a fresh `frites/<runId>` branch. It never auto-merges or pushes.

**What frites does to reduce blast radius.** Child environments are built by allowlist rather than by
copying all of `process.env`; provider base-URL variables are scrubbed to prevent recursive calls back
into frites; API keys are withheld by default (`passApiKeys: false`); a recursion-depth fuse stops
nested frites launches; children have per-child timeout and budget limits; the gateway binds to
`127.0.0.1` only.

**What is not hardened yet.** The current implementation does not provide a strong OS/container
sandbox for Claude children, does not yet enforce deny-read rules for secrets such as `~/.ssh`,
`~/.aws`, or `.env`, and does not provide a mode that preserves normal interactive permission prompts
inside the child agents. Security-conscious users should use frites only in repositories and working
trees they are comfortable letting local headless agents inspect and modify, keep `passApiKeys` off
unless explicitly needed, review diffs before applying, and avoid running the gateway against
untrusted repositories until the planned sandbox-runtime/container hardening lands. See
[ARCHITECTURE.md §4](docs/ARCHITECTURE.md).
