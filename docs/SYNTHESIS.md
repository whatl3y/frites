# frites Synthesis and Reconciliation

This document explains how frites turns multiple child-agent outputs into one user-facing result. There are two distinct paths in the repo, and they intentionally use different reconciliation strategies.

## Summary

frites does not mechanically merge multiple child outputs.

Depending on the surface, it either:

- asks an LLM synthesizer to produce one final answer from multiple child answers,
- asks an LLM synthesizer to select one proposed next tool/action for the host to execute, or
- filters full implementation candidates through build/test/lint oracles and recommends one complete diff.

The strongest verification is in the worktree implementation path, where candidate diffs are actually tested. The transparent gateway path improves answer/action quality through independent proposals and synthesis, then relies on the host tool loop to execute and validate selected actions.

Whether the transparent gateway fans out at all is itself gated by policy and prompt classification. In `auto` mode, frites first applies a heuristic; when the heuristic says fan-out might be useful, it asks a small LLM classifier to make the final fan-out decision for the current request.

## 1. Transparent Gateway Answer Synthesis

The normal answer path lives in `packages/core/src/answer-council.ts` and is wired into the gateway from `apps/gateway/src/index.ts`.

The main entry point is `runAnswerCouncil(prompt, deps)`.

Its flow is:

1. Decide whether the prompt should fan out.
2. If fan-out is disabled, call one child agent and return that answer directly.
3. If fan-out is enabled, call N child agents concurrently.
4. Give each child the user prompt, optionally with a configured framing.
5. Append the shared child directive to substantive prompts so children are told to reason exhaustively, inspect relevant context, and verify when changing code.
6. Collect all child answers.
7. Send the original question plus all child answers to the synthesizer.
8. Return only the synthesizer's final answer.

Child answers are collected with `Promise.all`, so the children run independently and concurrently. If one child fails, that failure is converted into a textual failure block so the synthesizer can still receive a complete set of inputs.

The answer synthesizer prompt tells the model to:

- produce one best, vetted answer,
- keep what the children agree on,
- adjudicate disagreements,
- drop unsupported or wrong claims,
- avoid mentioning that multiple responses existed,
- strip runtime artifacts such as sandbox or working-directory complaints,
- output only the final answer text.

There is no explicit voting algorithm, confidence score, source weighting system, or external verifier in this answer path. The final answer is an LLM-mediated synthesis over raw child responses.

## 2. Transparent Gateway Tool/Action Synthesis

Coding-agent turns with tools use `runActionCouncil` in `packages/core/src/agent-loop.ts`.

This path is stricter than answer synthesis because the output must be one concrete next action for the host agent.

Each child is prompted as a decision engine and must return exactly one JSON object:

- `{"kind":"tool", ...}` to ask the host to call a tool, or
- `{"kind":"answer", ...}` to finish with text.

The transcript is fenced as untrusted data so file contents, tool output, or prior model text cannot override the action-format instructions. Tool names are checked against the host-provided allowlist, and malformed JSON is parsed with a tolerant parser where possible.

When fan-out is enabled:

1. N children independently propose actions.
2. Each raw child reply is parsed into an `AgentAction`.
3. Hallucinated tool names are rejected against the available tool list.
4. The synthesizer receives the transcript, available tools, and the parsed proposals.
5. The synthesizer returns the single final action.

The key rule is that tool actions are selected, not merged:

- For a tool action, the synthesizer is instructed to select exactly one proposed tool call verbatim.
- It is instructed not to blend tool names or inputs from different proposals.
- For an answer action, it may synthesize freely.

That verbatim-selection rule is prompt-enforced rather than structurally enforced. The parser and validator reject malformed JSON and hallucinated tool names, but they do not prove that the final tool input is byte-for-byte identical to one child proposal. If a synthesizer blends two valid proposals into a valid allowlisted tool call, the deeper semantic check happens when the host executes the selected action and returns the result in the next turn.

If the final synthesized response looks tool-shaped but cannot be parsed, the system retries once with a stricter JSON-only suffix. If that still fails, it falls back to the best parse available or to plain answer text.

## 3. Gateway Runtime Behavior

`apps/gateway/src/index.ts` wires the answer and action councils into the transparent proxy.

Important runtime details:

