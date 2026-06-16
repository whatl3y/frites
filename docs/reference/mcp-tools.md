# MCP tools

The MCP worktree mode (`@frites/mcp`) exposes two tools over an stdio MCP
transport: `frites_implement` runs a council of full agents in isolated git
worktrees and returns one vetted diff plus a comparison, and `frites_apply`
lands a chosen diff onto a fresh branch. The server is named `frites`. For how
the mode fits together, see [MCP worktree mode](../product/mcp-worktree-mode.md).

## `frites_implement`

Dispatches a coding task to multiple full agents (claude/codex) in isolated git
worktrees, filters them with the repo's tests, and returns one vetted diff plus
a comparison. It is long-running (minutes). Review the result, then call
`frites_apply`.

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `task` | string | yes | What to implement or fix. |
| `repoPath` | string | yes | Absolute path to the target git repository. |
| `n` | integer `1`–`5` | no | Number of agents. |
| `agents` | string | no | Comma list of agent kinds, e.g. `claude,codex`. A token starting with `codex` maps to `codex-cli`, one starting with `claude` maps to `claude-cli`. |
| `acceptanceCriteria` | string | no | Acceptance criteria for the agents and oracle. |
| `baseRef` | string | no | Git ref to branch from (default `HEAD`). |

The tool returns a Markdown result (`formatResultText`) containing the run id,
decision, rationale, the recommended candidate, a per-agent comparison table
(kind, status, files, Δlines, tokens in→out, oracle pass/fail), a synthesis
status line, and the cost note. Synthesized candidates are marked with a `⚗︎`
glyph. It also returns structured content (`toStructured`) and one
`resource_link` per candidate diff, persisted under
`.frites/runs/<runId>/<agentId>.diff` (with `result.json` alongside) in the
target repo. On error it returns an `isError` result with the failure message.

## `frites_apply`

Applies a diff from a previous `frites_implement` run onto a fresh branch
`frites/<runId>`. It applies the recommended candidate by default, or a specific
one via `candidateId`. It requires a clean working tree and never pushes.

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `runId` | string | yes | The run id from a previous `frites_implement` call. |
| `repoPath` | string | yes | Absolute path to the target git repository. |
| `candidateId` | string | no | Apply this candidate's diff instead of the recommended one (e.g. a tighter passing child instead of a synthesized result). |

Apply behavior:

- If `candidateId` is given but no candidate with that id exists in the run, the
  tool returns an error listing the available candidate ids.
- If the chosen candidate has no diff to apply, it returns an error.
- On success it applies the diff to a new branch `frites/<runId>` and returns the
  branch name plus structured `{ branch, runId, candidateId }`. The result tells
  you to review and commit; frites never auto-merges or pushes.

## Registration

### Claude Code

Register once for Claude Code (available in every repo):

```bash
claude mcp add --scope user frites -- pnpm --dir ~/nodejs/frites mcp
```

### Codex

Register once for Codex in `~/.codex/config.toml`. The 60-second default tool
timeout **must** be raised — `tool_timeout_sec = 600` is required because
`frites_implement` runs for minutes:

```toml
[mcp_servers.frites]
command = "pnpm"
args = ["--dir", "/Users/whatl3y/nodejs/frites", "mcp"]
tool_timeout_sec = 600
```

## Progress and result-size behavior

- **Progress.** When the MCP client supplies a `progressToken`,
  `frites_implement` streams `notifications/progress` updates as the engine
  emits events (agents starting/finishing, oracle results, synthesis,
  reconciliation), each with a human-readable message and an incrementing step
  count. Without a progress token, no notifications are sent.
- **Result size.** Full candidate diffs are written to disk under
  `.frites/runs/<runId>/` and surfaced as `resource_link` entries rather than
  inlined, keeping the returned text result compact. Per-candidate token counts
  are rendered compactly (e.g. `11.2k`) in the comparison table.
- **Lifecycle.** The server self-terminates when its MCP client disconnects
  (stdin EOF, termination signals, or being reparented to PID 1), so it never
  lingers as an orphan.

## Typical flow

In a session: *"use frites to implement X"* → review the diff → *"use
frites_apply with runId …"* (optionally `candidateId=<agent>` to land a specific
candidate). The same flow is available from the terminal via `frites "implement
X" --repo … --apply` / `--apply-candidate <id>` — see the [CLI](cli.md).

## See also

- [MCP worktree mode](../product/mcp-worktree-mode.md) — the product overview of this mode.
- [CLI](cli.md) — the standalone `frites run` equivalent.
- [Configuration](configuration.md) — synthesis and oracle keys that shape a run.
