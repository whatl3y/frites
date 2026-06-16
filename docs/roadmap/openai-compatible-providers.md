# OpenAI-compatible providers (xAI Grok & open-source models)

> **Status: planned, not implemented.** This page records the design for adding OpenAI-compatible child support, including xAI Grok and self-hosted / open-source models. None of it ships today; frites children are still only `claude-cli` and `codex-cli`.

Goal: add support for any provider that exposes an OpenAI-compatible `/v1/chat/completions` endpoint (xAI Grok, plus open-source or self-hosted models served through vLLM, Ollama, LM Studio, OpenRouter, Together, Fireworks, and similar gateways) alongside the existing Claude and Codex children, without destabilizing the gateway or MCP worktree paths. See the [Deferred tasks](deferred-tasks.md) index for where this fits, and the [Gemini provider](gemini-provider.md) plan, which this design parallels.

## Recommended approach: one generic adapter, presets on top

The unlock here is that xAI Grok and most open-source serving stacks already speak the same wire protocol: the OpenAI chat-completions API. So unlike Gemini (which needs a provider-specific SDK and stream parser), this is **one adapter** that varies only by base URL, credential, and model ID.

Ship it in this shape:

1. Add a single generic `openai-compatible` council child backed by the official `openai` Node SDK with a configurable `baseUrl`. This one adapter covers xAI, OpenRouter, Together, Fireworks, vLLM, Ollama, LM Studio, and anything else that implements `/v1/chat/completions`.
2. Add a thin `xai` preset over it that defaults `baseUrl` to `https://api.x.ai/v1` and the credential to `XAI_API_KEY`, so Grok works with just `{ "kind": "xai", "model": "<grok-model>" }`.

API-first is the only practical initial path: there is no official, stable Grok or generic OpenAI-compatible CLI to wrap as an unattended worktree runner. Treat any CLI option as a later, separately-spiked concern (see below).

Start as gateway answer/action council children. Worktree-mode execution can follow once the council path is stable, the same staging the Gemini plan uses.

## Current architecture touchpoints

Provider support is currently centered on `ChildKind = "claude-cli" | "codex-cli"`, mirrored through config schemas, parser helpers, CLI/MCP agent parsing, and the agents package dispatch layer.

Likely files to change:

- `packages/core/src/types.ts`: extend `ChildKind` and `AgentSpec` (new optional `baseUrl` / `apiKeyEnv` fields).
- `packages/core/src/config.ts`
- `packages/core/src/config-io.ts`
- `packages/agents/src/completion.ts`: dispatch the new kinds.
- `packages/agents/src/env-sandbox.ts`: see the base-URL and credential notes below; this is the security-sensitive change.
- `packages/agents/src/pricing.ts`: config-driven pricing for arbitrary model IDs, allow zero-cost local models.
- `packages/agents/src/index.ts`
- `apps/cli/src/index.ts`
- `apps/mcp/src/runtime.ts`
- `apps/gateway/src/index.ts`: only if gateway dispatch assumptions are hard-coded.
- `README.md`
- `docs/` provider/config pages.

Likely new file:

- `packages/agents/src/openai-compatible.ts` (the shared adapter; `xai` is a preset configured through it, not a separate adapter).

## Implementation plan

1. Add `"openai-compatible"` (and the `"xai"` preset) to `ChildKind` and `AgentSpecSchema`.
2. Extend `AgentSpec` with optional, kind-gated fields:
   - `baseUrl`: required for generic `openai-compatible`, defaulted for presets like `xai`.
   - `apiKeyEnv`: name of the env var holding the credential (defaults: `OPENAI_API_KEY` for generic, `XAI_API_KEY` for `xai`). This avoids hard-coding one credential name across many providers.
3. Add the `openai` Node SDK to the agents package. It supports a per-client `baseURL`, so it doubles as the client for every OpenAI-compatible endpoint.
4. Implement the completion adapter so it returns the existing `CompletionResult` shape and emits normalized `ChildEvent` events. Construct the SDK client with `{ baseURL, apiKey }` resolved **programmatically** from config + env, never from a base-URL env var (those are scrubbed; see Auth below).
5. Wire `runCompletion()` to dispatch `openai-compatible` / `xai`.
6. Reuse the existing gateway answer/action council behavior. Children should initially return text or JSON action proposals; do **not** implement native OpenAI tool/function calling in v1.
7. Handle credentials and base URLs per the Auth section, respecting `passApiKeys` / `FRITES_PASS_API_KEYS`.
8. Add README config examples:

```json
{
  "id": "grok-1",
  "kind": "xai",
  "model": "<user-selected-grok-model>"
}
```

