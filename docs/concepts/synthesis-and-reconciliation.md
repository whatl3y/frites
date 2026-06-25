# Synthesis & reconciliation

frites turns several child-agent outputs into one user-facing result. It does **not** mechanically merge those outputs. Depending on the surface, it either asks an LLM synthesizer to write one final answer, asks an LLM synthesizer to select one next tool/action for the host to execute, or filters complete implementation candidates through build/lint/test oracles and recommends one whole diff.

The strongest verification lives in the worktree implementation path, where candidate diffs are actually tested. The transparent gateway path improves answer and action quality through independent proposals plus synthesis, then relies on the host tool loop to execute and validate the selected action.

## The three reconciliation strategies

Each surface intentionally uses a different strategy, because "best" means something different on each.

| Surface | Inputs | How one result is chosen | What "best" means |
|---|---|---|---|
| Gateway answer turns | N raw child answers | LLM-mediated **synthesis** into one answer | The synthesizer's final adjudicated response |
| Gateway tool/action turns | N parsed `AgentAction` proposals | LLM-mediated **selection** of one next action | The synthesizer's selected next action (tool calls selected verbatim; answer text synthesized freely) |
| Worktree implementation runs | N complete candidate diffs | Build/lint/test **oracle filtering** + deterministic tie-break, with optional synthesis | The candidate that passes the executable oracle, smallest-diff tie-break when several pass |

The deep internals of how the engine drives these stages (event model, failure modes, synthesis-engine shape) live in [../architecture/core-engine.md](../architecture/core-engine.md). Every `synthesis*` config key is documented in [../reference/configuration.md](../reference/configuration.md).

## Gateway answer synthesis (LLM-mediated)

For plain answer turns, children run independently and concurrently; their answers are sent, alongside the original question, to a synthesizer that produces one vetted answer. The synthesizer prompt tells the model to keep what the children agree on, adjudicate disagreements, drop unsupported or wrong claims, avoid mentioning that multiple responses existed, strip runtime artifacts (sandbox/working-directory complaints), and output only the final answer text.

There is no explicit voting algorithm, confidence score, source weighting, or external verifier in this path. The final answer is normally an LLM-mediated synthesis over raw child responses. A failing child is converted into a textual failure block rather than aborting the council; if every child fails, frites returns an explicit failure instead of spending a synthesizer call. If synthesis itself fails after at least one usable child response, frites falls back to a surviving child answer. This council brain lives in `packages/core/src/answer-council.ts`.

## Gateway tool/action selection (no blending)

Coding-agent turns with tools are stricter, because the output must be one concrete next action for the host. Each child is prompted as a decision engine and must return exactly one JSON object: `{"kind":"tool", ...}` to call a host tool, or `{"kind":"answer", ...}` to finish with text. The transcript is fenced as untrusted data so file contents, tool output, or prior model text cannot override the action-format instructions.

The key rule is that **tool actions are selected, not merged**:

- For a tool action, the synthesizer is instructed to select exactly one proposed tool call verbatim and must not blend tool names or inputs from different proposals.
- For an answer action, it may synthesize freely.

That no-blending rule is **prompt-enforced**, backed by a tolerant JSON parser and a tool-name allowlist, not a byte-structural membership check of the final tool input against the proposal set. The parser and validator reject malformed JSON and hallucinated tool names, but they do not prove the final input is byte-for-byte identical to one child proposal. The deeper semantic check happens when the host executes the selected action and returns the result on the next turn.

Whether the gateway fans out at all is itself gated by policy and prompt classification (see [fan-out-policy.md](fan-out-policy.md)), and which turns are eligible is set by [fan-out-scope.md](fan-out-scope.md). Background and utility calls (title generation, summarization, topic detection) are kept single-agent and are detected heuristically from small/fast model names such as `haiku`, `small`, or `fast`; this is a model-name heuristic, not a separate explicit request-type field.

## Worktree reconciliation (oracle-filtered candidate selection)

