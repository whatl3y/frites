# Safety model

frites is a high-trust local automation tool. It **deliberately** launches child agents in headless,
unattended mode so the council can finish a turn without blocking on interactive approval prompts.
Treat it as a power tool you point at repositories you trust — not as a permission-prompt-preserving
wrapper. This page is the canonical description of frites's permission posture and the blast-radius
controls that bound it.

## Headless child posture

Children run without interactive approvals so N agents can run to completion without prompting each
other to a halt:

- **Claude** children launch with `--permission-mode bypassPermissions`.
- **Codex** children launch with `approval_policy="never"`.

The posture is then tightened per surface, from most permissive (worktree) to most restrictive
(answer-only).

## Per-surface permission boundaries

### Gateway action mode

On a coding turn, the children **decide** the next action; they do not edit files themselves. The
gateway emits a normal host `Read` / `Edit` / `Bash` `tool_use`, and the **host executes it under
its own permission model**. The host is the permission boundary for the actual file mutation — but
do not assume each child decision passed through your usual per-command approval UI before the
gateway returns a synthesized tool call.

### Gateway answer-only mode

Answer turns should inspect and answer, never mutate, so children are constrained further:

- **Claude** disallows `Edit`, `Write`, and `NotebookEdit`.
- **Codex** runs with `-s read-only` and writes only its final-message fallback **outside** the
  repo.

### MCP worktree mode

`frites_implement` starts full agents inside isolated git worktrees:

- **Claude** uses bypassed permissions.
- **Codex** uses `-s workspace-write` with approvals disabled.

The safety boundary here is the **worktree plus the final human diff review**. frites returns
candidate diffs; `frites_apply` lands the chosen diff on a fresh `frites/<runId>` branch. It never
auto-merges and never pushes — the apply gate is the one mandatory human gate. See
[product/mcp-worktree-mode.md](./mcp-worktree-mode.md) for the full flow.

## Implemented blast-radius controls

frites ships several controls that bound what a headless child can reach and do:

- **Allowlist child env.** The child environment is built by **allowlist**, never by copying
  `process.env`. Only essentials pass through — `HOME`, `PATH`, locale variables, terminal/user
  variables, and the credentials a child needs to find its own auth.
- **Base-URL scrub.** Provider base-URL variables are stripped from every child so a child cannot be
  pointed back at the gateway: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_URL`, `OPENAI_BASE_URL`,
  `OPENAI_API_BASE`, and `CODEX_BASE_URL` are scrubbed (even if reintroduced via extra env).
- **API-key withholding.** API keys are withheld by default (`passApiKeys: false`); children use
  subscription OAuth unless you opt in (`passApiKeys: true` or `FRITES_PASS_API_KEYS=1`). See
  [product/auth-and-billing.md](./auth-and-billing.md) for the overflow path.
- **Recursion-depth fuse.** Each child gets `FRITES_DEPTH` incremented; frites refuses to spawn
  above the configured `maxDepth`. Children are also launched with `--strict-mcp-config` /
  `--ignore-user-config` so they do not auto-load frites and recursively call the gateway.
- **Patch / apply gate.** MCP worktree mode lands changes only via returned diff → explicit apply →
  fresh `frites/<runId>` branch. Never auto-merge, never push.
- **Local bind.** The gateway listens on `127.0.0.1` only.
- **Per-child limits.** Wall-clock timeout with process-group kill, plus per-child budget caps where
  the backend supports them.

## Current hardening gaps

These are known and called out so you can make an informed trust decision:

- **No strong sandbox.** There is no strong OS/container sandbox wrapping Claude children yet.
- **No secret deny-read.** Deny-read rules for paths such as `~/.ssh`, `~/.aws`, and `.env` are
  planned but **not enforced** today — a child can read them.
- **No interactive-prompt-preserving mode.** There is no child mode that preserves normal
  interactive permission prompts inside the child agents.

Hardened `sandbox-runtime` / container execution with default-deny egress remains planned work.

## Guidance for security-conscious users

Until the planned hardening lands:

- Use frites only in repositories and working trees you are comfortable letting local headless
  agents inspect and, in action/worktree paths, modify without per-command approval.
- Keep `passApiKeys` **off** unless you explicitly need overflow.
- Always review diffs before applying.
- Avoid running the gateway against untrusted repositories.

For the engine-level enforcement behind this posture, see [agents and runners](../architecture/agents-and-runners.md);
for how worktrees isolate child edits, see [isolation](../architecture/isolation.md).
