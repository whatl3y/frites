# frites — Deferred Tasks

This file tracks implementation plans that are intentionally not part of the current committed scope but are detailed enough to pick up later.

---

## Add Gemini Provider Support

Status: planned, not implemented.

Goal: add Gemini support alongside existing Claude and Codex children without destabilizing the gateway or MCP worktree paths.

### Recommended Approach

Ship Gemini in two stages:

1. Add `gemini-api` first as an internal council child for gateway answer/action synthesis.
2. Consider `gemini-cli` later for answer-only or worktree execution after a real CLI behavior spike proves it can run unattended safely.

API-first is the safer initial path because Google documents the Node SDK (`@google/genai`) and streaming/function-calling APIs. Gemini CLI currently needs local validation before it is safe to use as an unattended child runner: stdin behavior, `stream-json` schema, approval prompts, sandboxing, write behavior, and timeout behavior are not enough to rely on from docs alone.

### Current Architecture Touchpoints

Provider support is currently centered on `ChildKind = "claude-cli" | "codex-cli"`, mirrored through config schemas, parser helpers, CLI/MCP agent parsing, and the agents package dispatch layer.

Likely files to change:

- `packages/core/src/types.ts`
- `packages/core/src/config.ts`
- `packages/core/src/config-io.ts`
- `packages/agents/src/completion.ts`
- `packages/agents/src/env-sandbox.ts`
- `packages/agents/src/index.ts`
- `apps/cli/src/index.ts`
- `apps/mcp/src/runtime.ts`
- `apps/gateway/src/index.ts` only if gateway dispatch assumptions are hard-coded
- `README.md`
- `docs/ARCHITECTURE.md`

Likely new file:

- `packages/agents/src/gemini-api.ts`

Possible later file:

- `packages/agents/src/gemini.ts` for a Gemini CLI runner, after the spike

### Implementation Plan

1. Add `"gemini-api"` to `ChildKind` and `AgentSpecSchema`.
2. Update config loading, validation, examples, CLI/MCP `parseAgents`, and docs so users can opt into Gemini manually.
3. Add `@google/genai` to the agents package.
4. Implement a Gemini API completion adapter that returns the existing `CompletionResult` shape and emits normalized `ChildEvent` events.
5. Wire `runCompletion()` to dispatch `gemini-api`.
6. Reuse existing gateway answer/action council behavior. Gemini should initially return text or JSON action proposals; do not implement native Gemini host tool calling in v1.
7. Add environment handling for `GEMINI_API_KEY`, possibly `GOOGLE_API_KEY`, and optional Vertex variables while respecting `passApiKeys`.
8. Add a README config example such as:

```json
{
  "id": "gemini-1",
  "kind": "gemini-api",
  "model": "<user-selected-gemini-model>"
}
```

9. Keep Gemini out of default agents until typecheck, unit tests, and an opt-in live smoke are stable.
10. Spike Gemini CLI separately before any `gemini-cli` implementation.

### API Design Notes

Use the existing provider-neutral shapes rather than adding Gemini-specific gateway logic.

For streaming, choose one Google API surface deliberately and fixture-test it:

- `generateContentStream` is enough for text-only answer support if chunks expose text and usage reliably.
- Interactions streaming may be better if native Gemini function calling becomes a goal, but it has a different event model.

Do not mix both paths casually.

For tool calls, v1 should keep using the existing frites action-council protocol: children produce a JSON action proposal, the gateway parses it, and the host executes the resulting tool call. Native Gemini function declarations can come later if needed.

For cache/cost, only populate cache-read/cache-write usage fields when Gemini exposes metadata that clearly maps to frites's existing semantics. Do not guess cache behavior.

### Auth And Environment

Initial API mode should support:

- `GEMINI_API_KEY`
- possibly `GOOGLE_API_KEY`
- `GOOGLE_GENAI_USE_VERTEXAI`
- `GOOGLE_CLOUD_PROJECT`
- other Vertex env only if explicitly supported by the chosen SDK path

Keep the existing secret-minimization posture: API keys are withheld unless `passApiKeys` or `FRITES_PASS_API_KEYS=1` allows them.

If Gemini SDKs support endpoint override variables, add them to the recursion/base-URL scrub list before enabling them in child environments.

### Tests

Unit tests to add or update:

- Config accepts `gemini-api`.
- CLI/MCP agent parsing recognizes Gemini aliases if aliases are added.
- Env sandbox withholds Gemini credentials by default and passes them only when configured.
- Gemini stream parser handles text deltas, final text, usage metadata, unknown events, and malformed chunks.
- Pricing works with Gemini model IDs through the existing config-driven pricing table.
- Answer council works with mixed Claude, Codex, and Gemini children.
- Action council accepts a Gemini child returning JSON with surrounding prose or code fences.

Integration tests:

- Mock Gemini SDK streams for deterministic tests.
- Add an opt-in live smoke gated by `GEMINI_API_KEY`.
- Gateway smoke with `defaultAgents` containing one Gemini child and `fanOutPolicy: never` or another low-cost setting.
- Later, capture Gemini CLI `--output-format stream-json` fixtures before implementing CLI support.

Verification after implementation:

```sh
pnpm typecheck
pnpm test
```

Run the live Gemini smoke only when credentials are present.

### Gemini CLI Spike Checklist

Before adding `gemini-cli`, verify locally:

- `gemini -p` behavior with large prompts.
- Whether prompt input can come from stdin without argv limits.
- `--output-format json` and `--output-format stream-json` schemas.
- Whether output schemas are stable enough for fixtures.
- Non-interactive approval and sandbox flags.
- Whether answer-only mode can prevent writes.
- Whether worktree mode can edit unattended without prompting.
- Timeout and process-group termination behavior.
- Auth modes: OAuth, API key, and Vertex.

Do not add `gemini-cli` to default worktree agents until this is proven.

### Risks

- Gemini model IDs and API surfaces may change quickly; avoid hard-coded defaults and stale pricing.
- Gemini streaming APIs differ by endpoint family; parser tests need real fixtures or faithful mocks.
- Gemini CLI may prompt, hang, or mutate files unexpectedly without a proven unattended contract.
- API mode is less subscription-reuse-friendly than existing Claude/Codex CLI paths.
- Native Gemini function calling could overcomplicate v1; the existing JSON action protocol is enough for initial support.

---

## Restructure Docs for GitBook Sync

Status: planned, not implemented.

Goal: restructure the documentation under `docs/` so it can be synced cleanly into GitBook, while preserving the information currently spread across the root `README.md`, existing `docs/` files, and repo/service structure.

### Desired Outcome

- GitBook can sync directly from the `docs/` directory.
- `docs/SUMMARY.md` owns the GitBook navigation order.
- `docs/README.md` becomes the GitBook landing page.
- The root `README.md` remains a concise GitHub/npm landing page and links into the full docs.
- Existing documentation content is preserved, split into focused pages, and cross-linked.
- Every user-facing mode, service, package, and major concept has a clear documentation home.
- Existing external links to old docs files should not break during the first migration pass.

### Recommended Directory Structure

```text
docs/
  README.md
  SUMMARY.md
  assets/
    frites.jpg

  getting-started/
    installation.md
    configure-claude-code.md
    configure-codex.md
    first-run.md
    service-management.md

  product/
    overview.md
    gateway-mode.md
    mcp-worktree-mode.md
    auth-and-billing.md
    safety-model.md
    status-and-limits.md

  concepts/
    council-of-agents.md
    fan-out-policy.md
    fan-out-scope.md
    synthesis-and-reconciliation.md
    worktree-oracle.md
    cost-telemetry.md

  reference/
    cli.md
    configuration.md
    gateway-api.md
    mcp-tools.md
    environment-variables.md
    logging.md
    pricing.md

  architecture/
    overview.md
    gateway.md
    mcp-worktree-mode.md
    core-engine.md
    agents-and-runners.md
    isolation.md
    data-flow.md
    risks-and-tradeoffs.md

  services/
    gateway.md
    mcp-server.md
    cli.md
    core.md
    agents.md
    isolation.md

  development/
    repository-structure.md
    local-development.md
    testing.md
    evaluation.md
    release-and-packaging.md

  roadmap/
    current-status.md
    deferred-tasks.md
    gemini-provider.md
```

### GitBook Conventions

- Use one H1 per file.
- Use lowercase kebab-case filenames.
- Use relative links only.
- Keep images under `docs/assets/`.
- Make `docs/SUMMARY.md` the canonical navigation file.
- Avoid large catch-all pages; overview pages should link to focused detail pages.
- Prefer linking to canonical reference pages over duplicating large config tables across many pages.
- Keep page titles stable after migration to reduce future GitBook churn.

### Source Content to Migrate

#### Root `README.md`

Split the current README into focused docs pages:

- Product summary and positioning -> `product/overview.md`
- Install and use -> `getting-started/installation.md`
- Claude Code setup -> `getting-started/configure-claude-code.md`
- Codex setup -> `getting-started/configure-codex.md`
- Common commands -> `reference/cli.md`
- Service management -> `getting-started/service-management.md`
- Watching progress and gateway logs -> `reference/logging.md`
- Configuration overview and table -> `reference/configuration.md`
- Auth and billing -> `product/auth-and-billing.md`
- Heavy code edits / MCP worktree mode -> `product/mcp-worktree-mode.md` and `reference/mcp-tools.md`
- Repository structure -> `development/repository-structure.md`
- Status and limits -> `product/status-and-limits.md` and `roadmap/current-status.md`
- Safety -> `product/safety-model.md`

After migration, rewrite the root `README.md` to stay concise:

- Logo and short product description.
- One-paragraph explanation of gateway mode and MCP worktree mode.
- Minimal install quickstart.
- Minimal Claude Code and Codex configuration snippets.
- Most common commands.
- Current status snapshot.
- Links to `docs/README.md`, `docs/SUMMARY.md`, and the main product/reference pages.

