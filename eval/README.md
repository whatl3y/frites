# frites evaluation & benchmarking

> This is the canonical runbook for the evaluation harnesses. For a short orientation within the
> docs site, see [development/evaluation.md](../docs/development/evaluation.md).

Three harnesses live here:

- **`value-gate.ts`** (`pnpm eval`) — frites-specific A/B: does fan-out beat a single agent on a
  handful of real coding fixtures, and is the extra cost worth it? Drives a real `claude` client
  against the gateway. Keep growing the fixture set.
- **`bench-matrix.ts`** (`pnpm bench`) — runs a *standard* agentic-coding harness against many frites
  configs **and** raw-model baselines on the **same** tasks, then tables accuracy + cost + latency so
  you can compare frites to normal models. Measures **gateway answer fusion** (a blind LLM merge of
  child text — no verification). This doc is its runbook.
- **`worktree-matrix.ts`** (`pnpm wbench`) — runs the **worktree engine** directly (not the gateway)
  on the polyglot exercises: N full child implementations in isolated git worktrees, an executable
  oracle (the exercise's own tests, run in Docker) filtering them, then `synthesisMode` synthesis
  from the passing candidates with a guarded fallback. Measures **oracle-gated worktree synthesis** —
  frites's highest-value fusion path, the one `pnpm bench` does **not** exercise. See
  [Worktree synthesis benchmark](#worktree-synthesis-benchmark-pnpm-wbench).

## Results

frites is a **fusion panel**: it runs several coding agents and synthesizes one answer. The rows
below compare **solo** (a single agent, `fanOutPolicy: never`) against **fusion** (a 2–3 agent
council) on the same tasks — pick the setup that fits your quality / cost / latency budget.

> _Benchmark: Aider polyglot (Exercism exercises across 6 languages). Backend: frites child agents
> over OAuth/subscription, **gateway answer-path synthesis** (a blind LLM merge of all child answers —
> NOT the oracle-gated worktree synthesis; see [which synthesis this measures](#which-synthesis-this-measures)).
> Run dated **2026-06-16**, **`n = 25`** tasks/condition, `whole` edit format, OAuth (no API keys),
> raw baselines omitted._

| config | type | agents | pass@1 | pass@2 | tok | cost($)\* | dur/case |
|---|---|---|---|---|---|---|---|
| `claude` | solo | 1× claude | 68% | **100%** | 237.6k | 25.88 | 67.8s |
| `codex` | solo | 1× codex | 64% | 92% | 346.0k | 0.00 | 217.1s |
| `claude x2` | self-fusion | 2× claude | **72%** | **100%** | 118.8k | 53.87 | 120.4s |
| `codex x2` | self-fusion | 2× codex | 64% | **100%** | 116.1k | 0.00 | 200.1s |
| `claude+codex` | fusion | claude + codex | 60% | 92% | 428.9k | 83.57 | 225.0s |
| `claude+2codex`† | fusion | claude + 2× codex | 68% | 96% | 127.4k | n/a | n/a |

\*OAuth/subscription → `cost($)` is often `$0` (codex reports none); use `tok` as the usage metric.
Raw pass counts of 25: pass@1 = 17/16/18/16/15/17, pass@2 = 25/23/25/25/23/24 (rows in table order).
†`claude+2codex`'s post-run stats step hit a `spawnSync ETIMEDOUT`, so `bench-matrix` errored its row;
pass-rates + well% were recovered from aider's own `.stats` (the run finished all 25 tasks), but
gateway cost and per-case duration were not captured. Re-run that one condition for a clean figure.

**Reading it:** lean on **pass@2** (the stable signal — pass@1 and cost bounce with run-to-run
variance at small `n`). A fusion panel earns its extra tokens/latency only if it beats the best solo
agent by more than that variance.

#### What this run found

- **No reliable quality lift from fusion.** Every pass@1 difference is 1–3 problems out of 25 — inside
  the ~±13pp two-proportion noise band at this `n`, so none is statistically significant. The best
  pass@1 (`claude x2`, 72%) is a single problem above `claude` solo (68%).
- **Cross-model fusion trended *worse*, not better.** `claude+codex` posted the lowest pass@1 (60%) and
  a below-ceiling pass@2 (92%) at the **highest cost ($83.57, ~3.2× `claude` solo)** — beaten on both
  quality metrics by plain `claude` solo. `claude+2codex` only clawed back *to* `claude`-solo parity.
- **One positive: self-fusion closed a gap.** `codex x2` lifted codex's pass@2 from 92% → **100%**, and
  `claude x2` had the top pass@1 plus cleaner formatting (well% 84% → 92%) than `claude` solo.
- **A ceiling caps the signal.** `claude` solo already hits **100% pass@2**, so no fusion can show value
  on pass@2 here. Measuring fusion's real value needs *harder* tasks where solo pass@2 < 100%.
- **Bottom line (this path):** on Aider polyglot, blind-synthesis fusion costs ~2–3× for no quality gain
  above noise — a **failing grade for the value-gate as measured here.** See the caveat below for why
  this is *not* the last word.

#### Which synthesis this measures

This table exercises the **gateway answer path** (`runAnswerCouncil` → `buildSynthesisPrompt`): aider
sends tool-less whole-file edits, so frites does a **blind LLM merge of *all* child answers** with no
verification. That path has a known failure mode — a wrong child can drag a correct child's answer down
in the merge, the likely cause of the `claude+codex` regression. It is **not** the oracle-gated worktree
synthesis (`synthesisMode: passing-only`, the MCP path), which runs your tests *first*, merges only
**passing** candidates, and re-verifies — and so cannot score below the best passing child. **Measuring
that path needs a worktree-mode harness (the task's tests as a per-task oracle), which this run does not
include.** Read these numbers as a verdict on transparent-proxy *answer* synthesis, not on frites's
oracle-verified synthesis.

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

## Worktree synthesis benchmark (`pnpm wbench`)

`pnpm bench` (above) measures the gateway's blind answer fusion. `pnpm wbench`
(`eval/worktree-matrix.ts`) measures the path that actually distinguishes frites: **oracle-gated
worktree synthesis**. It calls `runEngine` directly — no gateway, no `/v1/messages` — and for each
polyglot exercise it:

1. Materializes the exercise as an **isolated git repo** (solution stub + tests committed; the
   reference solution in `.meta/` is withheld).
2. Runs N child agents in **isolated git worktrees** (real `claude`/`codex` on the host, over your
   OAuth subscription).
3. **Filters by an executable oracle** — the exercise's own test suite, run **inside the
   `aider-benchmark` Docker image** so generated code never executes on your host. Canonical tests
   are restored before each run so an agent can't edit them to pass.
4. With `synthesisMode: "passing-only"`, **synthesizes** from the oracle-passing candidates, re-runs
   the **same** oracle against the synthesized diff, and recommends it only when the synthesis
   guardrails allow — otherwise falls back to the best original passer.

Unlike the gateway benchmark, the recommended answer here is **test-verified**, and (best-of-passing)
it cannot score below the best passing child. It reports fusion-specific metrics: final pass rate,
original candidate pass count, the reconcile `decision`, and synthesis attempted / recommended /
fell-back counts.

**Prereqs:** the same polyglot setup as Phase 1 (clone + `docker_build.sh`), Docker running, and
`claude`/`codex` logged in. The case repos are created under `~/.frites-wbench` (Docker-mountable);
override with `FRITES_WBENCH_DIR`. Point at the polyglot checkout with `FRITES_WBENCH_POLYGLOT` if it
isn't at `~/aider/tmp.benchmarks/polyglot-benchmark`.

```bash
pnpm wbench --dry-run --num-tests 5 --langs python   # FREE: self-test the Docker oracle against the
                                                     #   reference solution (must PASS) before spending
pnpm wbench --combos claude+3codex --synthesis passing-only --num-tests 25 --langs python
pnpm wbench --combos claude,codex,claude+codex --synthesis both --num-tests 25 --langs python
```

Flags: `--combos` (`claude`, `codex`, `claude+codex`, `claude+2codex`, `claude+3codex`); `--synthesis`
(`off` | `passing-only` | `both` — single-agent combos always run `off`); `--num-tests`; `--langs`
(`python` default — most reliable; also `rust`, `go`, `javascript`, `cpp`, `java`); `--concurrency`
(default 1 — each case already runs N agents in parallel); `--keep` (retain case repos for
inspection). Every non-dry run is **metered**. Start with `--dry-run` then a small `--num-tests`.

### Results

> _Worktree engine, oracle-gated synthesis. Run dated **2026-06-16**, **`n = 25`** Python polyglot
> exercises, OAuth (no API keys). First validation run of `pnpm wbench` — a single condition, no
> baseline yet._

| condition | agents | pass\* | synth (att/rec/fb) | err | cost($)† | dur/case |
|---|---|---|---|---|---|---|
| `claude+3codex [synth:on]` | 1 claude + 3 codex | **100%** (25/25) | 25 / 25 / 0 | 0 | 16.01 | 166s |

\*pass = the FINAL recommended candidate verified by the oracle (best passing child, or the
synthesized candidate when it's recommended). †claude's self-reported spend only (its child + the
synthesizer); the 3 codex children report no cost on the OAuth backend, so true spend is higher.

**What it shows — and the ceiling caveat.** Synthesis ran on all 25 cases, passed the oracle, and was
recommended over the best original passer every time (**0 fallbacks**); the oracle also filtered a
failing child on one case (`book-store`, 3/4 passed). This **validates the worktree-synthesis path end
to end and shows synthesis is _safe_** — it never regressed below the best passer and stayed within the
blast-factor guard. It does **not** yet show synthesis is _better_: on Python polyglot all four children
individually pass in 24/25 cases, so a binary oracle has no headroom to reveal an improvement (the same
ceiling the `pnpm bench` run hit, now as a pass ceiling). A real value signal needs **(a)** a solo /
`--synthesis off` baseline on the same tasks and **(b)** harder tasks/languages where children fail more
often (`--langs rust,go,cpp`) — that's where synthesis-from-partial-passers can demonstrably fix what no
single child got right.

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