- Child models are selected from `config.defaultAgents` by index.
- The synthesizer currently uses `config.defaultAgents[0]`; there is not a separate synthesizer model setting.
- Background or utility calls, such as title generation and summarization, are intended to stay single-agent and are detected heuristically from small/fast model names such as `haiku`, `small`, or `fast`.
- `fanOutScope` defaults to `first-turn`, so only the substantive initial request fans out. Later mechanical tool-loop continuation turns use one agent unless configured otherwise.
- For answer turns, only the synthesizer streams live into the final answer block.
- Child output normally goes to progress telemetry, not the user-facing answer.
- In interleaved progress mode, child output can be shown in the progress channel, but it is still separate from the final answer.

This means users normally see progress plus one final synthesized answer, not a visible debate between child agents.

## 4. Worktree/MCP Implementation Reconciliation

The MCP and CLI implementation path uses `packages/core/src/engine.ts`. This is the heavy-edit path behind `frites_implement` and the CLI runner.

This path is not answer synthesis. It is candidate selection over complete implementation attempts.

Its flow is:

1. Select N agents from the task or config.
2. Resolve the base commit.
3. Create one isolated git worktree per agent.
4. Run each child agent in its own worktree.
5. Capture each candidate diff.
6. Run configured or auto-detected oracle commands such as build, lint, and test.
7. Reconcile the candidates into one recommendation.
8. Return structured run results to the MCP/CLI caller; that caller persists diffs and run metadata for review and later application.

The reconciliation algorithm is implemented in `reconcile`:

1. Ignore candidates that errored, timed out, were empty, or touched no files.
2. If no usable candidates exist, return `near-miss` with no recommendation.
3. If no oracle commands exist, pick a best-effort winner using `heuristicJudge`.
4. If oracle commands exist, keep only candidates whose oracle passed.
5. If no candidates passed, surface the closest near-miss using `heuristicJudge` over usable candidates.
6. If exactly one candidate passed, recommend it.
7. If multiple candidates passed, use `heuristicJudge` to break the tie.

`heuristicJudge` lives in `packages/core/src/judge.ts`. It ranks candidates by smallest changed-line count, then by fewest files touched. This is a deterministic smallest-blast-radius tie-breaker.

The architecture docs mention a future or broader design where an LLM judge tie-breaks test-passing candidates and optional synthesis can become candidate N+1. The current implementation does not do that yet. Today, the worktree path is oracle filtering plus deterministic heuristic selection.

## 5. What “Best Output” Means Today

The meaning of “best” depends on the path.

For plain answer turns, best means the synthesizer model's final adjudicated response from multiple child answers.

For tool/action turns, best means the synthesizer model's selected next action. Tool calls are instructed to be selected verbatim from one child proposal, while final answer text may be synthesized freely.

For worktree implementation runs, best means the candidate that passes the executable oracle, with deterministic smallest-diff tie-breaking when multiple candidates pass.

## 6. Strengths

The gateway answer path is useful for open-ended reasoning because independent children can surface different explanations, risks, or approaches before the synthesizer writes one final response.

The gateway action path is safer than free-form tool synthesis because tool names are allowlisted, structured JSON is required, and tool calls are steered toward selection from real child proposals rather than invention by blended arguments.

The worktree path has the strongest correctness signal because candidates are actual diffs tested against real build, lint, and test commands.

## 7. Limitations and Edge Cases

The answer synthesizer receives raw child answers, not structured claims with provenance, confidence, or machine-checked evidence. It can reject weak claims only by reasoning over the responses.

The action synthesizer can still choose a poor action if all child proposals are poor. The system validates tool names and JSON shape, but deeper semantic validation usually happens when the host executes the selected tool and returns the result in the next turn.

The action synthesizer's no-blending rule is not mechanically audited against the proposal set after synthesis. It is an instruction backed by JSON parsing and tool-name allowlisting, not a byte-for-byte membership check of the final tool input.

Child failures are intentionally included as inputs rather than aborting the whole council. This improves resilience but requires the synthesizer to ignore failure artifacts correctly.

Background and utility turn suppression depends on model-name heuristics. It is reliable for the configured small/fast model labels, but it is not a separate explicit request-type field.

The current worktree path does not synthesize a merged diff from multiple candidates. It recommends one complete candidate diff. This avoids the risks of mechanical N-way code merges, such as duplicated declarations, incompatible partial solutions, and changes that compile only accidentally.

## Bottom Line

frites synthesis is not N-way merge.

The transparent gateway uses policy-gated fan-out, LLM-mediated synthesis for answers, and LLM-mediated selection for tool actions. The MCP/CLI implementation path uses test/build/lint oracles plus deterministic tie-breaking to recommend one complete candidate diff.

That separation is intentional: lightweight gateway synthesis keeps normal interaction friction low, while heavier worktree reconciliation provides stronger verification when the user wants competing full implementations reviewed before applying a diff.