#### `docs/ARCHITECTURE.md`

Split architecture content into:

- `architecture/overview.md` for system shape and high-level decisions.
- `architecture/gateway.md` for transparent proxy design, `/v1/messages`, `/v1/responses`, SSE, action synthesis, tool-call emission, and progress streaming.
- `architecture/mcp-worktree-mode.md` for Stance B, worktree execution, candidate diffs, oracle filtering, and apply flow.
- `architecture/core-engine.md` for dispatch, oracle, reconciliation, config, answer council, and engine boundaries.
- `architecture/agents-and-runners.md` for Claude/Codex runners, completions, child directives, pricing, timeout behavior, and environment sandbox integration.
- `architecture/isolation.md` for git worktree lifecycle, diff capture, apply-to-branch, and cleanup assumptions.
- `architecture/data-flow.md` for gateway request flow and MCP implementation flow.
- `architecture/risks-and-tradeoffs.md` for top risks, hardening gaps, value gate, cost model, latency, and transport tradeoffs.
- `product/auth-and-billing.md` for verified auth asymmetry and subscription/API-key implications.
- `product/safety-model.md` for permission posture and blast-radius controls.
- `roadmap/current-status.md` for implementation status and remaining work.

Leave `docs/ARCHITECTURE.md` as a compatibility stub during the first pass, pointing to the new architecture pages, rather than deleting it immediately.

#### `docs/SYNTHESIS.md`

Move the main content into `concepts/synthesis-and-reconciliation.md`.

Cross-link implementation-specific details from:

- `architecture/core-engine.md`
- `architecture/gateway.md`
- `product/gateway-mode.md`
- `product/mcp-worktree-mode.md`

Preserve these key points:

- frites does not mechanically merge multiple child outputs.
- Gateway answer turns use LLM-mediated synthesis.
- Gateway action turns use LLM-mediated selection of a single next action.
- Worktree/MCP runs filter complete candidate diffs through build/lint/test oracles.
- Current worktree tie-breaking is deterministic heuristic selection, not an LLM judge.
- The no-blending rule for tool actions is currently prompt-enforced and parser/allowlist-backed, not byte-for-byte structurally enforced.
- Background/utility suppression depends on model-name heuristics.

Leave `docs/SYNTHESIS.md` as a compatibility stub during the first pass.

#### `docs/TASKS.md`

Split future-facing tasks into:

- `roadmap/deferred-tasks.md` for the general deferred task index.
- `roadmap/gemini-provider.md` for the Gemini provider support plan.
- This GitBook docs restructuring task should also be represented in `roadmap/deferred-tasks.md` once the migration is performed.

Leave `docs/TASKS.md` as a compatibility stub or keep it as the deferred-task source until the restructure is completed.

#### `eval/README.md`

Move or summarize evaluation documentation into `development/evaluation.md`.

Decision to make during implementation:

- If `eval/` is meant to remain independently usable, keep `eval/README.md` and make `development/evaluation.md` link to it with a concise explanation.
- If GitBook should be the primary docs home, migrate the full eval README content into `development/evaluation.md` and leave a short pointer in `eval/README.md`.

### Pages to Add or Fill

#### Getting Started

- `getting-started/installation.md`: prerequisites, `npm install -g @frites/cli`, `frites install`, supported OS assumptions, Node version, and service behavior.
- `getting-started/configure-claude-code.md`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, expected new-session behavior, and gateway URL.
- `getting-started/configure-codex.md`: `model_provider`, `base_url`, `wire_api`, `env_key`, `FRITES_KEY`, and gateway URL.
- `getting-started/first-run.md`: first successful gateway request, what progress looks like, what a council recap means, and how to confirm the gateway is reachable.
- `getting-started/service-management.md`: install, status, restart, stop/uninstall, alternate port, launchd/systemd behavior, and compatibility with `frites service ...` commands.

#### Product

- `product/overview.md`: what frites is, what problem it solves, gateway vs MCP modes, and when to use each.
- `product/gateway-mode.md`: transparent proxy, everyday Q&A/reasoning/code edits, host-executed tool calls, fan-out behavior, progress stream, and limitations.
- `product/mcp-worktree-mode.md`: competing full implementations, worktree isolation, tests-as-oracle, diff review, `frites_apply`, and when this mode is better than gateway mode.
- `product/auth-and-billing.md`: subscription-first behavior, Claude Agent-SDK credit, Codex ChatGPT usage, optional API-key overflow, cost visibility differences, and why interactive subscription limits cannot be reused for unlimited headless fan-out.
- `product/safety-model.md`: headless child posture, host permission model boundaries, gateway answer-only restrictions, worktree apply gate, env allowlist, recursion guard, API-key withholding, local bind, and current hardening gaps.
- `product/status-and-limits.md`: what is working, tested status, known gaps, value gate status, Codex function-call emission status, sandbox/runtime hardening status, and realistic limitations.

