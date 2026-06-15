# frites evaluation & benchmarking

Two harnesses live here:

- **`value-gate.ts`** (`pnpm eval`) — frites-specific A/B: does fan-out beat a single agent on a
  handful of real coding fixtures, and is the extra cost worth it? Drives a real `claude` client
  against the gateway. Keep growing the fixture set.
- **`bench-matrix.ts`** (`pnpm bench`) — runs a *standard* agentic-coding harness against many frites
  configs **and** raw-model baselines on the **same** tasks, then tables accuracy + cost + latency so
  you can compare frites to normal models. This doc is its runbook.

## Results

frites is a **fusion panel**: it runs several coding agents and synthesizes one answer. The rows
below compare **solo** (a single agent, `fanOutPolicy: never`) against **fusion** (a 2–3 agent
council) on the same tasks — pick the setup that fits your quality / cost / latency budget.

> _Benchmark: Aider polyglot (Exercism exercises across 6 languages). Backend: frites child agents
> over OAuth/subscription. **Pending** — populated from the run dated `<run-date>` (`n = <N>` tasks);
> paste the `bench-matrix` table to fill in._

| config | type | agents | pass@1 | pass@2 | tok | cost($)\* | dur/case |
|---|---|---|---|---|---|---|---|
| `claude` | solo | 1× claude | — | — | — | — | — |
| `codex` | solo | 1× codex | — | — | — | — | — |
| `claude x2` | self-fusion | 2× claude | — | — | — | — | — |
| `codex x2` | self-fusion | 2× codex | — | — | — | — | — |
| `claude+codex` | fusion | claude + codex | — | — | — | — | — |
| `claude+2codex` | fusion | claude + 2× codex | — | — | — | — | — |

\*OAuth/subscription → `cost($)` is often `$0` (codex reports none); use `tok` as the usage metric.

**Reading it:** lean on **pass@2** (the stable signal — pass@1 and cost bounce with run-to-run
variance at small `n`). A fusion panel earns its extra tokens/latency only if it beats the best solo
agent by more than that variance.

### How this relates to model-leaderboard charts

A "fusion panel vs solo model" leaderboard (ensembles of Opus / GPT / Gemini / … beating any single
model) is the **same kind of comparison** this table makes — `claude+codex` is a two-model fusion and
`claude x2` / `codex x2` are self-fusion, exactly the categories such charts plot. It is **not
identical**:

1. **Benchmark** — those charts use their own task set; this uses Aider polyglot, so scores aren't
   cross-comparable — only the *shape* (fusion vs solo) transfers.
2. **"Solo" here is a single CLI agent** (Claude Code / Codex wrapping the model), not the bare model
   API. The true raw-model baseline is the `raw-opus` / `raw-gpt` conditions (`pnpm bench` *without*
   `--no-raw`) — they need API keys, so an OAuth-only run omits them.
3. **Model diversity** — frites's child kinds are `claude-cli` and `codex-cli` today, so it fuses
   Claude + GPT/Codex; it can't yet add Gemini/DeepSeek/Kimi panels.
4. **Metric** — those charts usually show one number (≈ single attempt); pass@1 is the closest match.

To reproduce a chart like that against raw models, run with the raw baselines included (drop
`--no-raw`) and report pass@1 as the headline.

> Every real run is **metered** — each request fans out to live child CLIs. Smoke-test wiring with
> `pnpm bench -- --dry-run` (no children spawned), then start with `--num-tests 5` before any full run.

---

## How frites connects to a harness

frites already *is* a model-provider endpoint, so harnesses point at it the way they'd point at a
self-hosted model. We use the **native Anthropic Messages** surface (`/v1/messages`): set the harness's
Anthropic base URL to the gateway and pass a dummy key.

`bench-matrix.ts` exports both `ANTHROPIC_BASE_URL` (Anthropic SDK / Inspect AI / simple-evals) and
`ANTHROPIC_API_BASE` (LiteLLM / Aider) pointing at the gateway, plus `ANTHROPIC_API_KEY=frites`
(auth is off by default — see [apps/gateway/src/index.ts](../apps/gateway/src/index.ts) `authorized()`).

### Five facts about frites that shape the setup (verified in the gateway source)

1. **Child model is chosen by config, not by the request.** `model = body.model ?? "frites"` is a
   label only ([index.ts](../apps/gateway/src/index.ts) `handleMessages`). The real model/mix comes
   from `config.defaultAgents`. **So you vary configs (and restart the gateway), not the `--model` flag.**
   `bench-matrix.ts` does exactly this per condition.
2. **Tool-use agentic loop works on `/v1/messages`, not `/v1/responses`.** With `tools.length > 0`
   the council returns one `tool_use` action with `stop_reason: "tool_use"`. The Responses surface is
   answer-only. So agentic/tool-loop benchmarks (SWE-bench) **must** use the Anthropic surface.
3. **A `model` containing `haiku`/`small`/`fast` short-circuits the council** to a single cheap agent
   (`isBackgroundModel`). The matrix uses `frites-council` for frites rows to avoid this.