```json
{
  "id": "local-1",
  "kind": "openai-compatible",
  "baseUrl": "http://localhost:11434/v1",
  "apiKeyEnv": "OLLAMA_API_KEY",
  "model": "<user-selected-open-source-model>"
}
```

9. Keep these kinds out of default agents until typecheck, unit tests, and an opt-in live smoke are stable.
10. Defer any CLI runner until a stable, unattended-safe OpenAI-compatible CLI exists and is spiked separately.

## API design notes

Use the existing provider-neutral shapes rather than adding provider-specific gateway logic.

For streaming, use `chat.completions.create({ stream: true })`. It is the broadest-compatibility surface: the Responses API and provider-specific extensions are **not** uniformly implemented by third-party / self-hosted servers, so avoid them for the generic adapter. Fixture-test the delta chunk shape (`choices[].delta.content`), the final chunk, and `usage`.

For tool calls, v1 keeps using the existing frites action-council protocol: children produce a JSON action proposal, the gateway parses it, and the host executes the resulting tool call. Native OpenAI `tools` / function calling can come later if needed.

For cache/cost, only populate cache-read / cache-write usage fields when the provider exposes metadata that clearly maps to frites's existing semantics (e.g. OpenAI's `usage.prompt_tokens_details.cached_tokens`). Many OpenAI-compatible servers omit `usage` entirely or report partial counts, so degrade gracefully and do not guess.

## Auth and environment

This is the security-sensitive part and differs from the Claude/Codex CLI paths because the endpoint is user-controlled.

- **Base URL must be passed programmatically, not via env.** `env-sandbox.ts` already scrubs `OPENAI_BASE_URL` (and `ANTHROPIC_BASE_URL`, `CODEX_BASE_URL`) from child environments as a recursion / base-URL-redirection guard. The adapter must therefore set the SDK client `baseURL` from the agent's `baseUrl` config field directly, and must **not** rely on or reintroduce a base-URL env var. Add any new base-URL env names to `SCRUB_EXACT` before they could ever be honored.
- **Credential allowlist needs extending.** `passApiKeys` currently lets only `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` survive into child environments. For Grok and arbitrary providers, the gate must also honor the agent's configured `apiKeyEnv` (e.g. `XAI_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`). Keep the existing posture: credentials are withheld unless `passApiKeys` or `FRITES_PASS_API_KEYS=1` allows them, and only the specifically-named key is passed; do not broaden to a wildcard.
- **Self-hosted models often need no key** (local vLLM / Ollama). Allow a missing credential when the configured `apiKeyEnv` is unset, sending a placeholder if the SDK requires a non-empty `apiKey`.

## Tests

Unit tests to add or update:

- Config accepts `openai-compatible` and `xai`, including the new `baseUrl` / `apiKeyEnv` fields and their preset defaults.
- Generic `openai-compatible` requires `baseUrl`; `xai` defaults it.
- CLI/MCP agent parsing recognizes the new kinds and any aliases.
- Env sandbox: base-URL env vars stay scrubbed; the configured `apiKeyEnv` is withheld by default and passed only when `passApiKeys` allows it; a missing local key is tolerated.
- Stream parser handles text deltas, final text, `usage` metadata (including `cached_tokens` when present), unknown events, missing `usage`, and malformed chunks.
- Pricing works with arbitrary model IDs through the config-driven pricing table, including zero-cost local models.
- Answer council works with mixed Claude, Codex, and OpenAI-compatible children.
- Action council accepts an OpenAI-compatible child returning JSON with surrounding prose or code fences.

Integration tests:

- Mock the `openai` SDK stream for deterministic tests (one fixture covers xAI and self-hosted, since the wire shape is shared).
- Add an opt-in live smoke gated by `XAI_API_KEY` (Grok) and, optionally, a local-endpoint smoke gated by an env flag pointing at a running OpenAI-compatible server.
- Gateway smoke with `defaultAgents` containing one `xai` child and `fanOutPolicy: never` or another low-cost setting.

Verification after implementation:

```sh
pnpm typecheck
pnpm test
```

Run the live smokes only when the relevant credentials / endpoints are present.

## Risks

- The user-controlled `baseUrl` is a redirection surface: it must be honored only through the SDK client and never leak into scrubbed base-URL env vars, or it could undermine the recursion guard.
- OpenAI-compatibility is uneven across third-party and self-hosted servers: streaming chunk shapes, `usage` reporting, and error formats vary. Test against faithful mocks and gate live behavior behind opt-in smokes.
- Model IDs and pricing vary wildly and change quickly (Grok versions, arbitrary open-source names); avoid hard-coded defaults and stale pricing, and allow zero-cost entries.
- Broadening the credential allowlist must stay narrow (named keys only) to preserve the secret-minimization posture.
- Native OpenAI tool/function calling could overcomplicate v1; the existing JSON action protocol is enough for initial support.