#### Concepts

- `concepts/council-of-agents.md`: independent child agents, synthesizer, default agent ordering, model mix, prompt framing, and why diversity is not temperature-based.
- `concepts/fan-out-policy.md`: `always`, `auto`, `necessary`, `never`, LLM classifier role in `auto`, and cost implications.
- `concepts/fan-out-scope.md`: `first-turn`, `per-turn`, stateless continuation detection, background/utility traffic bypass, and why first-turn is the default.
- `concepts/synthesis-and-reconciliation.md`: migrated and refined synthesis/reconciliation explanation.
- `concepts/worktree-oracle.md`: tests/build/lint as oracle, candidate filtering, near-miss behavior, heuristic tie-breaker, and no N-way mechanical merge.
- `concepts/cost-telemetry.md`: per-child counters, cost reporting, estimated vs authoritative spend, pricing table behavior, and council recap.

#### Reference

- `reference/cli.md`: document `frites install`, `status`, `logs`, `restart`, `stop`, `uninstall`, `gateway`, `config`, and standalone `frites "implement X"` usage.
- `reference/configuration.md`: document config layering and all keys currently documented in README: `fanOutPolicy`, `fanOutScope`, `defaultN`, `defaultAgents`, `perChildBudgetUsd`, `perChildTimeoutMs`, `pricing`, `streamProgress`, `progressDetail`, and `logLevel`.
- `reference/gateway-api.md`: document `/v1/messages`, `/v1/responses`, SSE/progress behavior, live answer streaming, tool-call emission, traffic classification, and known Codex function-call limitation.
- `reference/mcp-tools.md`: document `frites_implement`, `frites_apply`, Claude Code MCP registration, Codex MCP registration, timeout requirements, result-size constraints, progress behavior, and apply branch behavior.
- `reference/environment-variables.md`: document relevant gateway, config, logging, progress, auth, recursion, and child environment variables.
- `reference/logging.md`: document `frites logs`, `~/.frites/gateway.log`, log levels, JSON logs, durable turn detail, and difference between live progress and gateway logs.
- `reference/pricing.md`: document config-driven model pricing, authoritative vs estimated cost, prefix/exact model matching, cache fields, and display semantics for estimated spend.

#### Architecture

- `architecture/overview.md`: repo-level architecture and key decisions.
- `architecture/gateway.md`: transparent proxy internals.
- `architecture/mcp-worktree-mode.md`: MCP/worktree internals.
- `architecture/core-engine.md`: shared engine and reconciliation internals.
- `architecture/agents-and-runners.md`: child runner architecture and provider behavior.
- `architecture/isolation.md`: worktree isolation and apply lifecycle.
- `architecture/data-flow.md`: request/response flows for gateway and MCP.
- `architecture/risks-and-tradeoffs.md`: current risks, known hardening gaps, and tradeoffs.

#### Services

Every app/package gets a page:

- `services/gateway.md`: `apps/gateway`, `@frites/gateway`, transparent proxy role, endpoints, progress, logging, and service behavior.
- `services/mcp-server.md`: `apps/mcp`, `@frites/mcp`, MCP tools, runtime, and worktree mode.
- `services/cli.md`: `apps/cli`, `@frites/cli`, command surface, config management, service install, and standalone run.
- `services/core.md`: `packages/core`, engine, oracle, judge, config, answer council, agent loop, and exported types.
- `services/agents.md`: `packages/agents`, Claude/Codex runners, completions, pricing, env sandbox, and timeouts.
- `services/isolation.md`: `packages/isolation`, worktree manager and apply-to-branch behavior.

#### Development

- `development/repository-structure.md`: monorepo layout and responsibilities for `apps/*` and `packages/*`.
- `development/local-development.md`: install dependencies, common pnpm commands, running gateway/MCP/CLI locally, and config files used during development.
- `development/testing.md`: `pnpm typecheck`, `pnpm test`, package tests, live smoke tests, and when to run them.
- `development/evaluation.md`: migrate or link eval README content.
- `development/release-and-packaging.md`: npm packages, package responsibilities, build artifacts, and publish/service upgrade expectations if available from package metadata.

#### Roadmap

- `roadmap/current-status.md`: current implementation status and known remaining work.
- `roadmap/deferred-tasks.md`: deferred task index.
- `roadmap/gemini-provider.md`: migrated Gemini support plan.

### Implementation Plan

1. Create `docs/README.md` and `docs/SUMMARY.md` first so GitBook has a landing page and navigation file.
2. Create the directory skeleton exactly or close to the proposed structure.
3. Move and split existing README/docs content into focused files without changing meaning.
4. Add missing reference and service pages based on the README, package metadata, and source layout.
5. Rewrite the root `README.md` into a concise landing page after the full docs exist.
6. Leave compatibility stubs for `docs/ARCHITECTURE.md`, `docs/SYNTHESIS.md`, and `docs/TASKS.md` during the first migration pass to avoid broken external links.
7. Decide whether `eval/README.md` remains the canonical eval doc or becomes a pointer to `docs/development/evaluation.md`.
8. Search for stale internal links and update them to the new page locations.
9. Verify every markdown link resolves.
10. Confirm every topic from the old README and docs has a new home.

