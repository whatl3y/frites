# Data flow

frites has two surfaces over one shared engine, and they have distinct end-to-end flows. The gateway intercepts every prompt and synthesizes the assistant turn; the MCP worktree path runs N competing full implementations and reconciles them into one vetted diff. This page traces both.

The two flows differ at the front but share the same core shape: **request → continuation/fan-out decision → children → oracle/synthesis → result.**

## Gateway request flow

The gateway sees one inbound request per host turn (`POST /v1/messages` for Claude Code, `POST /v1/responses` for Codex). Its flow:

1. **Classify the traffic.** Background/utility calls (host haiku traffic for title generation, summarization, classification) are pinned to a single child and never fan out.
2. **Detect continuation.** A turn is a tool-loop continuation when the request carries a tool result back: an Anthropic `tool_result` in the last user message, or a Responses `function_call_output`. This is stateless: it is read from the request *shape* alone, so it is correct across restarts and concurrent sessions with no server-side session memory.
3. **Decide whether to fan out.** `fanOutScope` (default `first-turn`) bounds *which* turns even get the question: fan out on the substantive request turn, then drive the mechanical tool-loop continuations with a single agent. `fanOutPolicy` (`always | auto | necessary | never`) decides *whether* an allowed turn is worth fanning out; under `auto` a heuristic short-circuits trivial prompts and an LLM fan-out judge makes the final call. See [Fan-out scope](../concepts/fan-out-scope.md).
4. **Run the council.**
   - **Answer turns** call `runAnswerCouncil`: N children answer independently and concurrently (collected with `Promise.all`; a failed child becomes a textual failure block so the synthesizer still gets a complete input set), then the synthesizer adjudicates one final answer.
   - **Coding turns** call `runActionCouncil`: N children each propose exactly one next action as JSON, hallucinated tool names are rejected against the host allowlist, and the synthesizer selects one action verbatim.
5. **Stream the result.** Over SSE: for answer turns only the synthesizer streams into the final answer block; on a coding turn the gateway encodes the selected action as a host-executed `tool_use` (`stop_reason: "tool_use"`). The host executes the tool under its own permission model and returns the result, which arrives as the next continuation turn (step 2). Each turn carries per-turn cost telemetry and a closing council recap line.

The synthesizer is `config.defaultAgents[0]` invoked with `role: "synth"`; children round-robin the same array. The reconciliation rules are canonical in [Synthesis & reconciliation](../concepts/synthesis-and-reconciliation.md). The proxy design is in [Gateway](gateway.md).

## MCP / worktree implementation flow

The worktree path is candidate selection over complete implementation attempts, not answer synthesis. Starting from the normal session:

1. **Invoke.** User in normal Claude Code says *"use frites to implement X"* → the host calls `frites_implement {task, repoPath, n?, agents?}`.
2. **Set up.** The engine resolves the base commit, decides N, and creates N isolated git worktrees. The `EnvSandbox` builds an allowlist env per child (auth kept, base-URLs scrubbed, `FRITES_DEPTH` incremented).
3. **Execute children.** `AgentRunner` spawns detached headless children that edit in isolation concurrently. The engine streams `notifications/progress` ("agent 2 editing app.ts / running tests").
4. **Capture diffs.** Each candidate's work is captured as `git diff --staged`.
5. **Oracle-filter.** Run the configured or auto-detected oracle commands (build, lint, test) per candidate. Candidates that errored, timed out, were empty, or touched no files are dropped.
6. **Reconcile.**
   - One passing candidate → recommend it.
   - Zero passing candidates → surface the closest near-miss via `heuristicJudge` (or one grounded feedback round, then re-filter).
   - Multiple passing candidates → tie-break with `heuristicJudge` (smallest changed-line count, then fewest files).
7. **Optional synthesis.** When `synthesisMode` is `"passing-only"` (default) and at least `synthesisMinCandidates` candidates pass, a synthesizer agent integrates the passing deltas in a fresh worktree seeded with the best passing candidate's diff, then the result is re-run through the **same** oracle and preferred only if it passes and stays within `synthesisMaxBlastFactor ×` the combined input size. See [Synthesis & reconciliation](../concepts/synthesis-and-reconciliation.md).
8. **Present.** Return `structuredContent` plus a `resource_link` to each diff; the caller persists diffs and run metadata. The user reviews the recommended diff and per-candidate comparison.
9. **Apply.** `frites_apply {runId}` lands the diff on a fresh branch (`git switch -c frites/<runId> && git apply --3way`), the one mandatory human gate. It accepts a `candidateId` to land a tighter passing child instead.

## How the two flows relate

Both flows follow **request → continuation/fan-out decision → children → oracle/synthesis → result**, but the verification depth differs:

| | Gateway | MCP / worktree |
|---|---|---|
| Children produce | One proposed answer or next action each | A complete implementation (diff) each |
| Verifier | Host tool loop executes the selected action and returns the result next turn | Repo build/lint/test oracle runs against each candidate |
| Reconciliation | LLM synthesis (answers) / verbatim selection (actions) | Oracle filter + deterministic smallest-diff tie-break + optional gated synthesis |
| Result | Streamed assistant turn | Recommended diff + comparison, applied on approval |

The gateway keeps everyday interaction friction low; the worktree path provides the strongest correctness signal because candidates are actual diffs tested against real commands. See [Risks & tradeoffs](risks-and-tradeoffs.md) for the "better output, slower" tradeoff.

## Related pages

- [Gateway](gateway.md): the proxy surface.
- [MCP worktree mode](mcp-worktree-mode.md): the worktree surface.
- [Core engine](core-engine.md): the shared engine state machine and event model.
- [Fan-out scope](../concepts/fan-out-scope.md): which turns fan out.
- [Synthesis & reconciliation](../concepts/synthesis-and-reconciliation.md): how outputs are reconciled.
