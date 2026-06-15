# distrai

Point your Claude Code / Codex at distrai and every prompt is answered by a **council of agents**
instead of one: distrai fans the prompt out to multiple models, has them work independently, then
synthesizes a single vetted answer — using the subscriptions you're **already logged into** (no API
keys). It decides per-prompt whether fanning out is even worth the spend.

Two ways to use it:

- **Transparent proxy (gateway)** — zero friction: run it once and *every* prompt goes through the
  council. Handles Q&A, reasoning, **and** code edits (it emits the tool calls your host runs). **← start here**
- **MCP tool (worktree mode)** — for when you want N **competing** full implementations run in
  isolated git worktrees, with your test suite picking the winner → one vetted diff to apply.

Full design & rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Quickstart

**Prereqs:** `claude` and/or `codex` installed + logged in; Node ≥ 22; pnpm 10.x. Three commands:

```bash
cd ~/nodejs/distrai
pnpm install
pnpm distrai -- service install      # runs the gateway as a background service (launchd)
```

That starts the transparent-proxy gateway on `http://127.0.0.1:6767` — **always-on**, auto-starts on
login, restarts on crash, and **idle costs nothing** (it only spends when you send prompts). Then
point Claude Code at it — add to `~/.claude/settings.json` and open a **new** session:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:6767", "ANTHROPIC_AUTH_TOKEN": "distrai" } }
```

That's it — every prompt now goes through the council, using the subscriptions you're already
logged into. Watch live spend with `pnpm distrai -- service logs`.

Prefer not to install a service? Run it in the foreground instead: `pnpm gateway`.

---

## Managing the service

```bash
pnpm distrai -- service status      # installed? loaded? reachable?
pnpm distrai -- service restart     # e.g. after pulling distrai updates
pnpm distrai -- service uninstall   # remove it
pnpm distrai -- service install --port 7000   # use a different port
```

---

## Watching what's happening

distrai is deliberately verbose so you can always see the council working — both from the
prompting side and from the server side.

**In your editor (Claude Code / Codex).** While a turn runs, distrai streams live progress on the
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
`config set progressDetail interleaved` (or `DISTRAI_PROGRESS_DETAIL=interleaved`) to *also* stream
each child's actual output live, line-buffered and agent-prefixed (`[1] …`, `[2] …`), so you can
watch every agent think in parallel before the synthesized answer. Turn the whole channel off with
`config set streamProgress false`.

**On the gateway.** This is the **durable detail view** — scroll back to any past turn long after
the editor has collapsed its live panel. Every turn writes detailed, timestamped, turn-correlated
logs — request → continuation/fan-out decision → each child's start/finish/cost → synthesis → total
spend. Tail them with:

```bash
pnpm distrai -- logs                         # last 60 lines
pnpm distrai -- logs -f                       # follow live
pnpm distrai -- logs -f --level debug         # include prompt/decision previews
pnpm distrai -- logs -n 200 --level warn      # only warnings + errors
```

Crank verbosity with `config set --global logLevel debug` (or `DISTRAI_LOG_LEVEL=debug`), then
`service restart`. Logs are at `~/.distrai/gateway.log`; set `DISTRAI_LOG_JSON=1` for JSON lines.

---

## Configure

distrai reads `.distrai/config.json` in the repo, layered over `~/.distrai/config.json` (global).
Manage it with the CLI — no hand-editing:

```bash
pnpm distrai -- config init --global                    # scaffold ~/.distrai/config.json
pnpm distrai -- config set --global fanOutPolicy auto   # always | auto | necessary | never
pnpm distrai -- config set --global fanOutScope first-turn  # first-turn | per-turn
pnpm distrai -- config set --global defaultN 3
pnpm distrai -- config show --global
```

| Key | Meaning |
|---|---|
| `fanOutPolicy` | how aggressively to fan out (= metered spend): `always`, `auto` (coordinator judges per-prompt), `necessary` (only hard/contested), `never` (single agent) |
| `fanOutScope` | which turns of a request may fan out: `first-turn` (default — fan out on the substantive request turn, then a single agent drives the mechanical tool-loop; re-engages each new user request) or `per-turn` (fan out on every allowed turn, incl. each tool step — max cross-checking, max spend). Background/utility calls (haiku-tier title/summary/topic traffic from the host) always run a single agent regardless. |
| `defaultN` | how many child agents (1–5) |
| `defaultAgents` | which agents + models — each `{ kind: "claude-cli"\|"codex-cli", model, framing }` |
| `perChildBudgetUsd` / `perChildTimeoutMs` | per-child guardrails |
| `pricing` | optional per-model rate table (`{ "<model>": { inputPerMtok, outputPerMtok, cachedInputPerMtok?, cacheWritePerMtok? } }`, in $/million tokens) used to **estimate** child spend when a backend doesn't self-report it. claude reports cost authoritatively; codex on the ChatGPT backend reports none, so without rates its spend reads as unknown (and looked "free"). Opt-in — no built-in rates; estimated figures are marked `~`. Keys match a model exactly, else by prefix either direction. |
| `streamProgress` | stream live council progress to the client during a turn (default `true`) |
| `progressDetail` | per-agent panel detail: `telemetry` (default — state + token/time/cost counters) or `interleaved` (also stream each child's output live, agent-prefixed) |
| `logLevel` | gateway log verbosity: `debug`, `info` (default), `warn`, `error` |

After changing config, `pnpm distrai -- service restart` to pick it up.

---

## Auth & billing (read this)

Children use the accounts you're already logged into — **no API keys** (Claude keychain OAuth,
Codex ChatGPT sign-in). But programmatic use is **metered**: Claude draws the monthly Agent-SDK
credit, Codex draws your ChatGPT plan's Codex usage. distrai is subscription-first; configure an API
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

Register once (available in every repo):

```bash
claude mcp add --scope user distrai -- pnpm --dir ~/nodejs/distrai mcp
```

Then in a session: *"use distrai to implement X"* → review the diff → *"use distrai_apply with
runId …"*. Or run it standalone:

```bash
pnpm distrai -- "implement X" --repo /path/to/repo --n 2 --agents claude,codex --apply
```

---

## Codex

**Transparent proxy** — `~/.codex/config.toml`:

```toml
model_provider = "distrai"
[model_providers.distrai]
base_url = "http://127.0.0.1:6767/v1"
wire_api = "responses"
env_key = "DISTRAI_KEY"
```

**MCP worktree tool** — `~/.codex/config.toml` (the 60s default timeout **must** be raised):

```toml
[mcp_servers.distrai]
command = "pnpm"
args = ["--dir", "/Users/whatl3y/nodejs/distrai", "mcp"]
tool_timeout_sec = 600
```

---

## Repository structure

pnpm monorepo — **`apps/*`** are runnable tools, **`packages/*`** are libraries:

```
apps/
  gateway/  @distrai/gateway  transparent proxy: /v1/messages (Claude) + /v1/responses (Codex)
  mcp/      @distrai/mcp      MCP worktree tool: distrai_implement + distrai_apply
  cli/      @distrai/cli      terminal tool: distrai run + config + service
packages/
  core/        @distrai/core        engine, oracle, judge, config, answer-council (no I/O coupling)
  isolation/   @distrai/isolation   git worktree lifecycle + apply-to-branch
  agents/      @distrai/agents      headless claude/codex runners + completions + env sandbox
```

Apps are thin; all logic lives in `packages/core`, so all surfaces share one engine. Dev loop:
`pnpm typecheck` · `pnpm test` · `pnpm gateway` · `pnpm mcp` · `pnpm distrai`.

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

distrai spawns full-auto agents. It builds child env by allowlist and scrubs base-URL vars
(recursion guard), runs each worktree agent in isolation, and **only ever lands changes via an
explicit `apply` to a fresh branch** — never auto-merge, never push. The gateway binds `127.0.0.1`
only. See [ARCHITECTURE.md §4](docs/ARCHITECTURE.md).