### Suggested `docs/SUMMARY.md` Shape

```md
# Summary

- [Overview](README.md)

## Getting Started

- [Installation](getting-started/installation.md)
- [Configure Claude Code](getting-started/configure-claude-code.md)
- [Configure Codex](getting-started/configure-codex.md)
- [First Run](getting-started/first-run.md)
- [Service Management](getting-started/service-management.md)

## Product

- [Overview](product/overview.md)
- [Gateway Mode](product/gateway-mode.md)
- [MCP Worktree Mode](product/mcp-worktree-mode.md)
- [Auth and Billing](product/auth-and-billing.md)
- [Safety Model](product/safety-model.md)
- [Status and Limits](product/status-and-limits.md)

## Concepts

- [Council of Agents](concepts/council-of-agents.md)
- [Fan-Out Policy](concepts/fan-out-policy.md)
- [Fan-Out Scope](concepts/fan-out-scope.md)
- [Synthesis and Reconciliation](concepts/synthesis-and-reconciliation.md)
- [Worktree Oracle](concepts/worktree-oracle.md)
- [Cost Telemetry](concepts/cost-telemetry.md)

## Reference

- [CLI](reference/cli.md)
- [Configuration](reference/configuration.md)
- [Gateway API](reference/gateway-api.md)
- [MCP Tools](reference/mcp-tools.md)
- [Environment Variables](reference/environment-variables.md)
- [Logging](reference/logging.md)
- [Pricing](reference/pricing.md)

## Architecture

- [Overview](architecture/overview.md)
- [Gateway](architecture/gateway.md)
- [MCP Worktree Mode](architecture/mcp-worktree-mode.md)
- [Core Engine](architecture/core-engine.md)
- [Agents and Runners](architecture/agents-and-runners.md)
- [Isolation](architecture/isolation.md)
- [Data Flow](architecture/data-flow.md)
- [Risks and Tradeoffs](architecture/risks-and-tradeoffs.md)

## Services

- [Gateway](services/gateway.md)
- [MCP Server](services/mcp-server.md)
- [CLI](services/cli.md)
- [Core](services/core.md)
- [Agents](services/agents.md)
- [Isolation](services/isolation.md)

## Development

- [Repository Structure](development/repository-structure.md)
- [Local Development](development/local-development.md)
- [Testing](development/testing.md)
- [Evaluation](development/evaluation.md)
- [Release and Packaging](development/release-and-packaging.md)

## Roadmap

- [Current Status](roadmap/current-status.md)
- [Deferred Tasks](roadmap/deferred-tasks.md)
- [Gemini Provider](roadmap/gemini-provider.md)
```

### Verification Plan

- Run a markdown link check over `README.md`, `docs/**/*.md`, and any retained `eval/**/*.md` files.
- Search for stale references to:
  - `docs/ARCHITECTURE.md`
  - `docs/SYNTHESIS.md`
  - `docs/TASKS.md`
- Confirm retained compatibility stubs point to the new canonical pages.
- Confirm `docs/SUMMARY.md` includes every intended page and no missing files.
- Confirm every old README/docs topic maps to exactly one canonical new page, with cross-links where needed.
- Confirm image references still resolve after GitBook sync, especially `docs/assets/frites.jpg`.
- For pure markdown restructuring, link validation is the main required check.
- Run `pnpm typecheck` and `pnpm test` only if source-adjacent docs, examples, package metadata, or command snippets are changed in ways that could affect code expectations.

### Acceptance Criteria

- `docs/README.md` exists and works as the GitBook landing page.
- `docs/SUMMARY.md` exists and defines a complete, ordered GitBook navigation tree.
- The root `README.md` is shorter and points users to full docs.
- Existing content from `README.md`, `docs/ARCHITECTURE.md`, `docs/SYNTHESIS.md`, `docs/TASKS.md`, and `eval/README.md` is preserved or intentionally linked.
- Every app and package has a service page.
- Product, concept, architecture, reference, development, and roadmap docs are separated cleanly.
- Old high-value links are either updated or backed by compatibility stubs.
- Markdown links validate.
- No stale internal links remain.

---

## Synthesize Winning Implementation From Multiple Passing Child Diffs

Status: planned, not implemented.

Goal: improve MCP/worktree implementation quality by allowing frites to combine the strongest ideas from multiple successful child-agent implementations into one synthesized, oracle-verified final candidate, instead of always recommending a single child diff unchanged.

### Current Behavior

The current worktree engine is intentionally conservative and winner-take-one.

Execution path:

