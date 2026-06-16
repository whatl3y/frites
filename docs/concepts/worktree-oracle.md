# Worktree oracle

In the worktree implementation path, frites does not decide which candidate is best by reading the agents' prose. It runs the project's own build, lint, and test commands against each candidate diff and treats those commands as the **oracle**: the executable signal of whether an implementation actually works. This is what gives the worktree path its correctness guarantee: every recommended diff has passed real commands in a clean worktree.

This page covers candidate filtering and tie-breaking. For how the oracle plugs into reconciliation and the optional synthesis stage, see [synthesis-and-reconciliation.md](synthesis-and-reconciliation.md).

## Tests, build, and lint as the oracle

Each child agent runs in its own isolated git worktree. After it exits, frites captures the actual git diff and the list of touched files. The child's text output is never trusted as the implementation result. The oracle commands then run inside each candidate's worktree.

Commands are either configured on the task/config or auto-detected from the repo's `package.json` scripts:

- If any of `build`, `test`, or `lint` is explicitly set, those explicit commands are used as-is.
- Otherwise, if auto-detection is on, frites detects the package manager (`pnpm`, `yarn`, `bun`, or `npm` from the corresponding lockfile) and maps each present script to `<pm> run <script>`.
- With no `package.json`, or with auto-detection turned off and nothing explicit, there is **no executable oracle**.

The oracle runs in a fixed order (**build → lint → test**) and short-circuits on the first failure, so a candidate that fails the build never runs lint or test. A candidate passes only if every configured command exits 0. If no command ran at all, the candidate has no executable oracle and does not count as passing.

## Candidate filtering and near-miss behavior

Reconciliation runs over the captured candidates with the oracle results:

1. Candidates that errored, timed out, were empty, or touched no files are ignored. Only `succeeded` candidates with at least one touched file are usable.
2. If no usable candidates exist, the run reports **near-miss** with no recommendation.
3. If there is no executable oracle, frites picks a best-effort winner from the usable candidates using the heuristic tie-breaker.
4. If an oracle exists, only candidates whose oracle **passed** are kept.
5. If no candidate passed, frites surfaces the closest **near-miss** using the heuristic over the usable candidates. There is a recommendation candidate to inspect, but it is reported as a near-miss, not a verified result.
6. If exactly one candidate passed, it is recommended.
7. If several candidates passed, the heuristic tie-breaker chooses one.

"Near-miss" is the honest signal that nothing cleared the bar: frites still surfaces the closest attempt for review rather than pretending a failing candidate is verified.

## Deterministic heuristic tie-breaker

When more than one candidate passes (or when there is no oracle and frites must still pick something), the winner is chosen by `heuristicJudge`, a **deterministic smallest-blast-radius tie-breaker, not an LLM judge**:

1. Smallest changed-line count (added/removed lines in the unified diff, excluding `+++`/`---` headers).
2. Then fewest files touched.

The verdict carries a rationale, e.g. *"Chosen from 3 test-passing candidates by smallest blast radius (42 changed lines across 2 file(s))"*, or *"Only candidate to pass the oracle"* when just one survives. Because it is purely deterministic, the same set of candidates always yields the same winner.

## No N-way mechanical merge

The worktree path recommends **one complete candidate diff** by default; it never mechanically merges candidates. A naive file- or hunk-level merge is unsafe as the primary mechanism because candidate changes interact through shared imports/exports, types, test fixtures, config, error-handling conventions, and cross-file invariants. A mechanical merge can produce a diff that compiles poorly, passes fewer tests, duplicates logic, or subtly changes behavior even when each source candidate passed alone.

The optional synthesis stage (on by default, `synthesisMode: "passing-only"`) does not change this: when at least two candidates pass, frites asks one synthesizer agent to produce a single integrated implementation in a seeded worktree, then captures it from git and re-runs the **same** oracle against it. It is only preferred when it both passes and stays within a configurable blast-radius ceiling; otherwise frites falls back to the best original passing candidate. See [synthesis-and-reconciliation.md](synthesis-and-reconciliation.md) for the full synthesis policy.
