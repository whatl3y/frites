# Status & limits

A concise, user-facing view of what frites does today and where the rough edges are. For the full,
dated enumeration of implementation status, see
[roadmap/current-status.md](../roadmap/current-status.md), which is canonical.

## What works

Built and tested (126/126 unit tests plus live smoke against a real `claude` client):

- **The gateway**, both surfaces — `/v1/messages` (Claude Code) and `/v1/responses` (Codex) — with
  SSE streaming, live per-agent telemetry, live answer streaming, fan-out, synthesis, the LLM
  fan-out judge, `fanOutScope` first-turn scoping, background-model bypass, a per-turn council
  recap, and cost telemetry. See [product/gateway-mode.md](./gateway-mode.md).
- **Code editing through the gateway.** On a coding turn the gateway emits the `Read` / `Edit` /
  `Bash` `tool_use` your host executes on the real files — verified end-to-end (a real `claude`
  client → gateway fixed a bug and the tests passed), with **no API key**.
- **The background service** (launchd on macOS), so the gateway runs always-on. See
  [getting-started/service-management.md](../getting-started/service-management.md).
- **MCP worktree mode** — worktrees → tests-as-oracle → optional cross-candidate synthesis → vetted
  diff → apply to a fresh branch. See [product/mcp-worktree-mode.md](./mcp-worktree-mode.md).
- **The config CLI** — `frites config` init/show/get/set/unset/validate/path with global+repo
  layering. See [reference/cli.md](../reference/cli.md).

## Known gaps

- **Value gate pending.** Whether fan-out *quality* actually beats a single agent on real tickets at
  acceptable cost has not yet been validated. This is the headline open question — if it fails, the
  thin slice is the product.
- **Codex tool-call emission on `/v1/responses` pending.** The gateway drives coding turns by
  emitting host-executed tool calls today on the Anthropic `/v1/messages` surface; emitting
  `function_call` on Codex's `/v1/responses` is **not yet built**. Codex works fully for Q&A /
  reasoning turns, but the inline code-editing loop is Claude-only for now.

## Realistic limitations

- **Slower than a single agent.** A council of independent agents, cross-checked and synthesized, is
  the core bet — better output traded for latency and metered spend. Worktree mode is the far end of
  that curve (minutes, not seconds). See the tradeoff note in
  [architecture/risks-and-tradeoffs.md](../architecture/risks-and-tradeoffs.md).
- **Metered, not free.** Programmatic use draws the Agent-SDK credit / ChatGPT plan; see
  [product/auth-and-billing.md](./auth-and-billing.md). Spend scales with fan-out, bounded by
  [fan-out policy](../concepts/fan-out-policy.md) and [fan-out scope](../concepts/fan-out-scope.md).
- **Headless, high-trust posture.** Children run unattended without interactive approvals, and
  several hardening items are still open (no strong sandbox, no secret deny-read). Review the
  [safety model](./safety-model.md) before pointing frites at a repository.

For the complete, dated status list, see
[roadmap/current-status.md](../roadmap/current-status.md).