1. `runEngine()` selects child agents with `selectAgents()`.
2. The engine resolves a shared base commit with `worktrees.resolveBase()`.
3. Each child runs through `runOneAgent()` in parallel.
4. `runOneAgent()` creates a separate git worktree for each child by calling `worktrees.create(repoPath, runId, agentId, baseSha)`.
5. The child process receives a prompt built by `buildPrompt()` and runs with `cwd` set to its own worktree.
6. The child may inspect files, run commands, and edit files inside that isolated worktree.
7. After the child exits, `worktrees.captureDiff()` stages the worktree and captures the actual git diff plus touched files.
8. Candidate metadata stores the captured diff, touched files, status, summary, log path, cost, and token usage.
9. `runOracleFor()` runs configured build/test/lint commands inside each candidate worktree.
10. `reconcile()` chooses one candidate as the recommendation.

Important implementation points:

- Child output text is not trusted as the implementation result. The authoritative implementation is the git diff captured from the child worktree.
- `WorktreeManager.captureDiff()` runs `git add -A`, then reads `git diff --staged --no-color` and `git diff --staged --name-only`.
- Usable candidates must have `status === "succeeded"` and at least one touched file.
- If no oracle commands exist, `reconcile()` picks a best-effort candidate via `heuristicJudge()`.
- If oracle commands exist, only candidates that pass the oracle are preferred.
- If multiple candidates pass, `heuristicJudge()` chooses a single winner, currently by simple deterministic heuristics such as smallest diff.
- The engine does not merge or blend candidates today.
- `frites_apply` is separate from implementation. It applies the recommended diff onto a fresh `frites/apply/<runId>` branch and requires a clean user working tree.

Relevant files:

- `packages/core/src/engine.ts`
- `packages/isolation/src/index.ts`
- `packages/agents/src/runner.ts`
- `packages/agents/src/claude.ts`
- `packages/agents/src/codex.ts`

### Problem

The current single-candidate recommendation can leave quality on the table.

Common scenario:

- Child A produces a cleaner implementation in one file, better local abstractions, or more efficient control flow.
- Child B produces better tests, better edge-case handling, or a cleaner implementation in a different file.
- Both pass the oracle independently.
- The current engine must recommend exactly one complete diff, so it cannot produce the best combined solution.

A naive file-level or hunk-level merge sounds attractive, but it is unsafe as the primary mechanism because changes often interact through:

- Shared imports and exports.
- Types and interfaces.
- Test fixtures and expected behavior.
- Config or package metadata.
- Generated artifacts.
- Error handling conventions.
- Cross-file invariants.
- Hidden assumptions each child made while editing.

A mechanical merge could easily create a diff that compiles poorly, passes fewer tests, duplicates logic, or subtly changes behavior even when each source candidate passed alone.

### Recommended Approach

Add an explicit synthesis phase that runs after normal child execution and oracle filtering.

Instead of mechanically merging candidate diffs, frites should create a fresh synthesis worktree from the same base SHA and ask a synthesizer agent to produce one integrated implementation using the best ideas from the successful candidates.

The synthesized implementation should then be captured and verified exactly like any other candidate.

High-level flow:

1. Run existing child agents unchanged.
2. Capture each child diff from its isolated worktree unchanged.
3. Run the oracle against each usable candidate unchanged.
4. If zero or one usable candidate passes, keep current behavior.
5. If at least two candidates pass, create a new synthesis worktree from the original base SHA.
6. Provide the synthesizer with the original task, acceptance criteria, child summaries, passing diffs, files touched, and oracle results.
7. Instruct the synthesizer to implement the best integrated solution directly in the synthesis worktree.
8. Capture the synthesis worktree diff with the same `captureDiff()` path used for normal children.
9. Run the same build/test/lint oracle against the synthesized candidate.
10. Recommend the synthesized candidate only if it passes.
11. If synthesis fails, times out, produces an empty diff, or fails the oracle, fall back to the best original passing candidate.

This preserves the current safety model: every recommended implementation remains a concrete git diff from a clean worktree and is validated by the same oracle before recommendation.

### Non-Goals

Do not implement naive automatic hunk merging as the main strategy.

Do not mutate any child candidate worktree during synthesis.

Do not apply the synthesized result to the user's current branch automatically.

Do not weaken the `frites_apply` clean-working-tree gate.

Do not treat synthesizer prose as authoritative. The synthesized result must be captured from git.

Do not recommend a synthesized candidate that has not passed the oracle when at least one original candidate passed.

### Proposed Engine Shape

Add an optional synthesis step between oracle filtering and final reconciliation.

Current simplified engine shape:

```text
select agents
resolve base
run child agents in isolated worktrees
capture child diffs
run oracle for candidates
reconcile original candidates
cleanup worktrees
```

Proposed shape:

```text
select agents
resolve base
run child agents in isolated worktrees
capture child diffs
run oracle for candidates
if synthesis is enabled and multiple candidates passed:
  create synthesis worktree from same base
  run synthesizer agent in synthesis worktree
  capture synthesis diff
  run oracle for synthesized candidate
  include synthesized candidate only if valid, or record failed synthesis metadata
reconcile with synthesis-aware preference
cleanup all worktrees
```