The MCP/CLI implementation path is candidate selection over complete implementation attempts, not answer synthesis. Each child runs in its own isolated git worktree, its diff is captured from git, and configured (or auto-detected) build/lint/test oracle commands run against each candidate. The reconciler then ignores unusable candidates, keeps only oracle-passers, and, when several pass, breaks the tie with a **deterministic heuristic, not an LLM judge**: smallest changed-line count, then fewest files touched. This is covered in detail on [worktree-oracle.md](worktree-oracle.md).

### Synthesis stage (on by default)

When `synthesisMode` is `"passing-only"` (the default) and at least `synthesisMinCandidates` (default 2) candidates pass the oracle, a synthesis stage runs after oracle filtering and before final reconciliation. It only affects the worktree path, never the gateway. Set `synthesisMode: "off"` to restore pure winner-take-one.

1. A fresh worktree is created from the same base SHA and **seeded** with the best passing candidate's diff (via `git apply --3way`), so the synthesizer refines a known-good tree rather than reconstructing the agreed core. It falls back to fresh-from-base if the seed cannot apply.
2. One synthesizer agent (the first claude child by default, so `--max-budget-usd` is honored) integrates the other passing candidates' deltas, using their diffs and read-only worktrees as **source material, never as mandatory patches**. It is never a mechanical merge.
3. The synthesized result is captured from git like any candidate and run through the **same** oracle.
4. The synthesized candidate is preferred only when it passes that oracle **and** its blast radius stays within `synthesisMaxBlastFactor ×` the combined size of the passing inputs. Otherwise frites falls back to the best original passing candidate and records why.

## Design rationale

### Gate the preference; passing is not enough

Preferring synthesis is deliberately gated. The reconcile contract defines "best" as *smallest blast radius among oracle-passers*, and oracles are frequently weak or partial: `detectOracle` returns `{}` with no `package.json`, and a "pass" can be a single lint command exiting 0. Preferring a usually-larger synthesis on the sole evidence that it cleared the same bar the children already cleared would invert the smallest-blast-radius stance exactly when the oracle is least trustworthy. So synthesis is preferred only when it (a) passes the same full oracle **and** (b) its blast radius does not exceed `synthesisMaxBlastFactor ×` the combined size of the passing inputs (default factor `1.5`). This is the project's core "better output, slower" tradeoff applied to reconciliation (see [../architecture/risks-and-tradeoffs.md](../architecture/risks-and-tradeoffs.md)).

### Seed from the best passing candidate

Rather than building fresh-from-base and reconstructing the agreed core from capped prose, the synthesis worktree is created from the base SHA and seeded with the best passing child's diff. The synthesizer then starts from a known-good tree and only integrates deltas; the other passing trees stay alive on disk and are exposed read-only, so embedded diffs are a capped convenience, not the sole source. If the seed fails to apply, frites falls back to fresh-from-base.

### Fall back to the best original passing child

If the synthesized candidate produces no usable change, fails the oracle, or exceeds the blast-radius ceiling, frites keeps the best original passing candidate and records the fallback reason. The result reports whether synthesis was attempted, its inputs, whether it passed, and any fallback reason. A reviewer can still land a tighter passing child instead via `frites_apply … candidateId=<agent>` (or `frites "…" --apply-candidate <id>`).

## Non-goals

- No naive automatic hunk or N-way mechanical merge as the primary strategy: mechanical merges risk duplicated declarations, incompatible partial solutions, and code that compiles only accidentally.
- The synthesis stage never mutates a child candidate worktree.
- The synthesized result is never applied to the user's current branch automatically, and the `frites_apply` clean-working-tree gate is never weakened.
- Synthesizer prose is never treated as authoritative; the synthesized result must be captured from git.
- A synthesized candidate that has not passed the oracle is never recommended when at least one original candidate passed.

## Bottom line

frites synthesis is not N-way merge. The transparent gateway uses policy-gated fan-out, LLM-mediated synthesis for answers, and LLM-mediated selection for tool actions. The MCP/CLI implementation path uses test/build/lint oracles plus deterministic tie-breaking, optionally refined by a re-verified synthesis pass, to recommend one complete candidate diff. That separation is intentional: lightweight gateway synthesis keeps normal interaction friction low, while heavier worktree reconciliation provides stronger verification when the user wants competing full implementations reviewed before applying a diff.
