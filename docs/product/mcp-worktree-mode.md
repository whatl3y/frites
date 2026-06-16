# MCP worktree mode

The gateway already edits code inline by emitting the `Read` / `Edit` / `Bash` tool calls
your host executes. MCP worktree mode is for heavier work: running N **competing** full
implementations in parallel, filtering them with your test suite, and yielding **one vetted
diff** to apply to a fresh branch. It is exposed as the MCP tools `frites_implement` and
`frites_apply`.

## N competing implementations in isolated worktrees

When you ask frites to implement something, the engine resolves the base commit, decides N,
and creates one isolated git worktree per agent. Each child agent runs as a full agent and
edits in its own worktree concurrently, so the candidates never collide. frites streams
progress notifications as the agents work, then captures each candidate's diff from git.

## Tests as the oracle

Reconciliation is not a mechanical N-way merge. That produces duplicate declarations and
contradictions that still compile. Instead, frites filters the candidate diffs through your
repo's **test suite as the ground-truth oracle** (configured or auto-detected build, lint,
and test commands), then reconciles:

- Candidates that errored, timed out, were empty, or touched no files are ignored.
- If no candidate passes, frites surfaces the closest near-miss.
- If exactly one passes, it is recommended.
- If multiple pass, a deterministic judge breaks the tie by smallest changed-line count, then
  fewest files touched.

This is the strongest correctness signal in frites: candidates are actual diffs tested
against real commands. See [worktree oracle](../concepts/worktree-oracle.md) for how the
oracle and tie-break work.

## Optional cross-candidate synthesis

By default (`synthesisMode: "passing-only"`), once at least two candidates pass the oracle,
frites runs one more step instead of just picking a winner. It creates a fresh worktree from
the same base commit, **seeds** it with the best passing diff, and asks a synthesizer agent to
fold the strongest ideas from the others into one integrated implementation. That candidate is
captured from git and re-run through the **same** oracle, and it is recommended only if it
passes *and* stays within a sane size ceiling (`synthesisMaxBlastFactor`); otherwise frites
falls back to the best individual passing child and tells you why. It never mechanically merges
diffs. Set `synthesisMode: "off"` for plain winner-take-one.

Synthesis is summarized here; for the full design, gating rationale, and reconciliation
policy across both surfaces, see
[synthesis and reconciliation](../concepts/synthesis-and-reconciliation.md).

## Diff review and apply

frites returns candidate diffs plus a per-candidate comparison for you to review. It never
auto-merges or pushes. When you are satisfied, `frites_apply` lands the chosen diff on a
fresh `frites/<runId>` branch. This explicit human gate is the one mandatory approval step.
You can always land a specific child instead of the recommendation by passing
`candidateId=<agent>` to `frites_apply` (or `--apply-candidate <id>` on the CLI).

For the full tool inputs and outputs, see the [MCP tools reference](../reference/mcp-tools.md).

## When this beats gateway mode

Worktree mode is the far end of the "better output, slower" curve: N full implementations run
to completion, then an extra synthesizer pass plus oracle run before you get a diff,
minutes, not seconds. The payoff is that, unlike the gateway's answer synthesis, the worktree
result is **verified** (it actually passed your tests), not just adjudicated. Reach for it
when correctness matters more than latency; use the gateway, `synthesisMode: "off"`, or fewer
agents when you want speed. See [risks and tradeoffs](../architecture/risks-and-tradeoffs.md)
for the canonical tradeoff discussion.