The synthesizer candidate should be represented as a normal `Candidate` where possible, with a reserved agent id such as `synthesizer` or `synthesis-1` and a kind/model matching the configured synthesizer backend.

Possible new fields:

```ts
interface Candidate {
  // existing fields...
  synthesizedFrom?: string[];
  synthesis?: boolean;
}
```

Alternative: avoid adding fields initially and use a reserved `agentId`, but explicit metadata will make CLI/MCP output clearer and tests easier to reason about.

### Configuration Design

Add configuration only if needed for control and cost safety.

Possible config keys:

```ts
synthesisMode?: "off" | "passing-only" | "always";
synthesisAgent?: AgentSpec;
synthesisMinCandidates?: number;
synthesisMaxDiffChars?: number;
synthesisTimeoutMs?: number;
synthesisHardTimeoutMs?: number;
synthesisBudgetUsd?: number;
```

Recommended initial defaults:

- `synthesisMode: "off"` for the first implementation, or `"passing-only"` if the UX clearly communicates extra cost.
- `synthesisMinCandidates: 2`.
- Use the first configured Claude child as the default synthesizer when available, because synthesis benefits from strong code review and integration judgment.
- Fall back to the first configured child if no Claude child exists.
- Reuse existing per-child timeout and budget defaults unless synthesis-specific values are provided.

The initial version can also avoid public config and keep synthesis internal behind a feature flag while the behavior is proven.

### Synthesis Prompt Requirements

The synthesizer prompt should be stricter than a normal implementation prompt.

It should include:

- Original task instructions.
- Acceptance criteria.
- The base SHA or base ref for context.
- List of candidate ids, models, touched files, and oracle status.
- Full diffs for oracle-passing candidates, subject to a size cap.
- Summaries and log paths for candidates if available.
- A clear instruction to implement the best integrated solution in the current worktree.
- A clear instruction not to blindly concatenate patches.
- A clear instruction to inspect the repository files before editing if needed.
- A clear instruction to preserve existing conventions and keep tests green.
- A clear instruction to prefer smaller, coherent integrations over combining every idea.

The prompt should explicitly tell the synthesizer:

- Use candidate diffs as source material, not as mandatory patches.
- Resolve conflicts through actual code understanding.
- Keep only changes that support the original task and acceptance criteria.
- Drop redundant, stylistically inconsistent, or over-broad edits.
- Ensure the final diff is internally consistent across files.
- Run relevant tests if available, subject to normal child behavior.

### Diff Size And Context Limits

Candidate diffs can be large. The synthesis step needs size controls.

Recommended behavior:

- Include all passing candidate metadata regardless of diff size.
- Include full diffs only while under `synthesisMaxDiffChars`.
- If diffs exceed the cap, include summaries plus per-file diff stats and ask the synthesizer to inspect candidate worktrees only if the architecture supports exposing them safely.
- Prefer passing candidates over failing candidates when trimming.
- Do not include node_modules, dist, `.frites`, or other excluded paths.

Important design decision:

The synthesizer worktree is fresh from base. It should not have direct write access to child worktrees. If read-only access to child worktrees is provided later, it must be explicit and carefully bounded.

### Reconciliation Policy

Synthesis should not make final selection less safe.

Recommended policy:

- If synthesis is disabled, keep current behavior exactly.
- If fewer than two original candidates pass the oracle, keep current behavior.
- If synthesis runs and passes the oracle, prefer the synthesized candidate by default.
- If synthesis fails but at least one original candidate passed, recommend the best original passing candidate.
- If no original candidate passed, synthesis can optionally run in a future mode over near-misses, but the result must pass the oracle before being treated as verified.
- If synthesis over near-misses fails or has no oracle, report it as a near-miss, not as a verified recommendation.

Initial implementation should use passing candidates only. Near-miss synthesis is more complex and should be a later enhancement.

### Reporting And UX

The MCP/CLI result should make synthesis visible.

Report:

- Whether synthesis was attempted.
- Which candidate ids were used as inputs.
- Whether the synthesized candidate passed the oracle.
- Whether the final recommendation is synthesized or an original child candidate.
- If synthesis failed, why fallback occurred.
- Additional cost and token usage for synthesis.
- Files touched by the synthesized candidate.

The final output should avoid implying that multiple child diffs were mechanically merged. Use language such as:

```text
Synthesis candidate passed the oracle and is recommended. It integrated ideas from claude-1 and codex-1 in a fresh worktree, then passed build/test/lint.
```

Fallback language:

```text
Synthesis was attempted from claude-1 and codex-1 but failed the test oracle. Recommending claude-1, the best original passing candidate.
```

### Safety And Failure Modes

Key failure modes to handle:

