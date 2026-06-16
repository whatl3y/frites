# Gemini provider

> **Status: planned, not implemented.** This page records the design for adding Gemini support. None of it ships today — frites children are still only `claude-cli` and `codex-cli`.

Goal: add Gemini support alongside the existing Claude and Codex children without destabilizing the gateway or MCP worktree paths. See the [Deferred tasks](deferred-tasks.md) index for where this fits.

## Recommended approach: two stages

Ship Gemini in two stages:

1. Add `gemini-api` first as an internal council child for gateway answer/action synthesis.
2. Consider `gemini-cli` later for answer-only or worktree execution — but only **after** a real CLI behavior spike proves it can run unattended safely.

API-first is the safer initial path because Google documents the Node SDK (`@google/genai`) and its streaming / function-calling APIs. Gemini CLI currently needs local validation before it is safe as an unattended child runner: its stdin behavior, `stream-json` schema, approval prompts, sandboxing, write behavior, and timeout behavior are not enough to rely on from docs alone.

## Current architecture touchpoints

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
- `apps/gateway/src/index.ts` — only if gateway dispatch assumptions are hard-coded
- `README.md`
- `docs/ARCHITECTURE.md`

Likely new file:

- `packages/agents/src/gemini-api.ts`

Possible later file:

- `packages/agents/src/gemini.ts` for a Gemini CLI runner, after the spike

## Implementation plan

1. Add `"gemini-api"` to `ChildKind` and `AgentSpecSchema`.
2. Update config loading, validation, examples, CLI/MCP `parseAgents`, and docs so users can opt into Gemini manually.
3. Add `@google/genai` to the agents package.
4. Implement a Gemini API completion adapter that returns the existing `CompletionResult` shape and emits normalized `ChildEvent` events.
5. Wire `runCompletion()` to dispatch `gemini-api`.
6. Reuse the existing gateway answer/action council behavior. Gemini should initially return text or JSON action proposals; do **not** implement native Gemini host tool calling in v1.
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

## API design notes

Use the existing provider-neutral shapes rather than adding Gemini-specific gateway logic.

For streaming, choose one Google API surface deliberately and fixture-test it:

- `generateContentStream` is enough for text-only answer support if chunks expose text and usage reliably.
- Interactions streaming may be better if native Gemini function calling becomes a goal, but it has a different event model.

Do not mix both paths casually.

For tool calls, v1 should keep using the existing frites action-council protocol: children produce a JSON action proposal, the gateway parses it, and the host executes the resulting tool call. Native Gemini function declarations can come later if needed.

For cache/cost, only populate cache-read / cache-write usage fields when Gemini exposes metadata that clearly maps to frites's existing semantics. Do not guess cache behavior.

## Auth and environment

Initial API mode should support:

- `GEMINI_API_KEY`
- possibly `GOOGLE_API_KEY`
- `GOOGLE_GENAI_USE_VERTEXAI`
- `GOOGLE_CLOUD_PROJECT`
- other Vertex env only if explicitly supported by the chosen SDK path

Keep the existing secret-minimization posture: API keys are withheld unless `passApiKeys` or `FRITES_PASS_API_KEYS=1` allows them.

If Gemini SDKs support endpoint-override variables, add them to the recursion / base-URL scrub list **before** enabling them in child environments.

## Tests

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

## Gemini CLI spike checklist

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

## Risks

- Gemini model IDs and API surfaces may change quickly; avoid hard-coded defaults and stale pricing.
- Gemini streaming APIs differ by endpoint family; parser tests need real fixtures or faithful mocks.
- Gemini CLI may prompt, hang, or mutate files unexpectedly without a proven unattended contract.
- API mode is less subscription-reuse-friendly than the existing Claude / Codex CLI paths.
- Native Gemini function calling could overcomplicate v1; the existing JSON action protocol is enough for initial support.
