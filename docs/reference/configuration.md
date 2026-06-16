# Configuration

frites is configured by a JSON file managed with `frites config` — no
hand-editing required. This page is the canonical reference for every key and its
default. The schema lives in `packages/core/src/config.ts`.

## Layering

frites reads `.frites/config.json` in the repository, layered over
`~/.frites/config.json` (global), layered over the built-in schema defaults. The
effective precedence is:

```text
defaults  <  global (~/.frites/config.json)  <  repo (.frites/config.json)
```

A repo value overrides the same key from global, which overrides the default.
Inspect the merged result and its sources with `frites config show`; print the
file paths and write target with `frites config path`. See the
[CLI reference](cli.md) for the full `frites config` subcommand list.

## Selection and fan-out

| Key | Type | Default | Meaning |
|---|---|---|---|
| `fanOutPolicy` | `"always" \| "auto" \| "necessary" \| "never"` | `"auto"` | How aggressively the gateway fans out to a council: `always` on every main turn; `auto` decides per-prompt; `necessary` only for clearly hard/contested prompts; `never` runs a single agent. See [Fan-out policy](../concepts/fan-out-policy.md). |
| `fanOutScope` | `"first-turn" \| "per-turn"` | `"first-turn"` | Which turns within one request may fan out. `first-turn` fans out only on the substantive request turn, then runs a single agent through the mechanical tool-loop continuation turns; `per-turn` fans out on every allowed turn. See [Fan-out scope](../concepts/fan-out-scope.md). |
| `defaultN` | integer `1`–`5` | `2` | Default number of children when a task doesn't specify. Capped at 5 in v1. |
| `defaultAgents` | array of `AgentSpec` | claude-1 + codex-1 (see below) | Which agents and models to consult. Order is load-bearing — see [the slot-0 note](#slot-0-is-the-synthesizer-and-child-0). |

The default `defaultAgents`:

```json
[
  { "id": "claude-1", "kind": "claude-cli",
    "framing": "Make the smallest correct change that satisfies the task." },
  { "id": "codex-1", "kind": "codex-cli",
    "framing": "Prefer a clean, well-structured solution." }
]
```

Each `AgentSpec` accepts `id`, `kind` (`"claude-cli"` or `"codex-cli"`), and the
optional `model`, `framing`, `maxBudgetUsd`, `timeoutMs`, `hardTimeoutMs`, and
(codex only) `reasoningEffort`.

## Per-child guardrails

| Key | Type | Default | Meaning |
|---|---|---|---|
| `perChildBudgetUsd` | positive number | `2` | Per-child spend cap. |
| `perChildTimeoutMs` | positive integer | `600000` (10 min) | Idle timeout: a child is reaped only after this long with no output, not this long after spawn. The countdown resets on every chunk the child streams. The oracle reuses this value as a per-command wall-clock cap on build/test/lint. |
| `perChildHardTimeoutMs` | positive integer | unset (off) | Optional absolute wall-clock ceiling: kills a child this long after spawn regardless of activity. Off by default. |

## Synthesis

The synthesis stage applies to the worktree path (`frites_implement` / `frites
run`). After children run and the oracle filters them, frites can ask one
synthesizer agent to integrate the strongest passing candidates into a single
diff, captured from git and verified by the same oracle. See
[Synthesis and reconciliation](../concepts/synthesis-and-reconciliation.md) for
the design rationale and reconciliation policy.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `synthesisMode` | `"off" \| "passing-only"` | `"passing-only"` | `passing-only` synthesizes when at least `synthesisMinCandidates` candidates pass the oracle, falling back to the best child on any failure. `off` is winner-take-one with no extra synthesizer spend. |
| `synthesisAgent` | `AgentSpec` | unset | The agent that performs synthesis. When omitted, frites uses the first claude child among the selected agents (claude enforces `--max-budget-usd`, so `synthesisBudgetUsd` bites there), falling back to the first selected agent. |
| `synthesisMinCandidates` | integer `≥ 2` | `2` | Minimum oracle-passing candidates required before synthesis runs. |
| `synthesisMaxDiffChars` | positive integer | `60000` | Cap (chars) on the combined non-seed candidate diffs embedded in the synthesis prompt; over the cap, a diff is replaced with its file list and the read-only worktree path. |
| `synthesisMaxBlastFactor` | positive number | `1.5` | The synthesized diff is preferred only when its changed-line count is `≤` this factor × the combined changed-line count of the passing inputs. Past that, frites keeps the best original passing child. |
| `synthesisTimeoutMs` | positive integer | unset → falls back to `perChildTimeoutMs` | Idle timeout for the synthesizer. |
| `synthesisHardTimeoutMs` | positive integer | `1800000` (30 min) | Absolute wall-clock ceiling for the synthesizer. Unlike `perChildHardTimeoutMs`, this ships a concrete default because synthesis is a single serialized tail step where a hard bound is cheap and high-value. |
| `synthesisBudgetUsd` | positive number | unset → falls back to `perChildBudgetUsd` | Spend cap for the synthesizer. Enforced as a hard cap only for claude synthesizers (`--max-budget-usd`); advisory for codex (the hard timeout is the real ceiling there). |

## Cost telemetry

| Key | Type | Default | Meaning |
|---|---|---|---|
| `pricing` | record of `model id` → `{ inputPerMtok, outputPerMtok, cachedInputPerMtok?, cacheWritePerMtok? }` | unset | Optional per-model token rates (in $ per million tokens) used to estimate a child's spend when its backend reports none — so codex on the ChatGPT backend shows a comparable cost instead of looking free. Lookup is exact-match first, then a prefix match. Omit to disable estimation. See [Pricing](pricing.md) and [Cost telemetry](../concepts/cost-telemetry.md). |

`ModelPricing` fields: `inputPerMtok` (uncached input), `outputPerMtok` (output,
reasoning-inclusive), `cachedInputPerMtok` (cache reads; defaults to
`inputPerMtok`), and `cacheWritePerMtok` (cache writes, claude only; defaults to
`inputPerMtok`).

## Progress and logging

| Key | Type | Default | Meaning |
|---|---|---|---|
| `streamProgress` | boolean | `true` | Stream live council progress back to the prompting client during long council turns on the host's thinking/reasoning channel. |
| `progressDetail` | `"telemetry" \| "interleaved"` | `"telemetry"` | How much per-child detail rides the progress channel. `telemetry` shows per-agent state + live token/elapsed/cost counters and completion summaries; `interleaved` also streams each child's actual output live, line-buffered and agent-prefixed. The env var `FRITES_PROGRESS_DETAIL` overrides this when set. |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Gateway log verbosity. The env var `FRITES_LOG_LEVEL` overrides this when set. See [Logging](logging.md). |

## Other keys

These keys are part of the schema but are documented in detail elsewhere:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `oracle` | `{ build?, test?, lint?, autoDetect }` | `{ autoDetect: true }` | Build/test/lint commands for the worktree oracle; auto-detected from `package.json` scripts when none are given. See [Worktree oracle](../concepts/worktree-oracle.md). |
| `maxDepth` | integer `≥ 1` | `1` | Recursion fuse: refuse to spawn children when `FRITES_DEPTH` would exceed this. |
| `maxTurns` | positive integer | `60` | Per-session safety cap on agentic turns the gateway drives before forcing a stop. |
| `passApiKeys` | boolean | `false` | Headless/metered mode: pass `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` through to children. Default false is subscription-first; the env var `FRITES_PASS_API_KEYS=1` also enables it. See [Auth and billing](../product/auth-and-billing.md). |
| `childDirective` | string | the shipped thoroughness directive | Woven into every substantive child prompt so all backends analyze and execute exhaustively. Set to `""` to disable. |
| `codexReasoningEffort` | `"minimal" \| "low" \| "medium" \| "high"` | `"high"` | Codex children's reasoning depth, injected as `-c model_reasoning_effort="<v>"`. A per-agent `AgentSpec.reasoningEffort` overrides it. `minimal` is not safe with the stock codex model. |

## Slot-0 is the synthesizer and child-0

`defaultAgents` order is load-bearing. `defaultAgents[0]` doubles as the
synthesizer that merges the council — there is no separate synthesizer setting in
the default path — and children round-robin the whole list, so slot 0 is also
child index 0. Reorder the list to change which agent synthesizes, keeping in
mind that the same slot is then also the first child. (Setting an explicit
`synthesisAgent` overrides which agent synthesizes without changing the child
order.)

## See also

- [CLI](cli.md) — the `frites config` subcommands.
- [Fan-out policy](../concepts/fan-out-policy.md) and [Fan-out scope](../concepts/fan-out-scope.md).
- [Synthesis and reconciliation](../concepts/synthesis-and-reconciliation.md).
- [Cost telemetry](../concepts/cost-telemetry.md) and [Pricing](pricing.md).
- [Worktree oracle](../concepts/worktree-oracle.md).
- [Logging](logging.md) and [Environment variables](environment-variables.md).