- Synthesizer produces no edits.
- Synthesizer exits non-zero.
- Synthesizer times out.
- Synthesizer produces a diff that fails build/test/lint.
- Synthesizer includes unrelated changes from candidate diffs.
- Synthesizer reintroduces a bug from a candidate that passed only because the oracle was weak.
- Candidate diffs are too large for the synthesis prompt.
- Child worktree cleanup races with synthesis needing candidate metadata.
- Synthesis branch names collide with child or apply branch names.
- Cost increases unexpectedly when multiple large diffs are passed into the synthesizer.

Mitigations:

- Keep synthesis worktree lifecycle managed by `WorktreeManager` or a closely related abstraction.
- Capture synthesis diff with the existing `captureDiff()` implementation.
- Run the same oracle path as normal candidates.
- Prefer original passing candidates on synthesis failure.
- Add explicit prompt and config size caps.
- Preserve all child metadata before cleanup.
- Emit events for synthesis start, progress, finish, and oracle result.
- Include synthesis spend in the existing `costNote()` calculation or a separate synthesis cost line.

### Event Model

Consider adding engine events so users can see what is happening during longer synthesis runs.

Possible events:

```ts
{ type: "synthesis-started", inputAgents: string[] }
{ type: "synthesis-progress", message: string }
{ type: "synthesis-finished", status: CandidateStatus, filesTouched: number }
{ type: "synthesis-oracle-started" }
{ type: "synthesis-oracle-finished", passed: boolean }
{ type: "synthesis-skipped", reason: string }
```

Alternatively, reuse existing `agent-started`, `agent-progress`, and `agent-finished` events with a reserved synthetic agent id. Explicit events are clearer but require more event plumbing.

### Implementation Plan

1. Add tests that lock current winner-take-one behavior before changing reconciliation.
2. Add a small synthesis planner/helper in `packages/core/src/engine.ts` or a new `packages/core/src/synthesis.ts`.
3. Define when synthesis is eligible: enabled, at least two oracle-passing usable candidates, and within diff-size limits.
4. Add a way to create a synthesis worktree from the same base SHA.
5. Build a synthesis prompt from task instructions, acceptance criteria, passing candidate metadata, diffs, and oracle results.
6. Invoke `deps.runAgent()` for the synthesizer using the synthesis worktree as `cwd`.
7. Capture the synthesis diff with `worktrees.captureDiff()`.
8. Convert the synthesis result into a `Candidate`.
9. Run `runOracleFor()` or equivalent oracle logic against the synthesis candidate.
10. Update reconciliation to prefer an oracle-passing synthesized candidate over original candidates.
11. Preserve fallback to the best original passing candidate if synthesis is not usable.
12. Ensure cleanup covers child and synthesis worktrees.
13. Update MCP/CLI output formatting to expose synthesis status and fallback reasons.
14. Document the feature in the eventual GitBook docs under synthesis/reconciliation and worktree oracle pages.

### Test Plan

Unit tests:

- Synthesis is skipped when disabled.
- Synthesis is skipped when fewer than two candidates pass.
- Synthesis is skipped when there is no oracle and mode requires passing candidates.
- Synthesis worktree is created from the same base SHA as child worktrees.
- Synthesis prompt includes original instructions, acceptance criteria, passing candidate diffs, and oracle results.
- Failed original candidates are excluded from initial passing-only synthesis.
- Synthesized candidate is recommended when it passes the oracle.
- Best original passing candidate is recommended when synthesis errors.
- Best original passing candidate is recommended when synthesis times out.
- Best original passing candidate is recommended when synthesis produces an empty diff.
- Best original passing candidate is recommended when synthesis fails the oracle.
- Synthesis worktree is cleaned up in success and failure paths.
- Cost note includes synthesis cost or reports it clearly.
- Event stream includes enough synthesis progress to debug long runs.

Integration tests:

- Fake two child agents that edit different files and pass tests; fake synthesizer combines both; verify synthesized diff is recommended.
- Fake two child agents with conflicting edits; synthesizer resolves conflict; verify oracle pass is required.
- Fake synthesizer combines edits but breaks tests; verify fallback to original passing candidate.
- Verify `frites_apply` can apply a synthesized recommendation exactly like a normal candidate diff.

Verification after implementation:

```sh
pnpm typecheck
pnpm test
```

If live CLI smoke tests are available, run at least one opt-in synthesis smoke with two inexpensive children and a tiny fixture repo.

### Acceptance Criteria

- Multiple child agents still run in isolated worktrees from a shared base SHA.
- Original child candidate capture and oracle filtering continue to work unchanged.
- When at least two candidates pass and synthesis is enabled, frites can create a fresh synthesis worktree and produce a new synthesized candidate diff.
- Synthesized candidates are captured from git, not from prose.
- Synthesized candidates must pass the configured oracle before being preferred over original passing candidates.
- If synthesis fails, frites falls back to the best original passing candidate without losing the run.
- The final result clearly reports whether the recommendation is original or synthesized.
- `frites_apply` works with synthesized recommendations without special cases.
- Tests cover success, skip, failure, timeout, empty diff, oracle failure, and cleanup behavior.
