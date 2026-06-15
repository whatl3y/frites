# frites — Architecture & Plan

> A coordinator that dispatches a task to **multiple full coding agents**, has each do real
> work in isolation, then **diffs / tests / judges** their results into one vetted answer —
> driven from your normal Claude Code / Codex session.

Status: **greenfield**, plan locked 2026-06-14. This document is the source of truth.

---

## 1. Vision

Run one server. Configure it once in Claude Code and Codex. From then on you say
*"use frites to implement X"* and frites fans the task out to several configured child
agents (Claude, Codex, and/or raw API models), each working autonomously in its own
isolated git worktree. frites collects every candidate, runs the repo's **test suite as the
ground-truth oracle**, breaks ties between test-passing candidates with a scoped LLM judge,
optionally runs one grounded feedback round, and returns a single **vetted unified diff** you
review and apply to a fresh branch.

The value is *reconciliation quality* — many independent attempts, filtered by execution, not
vibes. The moat is the selector, not the fan-out.

---

## 2. The decisions that shaped this (and the research behind them)

Four research passes (each: parallel investigation → synthesis → adversarial review, verified
against the actual installed binaries) converged on the following. The non-obvious ones:

### 2.1 Both stances ship — Stance A (gateway) is primary, Stance B (MCP) for heavy edits
The host CLI (Claude Code / Codex) is *already* a full agent with a tool loop over your files.
Two coherent designs exist:
- **Stance A — answer/action synthesizer:** children are stateless completions; the host keeps its
  tool loop; frites fans out per turn and synthesizes the assistant turn — on a coding turn it
  emits the `tool_use` the host executes (the children *decide* the action; they don't edit files).
- **Stance B — agentic broker:** children are full agents that do real file edits in isolated
  worktrees; frites reconciles their work with the test suite as the ground-truth oracle.

frites ships **both**. The transparent-proxy **gateway is the primary, everyday surface and is
Stance A** (lowest friction — every prompt goes through the council; verified editing real code
end-to-end via host-executed `tool_use`, **no API key**). **Stance B is the MCP `frites_implement`
path** for when you want N competing full implementations filtered by tests. (This reverses the
original worktree-first/Stance-B-only-over-MCP plan — see the Evolution note in §2.3; the priority
became zero-friction interception of *every* prompt, including plain Q&A.)

### 2.2 "N-way merge" is the wrong mental model
We never mechanically 3-way-merge N divergent edit trees (that produces duplicate declarations
and contradictions that still compile). Reconciliation is **LLM-mediated best-of-N selection**,
with the **test suite as the ground-truth oracle** and the LLM judge scoped to *only* tie-break
test-passing survivors. Optional synthesis is treated as candidate N+1 and re-validated through
the oracle.

### 2.3 Transport — transparent proxy (primary) + MCP (heavy edits)
frites ships TWO transports over one shared engine, for different needs:

- **Transparent proxy / gateway (PRIMARY).** frites impersonates the model endpoint
  (`ANTHROPIC_BASE_URL` → frites for Claude Code; provider `base_url` → frites for Codex) and
  intercepts EVERY prompt with zero "use frites" friction. Best for answer/reasoning turns
  (Stance-A synthesis). Chosen primary because the goal is lowest-friction "handle everything."
  Cost: all metered (frites is the brain — no free interactive top-level). The recursion risk
  (children inheriting `ANTHROPIC_BASE_URL`) is handled by env-scrubbing every child. It drives the
  host's full agentic loop by emitting `tool_use` the host executes — verified editing real code
  end-to-end (§8).
- **MCP server / worktree mode (heavy multi-agent file edits).** `frites_implement` /
  `frites_apply` over stdio. Impersonation is the WRONG fit here — returning N candidate diffs +
  a comparison and running minutes-long worktree agents needs a tool call, not a single model turn
  — so Stance-B worktree work lives on the MCP surface.
- **CLI.** `frites run` / `frites config` call the same engine (testing / CI / power use).

(Evolution: MCP was first chosen as the *sole* transport for the worktree-first design; the
transparent proxy was added and made primary once the priority became zero-friction interception
of every prompt — including plain Q&A. Both are built.)

**MCP host quirks that are load-bearing (verified):**
- Progress notifications are **display-only — they do NOT extend either host's deadline.** Size
  timeouts to worst-case wall-clock up front.
- Claude Code: per-tool `timeout` (set `600000`), `alwaysLoad: true` so the tool isn't hidden
  behind Tool Search. Renders `notifications/progress` inline.
- Codex: `tool_timeout_sec` defaults to **60s — MUST be raised to 600** or every run dies.
- Result-size: Claude warns at ~10k tokens, hard-caps ~25k. Return compact `structuredContent`
  + `resource_link`s to each diff, never inline N full diffs.
- Do **not** depend on MCP `sampling` for the judge — Claude Code doesn't implement a sampling
  client and Codex explicitly refused to. Call models with frites's own credentials.

### 2.4 Child auth is ASYMMETRIC between providers (verified against this machine)
This is the most counter-intuitive finding. **Billing is decided by the invocation *surface*,
server-side — not by client identity.**

| Path | Works? | ToS | Notes |
|---|---|---|---|
| **Anthropic** OAuth-replay (raw sub token → `api.anthropic.com`) | ❌ dead | ❌ violation | Server-side validation since Jan 9 2026; 401 "only for use with Claude Code". Spoofing is defeated + banned. |
| **Anthropic** `claude -p` / Agent SDK (subprocess) | ✅ | ✅ sanctioned | Draws the **metered Agent-SDK credit** ($20 Pro / $100 Max5x / $200 Max20x, full API rates, no rollover, hard stop) as of 2026-06-15 — NOT interactive limits. |
| **Anthropic** API key (`sk-ant-api…`) | ✅ | ✅ clean | Per-token billed. Overflow target. |
| **OpenAI** OAuth-replay (`~/.codex/auth.json` → ChatGPT backend) | ✅ local | 🟡 grey-ok personal | `chatgpt.com/backend-api/codex/responses`, never `api.openai.com`. Hand-rolled HTTP. |
| **OpenAI** `codex exec` (subprocess) | ✅ | ✅ personal | Rides the ChatGPT plan's Codex limits. |
| **OpenAI** API key (`sk-…`) | ✅ | ✅ clean | Per-token billed. Overflow target. |

**Key consequence:** there is **no** way to get unlimited interactive-subscription limits for
*headless* fan-out, for anyone, by design. Emulating Claude Code to get the "unlimited" sub is
broken, ToS-banned, and pointless (the bucket is surface-based).

### 2.5 Two billing modes (and the chosen default)
Because of §2.4, where frites's calls land is decided by the surface:

1. **Interactive (cheapest, but higher friction):** your *real* Claude Code stays the brain on its
   interactive subscription limits and calls frites's MCP worktree tool only for deliberate heavy
   edits. Maximum free subscription usage; requires you at the session and to invoke the tool.
2. **Transparent / metered (the CHOSEN default — friction-first):** your Claude Code points at the
   gateway, so frites is the brain for *every* prompt. Children use your local subscriptions but
   programmatically → **metered** (Agent-SDK credit / ChatGPT plan), with API-key overflow. Zero
   friction; `fanOutPolicy` + per-turn cost telemetry keep spend in check.

The user chose (2) for UX (friction-over-cost). (1) remains available via the MCP path for
cost-sensitive heavy edits.

"Subscription-first → API-key overflow" lives in mode 2, understood correctly: for headless
Claude it's "Agent-SDK credit first, then key" — metered either way. frites owns the fallback
router because the vendors don't auto-fall-back.

### 2.6 Diversity comes from model-mix + prompt-framing, NOT temperature
Verified: neither `claude` nor `codex` exposes a `--temperature` flag. Candidate diversity (the
thing that justifies paying N×) must come from **mixing model families (claude × codex)** and
**prompt-framing** ("minimal change" vs "clean refactor"). Same-model fan-out ≈ near-duplicates.
Default toward **N=2 (1 claude + 1 codex)** until measured divergence justifies more.

### 2.7 Language: TypeScript, pnpm monorepo
I/O-bound orchestration glue around finicky wire formats; the official SDKs are TS-first; matches
the user's existing `apps/*`+`packages/*` pnpm monorepos. Go only if single-binary distribution
ever becomes a hard requirement.

### 2.8 Fan-out is scoped to the substantive turn — not every tool step, never housekeeping
The gateway sees one inbound request per host turn, and the host (Claude Code especially) runs a
long tool loop: one request to plan, one per tool round-trip, one to conclude. Fanning out a full
council on *every* one of those turns multiplies metered spend by the loop length for near-zero
added value on the mechanical steps (run this grep, read that file). Three rules keep the council
where it earns its cost:

- **`fanOutScope: first-turn` (default).** Fan out on the substantive *request* turn — the initial
  reasoning/planning — then drive the mechanical tool-loop continuations with a single agent. A task
  that takes N tool round-trips pays for **one** council, not N; fan-out re-engages on each new user
  request. `per-turn` restores fan-out on every allowed turn (max cross-checking, max spend).
- **Continuation detection is stateless.** A turn is a tool-loop continuation when the request
  carries a tool result back (Anthropic `tool_result` in the last user message / Responses
  `function_call_output`) — distinguishing "keep the loop going" from "fresh request" from the
  request *shape* alone, so it's correct across restarts and concurrent sessions with no server-side
  session memory.
- **Background/utility traffic never fans out.** The host emits cheap small/fast-model calls (haiku)
  for title generation, conversation summarization, and topic classification. frites pins these to
  a *single* child on the model the host asked for, tools or not — never a council. (Caveat:
  detection keys on the model name, so running the host itself on a haiku *main* model would read
  every turn as background.)

This is the per-turn lever for top risk #2 (cost is metered): `fanOutPolicy` decides *whether* a turn
is worth fanning out; `fanOutScope` + these rules decide *which* turns even get the question — together
bounding a long agentic task to a small, predictable number of councils. The progress channel emits a
closing **council recap** line per turn; the durable per-turn detail lives in the gateway log (the
in-editor thinking/reasoning channel is live-only and the host collapses it once the turn ends).

---

## 3. Architecture

Three layers, one transport-agnostic engine:

```
apps/                              # runnable tools (deployables / entry points)
  gateway/     @frites/gateway    TRANSPARENT PROXY (primary surface): impersonates /v1/messages
                                   (Claude Code) + /v1/responses (Codex); intercepts every prompt,
                                   answer/action-council fan-out per fanOutPolicy + fanOutScope (§2.8),
                                   SSE streaming, per-turn cost telemetry. Stance-A: synthesizes the
                                   assistant turn — emits host-executed tool_use on coding turns.
  mcp/         @frites/mcp        on-demand MCP tool surface (Stance B): frites_implement +
                                   frites_apply — heavy multi-agent file edits in worktrees → diffs
  cli/         @frites/cli        standalone `frites run` + `frites config` — same engine
packages/                          # libraries (no entry points)
  core/        @frites/core       engine (funnel) + oracle + judge + config + answer-council
  isolation/   @frites/isolation  git worktree lifecycle, diff capture, apply-to-branch
  agents/      @frites/agents      headless claude/codex runners + completions + cost estimation + EnvSandbox (recursion guard)

Two surfaces, one engine: the **gateway** is the frictionless everyday brain (Q&A/reasoning AND
coding edits, every prompt, metered); the **MCP** path is for deliberate heavy multi-agent file
edits in worktrees. `fanOutPolicy` (always|auto|necessary|never) tunes how aggressively the gateway
spends metered usage ("auto" uses a cheap LLM judge, skipping it on trivially-simple prompts), and
`fanOutScope` (first-turn|per-turn) bounds *which* turns of a request fan out (§2.8). The gateway
DOES drive coding turns with **no API key**: subscription `claude -p` children decide the next
action via `runActionCouncil` and the gateway constructs the `tool_use` envelope the host executes
(verified end-to-end — see §8). The standing ceiling is Codex `/v1/responses` `function_call`
emission, not yet built.
```

The **engine** is a state machine over a funnel and holds zero CLI/MCP coupling, so it's fully
unit-testable with mocked runners/oracle:

```
DISPATCH → EXECUTE (N children in worktrees, concurrent)
        → ORACLE-FILTER (run repo tests/build/lint per candidate)
        → reconcile:  1 survivor → done
                      0 survivors → [P5] one grounded feedback round → re-filter; else surface best near-miss
                      ≥2 survivors → JUDGE (pairwise tie-break, prefer smaller diff)
        → [P5] optional gated SYNTHESIS (re-validated through oracle)
        → PRESENT (recommended diff + per-candidate comparison)
        → APPLY (on approval: git switch -c frites/<runId> && git apply --3way)
```

### Data flow (interactive mode)
User in normal Claude Code: *"use frites to implement X"* → host calls `frites_implement`
`{task, repoPath, n?, agents?}` → engine resolves base commit, decides N, creates N worktrees,
`EnvSandbox` builds allowlist env (auth kept, base-URLs scrubbed, `FRITES_DEPTH++`),
`AgentRunner` spawns detached headless children that edit in isolation concurrently → engine
streams `notifications/progress` ("agent 2 editing app.ts / running tests") → capture each
`git diff --staged` → oracle filters → reconcile → return `structuredContent` + `resource_link`s
→ user reviews → `frites_apply {runId}` lands the diff on a fresh branch (the one mandatory
human gate).

---

## 4. Safety floor (non-negotiable, even in MVP)

Full-auto agents with bypassed permissions on a real repo: the isolation boundary is the only
control left.
- **Allowlist** child env (never copy `process.env`); keep only HOME/PATH/locale + auth.
- **Recursion guard:** scrub `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `CODEX_BASE_URL` /
  MCP config; `FRITES_DEPTH` fuse refuses to spawn above a threshold; children launched with
  `--strict-mcp-config` (claude) / `--ignore-user-config`-style isolation (codex) so they don't
  auto-load frites.
- **Secret denyRead:** `~/.ssh`, `~/.aws`, `.env` (via `@anthropic-ai/sandbox-runtime` in P4).
- **Sandbox:** `codex -s workspace-write`; wrap each agent in sandbox-runtime (default-deny
  egress, allowlist model + registry endpoints) in P4.
- **Land only via patch → human-reviewed diff → fresh branch.** Never auto-merge, never push.
- **Per-child** wall-clock timeout (group-kill the process tree) + `--max-budget-usd`.

---

## 5. Phased plan & LOE

Solo dev fluent in TS, on confirmed-working tooling. **+40% buffer** for the
minutes-per-iteration debug tax (every e2e run costs minutes + real metered credits).

| Phase | Goal | LOE |
|---|---|---|
| **P0 — Walking skeleton** | 1 agent, 1 worktree, real diff, env-scrub, keychain survives, apply-to-branch. **Spike the exact full-auto invocation for both CLIs + a 5-min MCP call in both hosts (go/no-go).** | ~1–2 wk |
| **P1 — Fan-out + 2nd backend** | N concurrent isolated agents (claude + codex), collect N diffs, diversity by model-mix + framing, **cost telemetry from here**. | ~1 wk |
| **P2 — Oracle + funnel (the moat)** | tests-as-oracle filter + pairwise tie-break → one vetted candidate + comparison. | ~1–1.5 wk |
| **★ Value gate** | On ~10 real tickets, fan-out+oracle must beat single-agent first-review-accept rate at acceptable cost. **If it fails, the thin slice IS the product.** | ~2–3 d |
| **P3 — MCP surface + apply gate** | drivable from the normal session, live progress, safe apply. (interactive mode) | ~1–1.5 wk |
| **P4 — Safety hardening + cost controls** | sandbox-runtime, budget caps, complexity-gated N, recursion fuse, Codex-as-host polish. | ~1 wk |
| **P5 — Quality lifts (optional, timeboxed)** | one grounded feedback round, independent acceptance-test gen, gated re-validated synthesis. | timebox+measure |

**Cumulative:** thin slice usable in ~1–2 wk · credible fan-out MVP ~4–6 wk · hardened v1 ~6–8 wk.

---

## 6. Top risks

1. **Reconciliation quality / verifier gap (HIGH):** fan-out raises the ceiling; a weak selector
   recovers little. → tests-as-oracle spine; LLM judge only tie-breaks survivors; be honest in UX
   when no tests discriminate ("vibes pick"). Gate fan-out behind a measured win.
2. **Cost is metered, not free (HIGH):** headless Claude burns the Agent-SDK credit then key;
   agents ~4× chat tokens. → tests-as-judge, single-survivor short-circuit, complexity-gated N,
   ≤1 feedback round, `--max-budget-usd`, telemetry from P1.
3. **Multi-minute latency UX (HIGH):** size host timeouts to worst-case (Codex 60s wall); stream
   rich progress; run children truly concurrently.
4. **Full-auto safety (HIGH):** see §4.
5. **Context propagation (MED):** isolation-cleaned children lack project CLAUDE.md → forward
   curated context in the prompt.
6. **Worktree/.git contention (MED):** pnpm shared store amortizes installs; clean up with
   `worktree remove --force` + `prune` even on crash; exclude node_modules/dist from diffs.

---

## 7. Open decisions (defaults chosen; revisit with data)

- Acceptance-test generation: rely on the repo's existing suite for MVP; add generation in P5.
- Default child mix: 3× Claude for P0–P2 to reduce variables, introduce Codex in P1 once the
  runner abstraction is stable; **then** default N=2 (1 claude + 1 codex) by measured divergence.
- Run artifacts: `.frites/` in-repo (gitignored) for locality + resource_link URIs.
- Two tools (`implement` returns diff, `apply` lands it) for an explicit human gate.
- Containers deferred to a P5 hardened mode; sandbox-runtime is the default boundary.

---

## 8. Current implementation status

Built and tested (67/67 unit tests; typecheck clean; live smoke against a real `claude` client):

- **apps/gateway** — transparent proxy: `/v1/messages` (Claude Code) + `/v1/responses` (Codex),
  SSE streaming, traffic classification, answer/action-council fan-out per `fanOutPolicy` with an
  LLM fan-out judge (heuristic short-circuit on trivial prompts), `fanOutScope` first-turn scoping
  (council on the request turn, single agent through the tool loop via stateless continuation
  detection) + background-model bypass (host haiku traffic never fans out; §2.8), per-turn cost
  telemetry (config-driven `pricing` estimation for backends that don't self-report cost, e.g.
  codex; §2.4) + a closing per-turn council recap line.
- **apps/mcp** — worktree tool: `frites_implement` + `frites_apply` (worktrees → tests-as-oracle
  → heuristic judge → vetted diff → apply-to-fresh-branch), progress notifications.
- **apps/cli** — `frites run` + `frites config` (init/show/get/set/unset/validate/path; global+repo layering).
- **packages**: `core` (engine funnel, oracle, judge, config, answer-council), `isolation`
  (WorktreeManager), `agents` (claude/codex runners + answer-only completions + `pricing` cost
  estimation + env sandbox: allowlist + recursion fuse).

GATEWAY CODE-EDITING WORKS (verified): on a coding turn frites emits the `tool_use`
(Read/Edit/Bash) the host executes — proven end-to-end (real `claude` → gateway → Read→Edit→answer,
bug fixed, `npm test` passed), **no API key** (subscription `claude -p` children decide the action
via `runActionCouncil`; the gateway constructs the `tool_use`). Remaining / not yet done: Codex
`/v1/responses` `function_call` emission (Anthropic `/v1/messages` tool_use is done); the value gate
(does fan-out quality beat a single agent on real tickets); sandbox-runtime wrap; LLM (vs heuristic)
synthesis/worktree judge; Linux/systemd `service`; the OpenAI OAuth-replay child.