4. **`maxTurns` defaults to 60 and force-stops a session.** Long tool-loop tasks would hit it and
   score an artificial failure, so frites conditions set `maxTurns: 200`.
5. **Sampling params are ignored, never rejected.** `max_tokens`/`temperature`/`stop` aren't read, so
   no harness request 400s — but you also can't sweep temperature (diversity = agent mix + framing).

### Cost-metric caveat

codex-cli against the ChatGPT backend **self-reports no cost**, so the gateway-log cost cross-check
(`gatewayCostUsd`) undercounts any council that includes codex. Treat the **harness's own `cost_usd`**
(e.g. aider's, which prices by tokens) as the source of truth. To make the gateway estimate codex
spend too, add a `pricing` block to the config keyed by the codex model id (see `ModelPricingSchema`
in [packages/core/src/config.ts](../packages/core/src/config.ts)).

---

## Phase 1 — Aider polyglot (recommended first)

Why first: text-edit based (no tool-loop — frites just returns formatted edits), and its public
leaderboard gives you raw-Opus/raw-GPT and published baselines for free while you run the same 225
problems locally for the frites conditions.

### One-time setup (Docker sandbox)

The benchmark runs model-generated solution code, so it runs inside aider's container — never on
your host. The adapter ([harness/aider-polyglot.sh](harness/aider-polyglot.sh)) drives that container
for you.

```bash
git clone https://github.com/Aider-AI/aider && cd aider
mkdir tmp.benchmarks
git clone https://github.com/Aider-AI/polyglot-benchmark tmp.benchmarks/polyglot-benchmark
./benchmark/docker_build.sh          # builds the `aider-benchmark` image
export AIDER_REPO=$(pwd)             # the adapter reads this
```

**Architecture (why two extra env vars):** the frites gateway runs on your **host** (its child
claude/codex CLIs need the host's OAuth/keychain); the benchmark runs in the **container**. The
container reaches the host gateway via `host.docker.internal`, which a `127.0.0.1`-bound server
refuses — so you must bind the gateway to all interfaces for the run:

```bash
export FRITES_BENCH_GATEWAY_HOST=0.0.0.0    # required for Docker mode (frites conditions)
```

The adapter rewrites the gateway URL to `host.docker.internal` and forwards creds into the container
automatically. Binding `0.0.0.0` exposes the gateway on your LAN for the run's duration; auth is off
by default, so set `FRITES_GATEWAY_TOKEN` if that matters on your network. For the `raw-opus` /
`raw-gpt` baselines, export real `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — they're forwarded into the
container and hit the real APIs (no gateway involved).

Optional adapter knobs (env): `AIDER_DOCKER_IMAGE` (default `aider-benchmark`), `AIDER_EDIT_FORMAT`
(default `whole`), `AIDER_THREADS` (default 2), `AIDER_TRIES` (default 2).

### Smoke test the wiring (free)

```bash
pnpm bench -- --dry-run              # exercises the matrix + gateway lifecycle, writes zeros
```

### First real run — validate edit format before spending

```bash
pnpm bench -- --combos claude --no-raw --num-tests 5     # one condition: single claude via OAuth
```

**Watch `well%` (percent well-formed).** frites's synthesizer must preserve aider's edit format; if
`well%` is low the pass-rate is capped by formatting, not reasoning — that's a frites synthesis fix,
not a benchmark result. Start with `AIDER_EDIT_FORMAT=whole` (easiest to emit); move to `diff` only
once whole-file looks solid. Keep `AIDER_THREADS` at 1–2 (each request fans out to a fleet of child
CLIs; high concurrency swamps the host and the children's OAuth rate limits).

### Comprehensive matrix — agent combos × auth

`pnpm bench` generates conditions from two axes plus the raw baselines:

- **Agent combinations** (`--combos`): the `AGENT_COMBOS` table in [bench-matrix.ts](bench-matrix.ts).
  Defaults: `claude`, `codex`, `claude+codex`, `claude x2`, `claude+codex+claude`. Single-agent combos
  run `fanOutPolicy: never`; multi-agent combos run `fanOutPolicy: always` with `defaultN` = the agent
  count. Edit the table to add combinations (more agents, per-agent `model`/`framing`).
- **Auth** (`--auth`): `oauth` (children use your host claude/codex subscription — no API key) vs
  `apikey` (gateway forwards `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` to children — metered); `both` runs
  each combo twice. Same models either way, so this is a **cost-visibility + rate-limit** axis, not a
  quality one — but it's the only way to get real per-token $ for frites (codex only reports cost on
  the API backend, not the ChatGPT/OAuth one).
- **Raw baselines**: `raw-opus`, `raw-gpt` (no gateway, real APIs). `--no-raw` skips them.

Condition names are `<combo> / <auth>` (e.g. `claude+codex / oauth`). Useful invocations:

```bash
pnpm bench                                                       # raw + all combos, OAuth, 225 problems
pnpm bench -- --auth both                                        # every combo under BOTH OAuth and API key
pnpm bench -- --combos 'claude,claude+codex' --auth both --no-raw  # focused A/B across both auth modes
pnpm bench -- --only 'claude / oauth,claude+codex / oauth'         # exact conditions by name
pnpm bench -- --combos claude+codex+claude --num-tests 25          # one big combo, quick subset
pnpm bench -- --combos 'claude,claude+codex' --price               # + estimate codex $ (see below)
```

For `apikey` mode and the raw baselines, export real keys first:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

**The `fanOutScope` axis** (`first-turn` vs `per-turn`) is fixed to `first-turn` here because it only
changes behavior on tool-loop continuation turns, which the tool-less Aider harness doesn't have —
both scopes are identical on Aider. It becomes a real cost/quality axis on the Phase 2
SWE-bench/Inspect tool-loop track (`per-turn` = a fresh council on every tool step).

Adapter knobs (env): `AIDER_REPO` (required), `AIDER_EDIT_FORMAT` (default `whole`), `AIDER_THREADS`
(default 2 — keep low; each request fans out to a fleet of child CLIs), `AIDER_TRIES` (default 2 → the
pass@2 column).

> The adapter writes a temp `--read-model-settings` YAML aliasing `anthropic/frites-council` so
> LiteLLM doesn't reject the unknown model name. Confirm the `--stats` key names (`pass_rate_1`,
> `pass_rate_2`, `percent_cases_well_formed`, `prompt_tokens`, `completion_tokens`, cost) against your
> aider version once: `./benchmark/benchmark.py --stats <run-dir>` — they drift between releases.

### Reading the result

Columns: `pass@1`/`pass@2` (quality — pass@2 is cumulative, ≥ pass@1), `well%` (edit-format
integrity), `tok` (prompt+completion — the comparable usage metric, since frites cost reads $0 under
OAuth/subscription), `cost($)` (gateway-measured spend for frites rows; aider's own number for raw
rows), `dur(s)` (wall-clock per condition).

**Cost attribution (`--price`):** frites's `cost($)` sums each child's spend from the gateway log.
claude self-reports cost (real even on subscription), but **codex reports nothing** on the
ChatGPT/OAuth backend — so a council's codex contribution shows as $0 by default. Add `--price` to
estimate codex (and any no-cost child) from per-model `$`/Mtoken rates, so `cost($)` reflects the
FULL council spend. Set the rate + codex model id in the `PRICING` / `CHILD_MODELS` tables in
[bench-matrix.ts](bench-matrix.ts), or via env (`FRITES_BENCH_CODEX_MODEL`, `FRITES_BENCH_CODEX_IN`,
`FRITES_BENCH_CODEX_OUT`) — the shipped rates are placeholders. ⚠️ `--price` **pins codex to that
model id**, so set it to a model your codex actually runs. Estimated costs show as `~$…` in the
gateway log; claude's reported cost is unaffected.

The question: does a council beat **its own best single member** *and* the raw model on `pass@2`, and
is the cost/latency/token premium worth it? `raw-opus`/`raw-gpt` anchor to published numbers; the
single-agent `claude / *` row separates the coordination tax from the model itself.

---

## Phase 2 — SWE-bench Verified via Inspect AI (gold-standard, heavier)

For the tool-loop agentic number. Inspect's Anthropic provider honors `ANTHROPIC_BASE_URL` natively,
it ships a `swe_bench` task + agent scaffold, and the tool-loop runs against frites's Messages
surface (fact #2). It's Docker-per-task over 500 tasks, so **subsample**. This is where the
`fanOutScope` toggle (`frites-council-firstturn` vs `frites-council-perturn`) actually diverges:
`per-turn` pays for a council on every tool step (max cross-checking, max spend), `first-turn` pays
for one council per task then runs a single agent through tool continuations.

To wire it into `bench-matrix.ts`, point `FRITES_BENCH_HARNESS` at an Inspect adapter that reads the
same env contract (`FRITES_BENCH_URL`, `FRITES_BENCH_MODEL`, `FRITES_BENCH_RESULT`) and emits the
results JSON — same pattern as `harness/aider-polyglot.sh`.

---

## Harness contract (for adding new harnesses)

`bench-matrix.ts` invokes `FRITES_BENCH_HARNESS` (default `harness/aider-polyglot.sh`) once per
condition with the gateway already up, and reads back a JSON file at `$FRITES_BENCH_RESULT`:

```json
{"pass_rate_1": 0, "pass_rate_2": 0, "percent_well_formed": 0, "cost_usd": 0, "n": 0, "notes": "..."}
```

Env the harness receives: `FRITES_BENCH_URL` (empty for passthrough baselines), `FRITES_BENCH_MODEL`,
`FRITES_BENCH_RESULT`, `FRITES_BENCH_NUM_TESTS`, `FRITES_BENCH_CONDITION`, and — for frites
conditions — `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_BASE` / `ANTHROPIC_API_KEY`.
