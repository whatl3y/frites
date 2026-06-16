# Isolation

`@frites/isolation` (`packages/isolation`) is frites's git-worktree layer. It gives every child agent its own isolated working tree branched from a single pinned base SHA, captures each agent's change as a unified diff, seeds the synthesis stage from a known-good tree, and lands an approved result on a fresh branch behind the one mandatory human gate. Its only dependency is [`@frites/core`](core.md), whose `WorktreeManagerLike` interface it implements — so the engine drives isolation without importing git directly.

For how isolation underpins the safety model and the overall worktree flow, see [Isolation](../architecture/isolation.md).

## Exports

`packages/isolation/src/index.ts` exports the `WorktreeManager` class, which `implements WorktreeManagerLike`. Internally it shells out to `git` through a small `git()` helper (resolving stdout/stderr/exit code) and a `gitOrThrow()` wrapper that throws with the command and stderr on a non-zero exit.

## Lifecycle

The engine calls these methods, in order, per run:

### `assertGitRepo(repoPath)`

Runs `git rev-parse --is-inside-work-tree` and throws a clear error ("frites needs a git repo to isolate agents in worktrees") when `repoPath` is not a git repository.

### `resolveBase(repoPath, ref?)`

Asserts the repo, then `git rev-parse`s the target (`ref` or `HEAD`) into a SHA, returning `{ ref, sha }`. Every worktree in the run branches from this single pinned SHA so all candidates and the synthesizer start from an identical base.

### `create(repoPath, runId, agentId, baseSha)`

Runs `git worktree add --quiet -b <branch> <path> <baseSha>` and returns the `WorktreeHandle` `{ path, branch }`.

- **Branch:** `frites/run/<runId>/<agentId>`. Child branches live under `frites/run/...` specifically so they never collide at the git-ref level with the apply branch `frites/apply/<runId>` (git refs are files, so a branch named `frites/<runId>` cannot coexist with `frites/<runId>/<agentId>`).
- **Path:** `<repoPath>/.frites/worktrees/<runId>/<agentId>`.

### `captureDiff(worktreePath)`

Stages everything with `git add -A` (so new files are included), then reads back both the unified diff (`git diff --staged --no-color`) and the file list (`git diff --staged --name-only`), returning `{ diff, filesTouched }`. Both reads apply `DIFF_EXCLUDES` pathspecs — `:(exclude)node_modules`, `:(exclude)dist`, `:(exclude).frites` — so generated artifacts never pollute a candidate's diff. `filesTouched` is the trimmed, non-empty list of changed paths.

### `cleanup(repoPath, handle)`

Best-effort teardown: `git worktree remove --force`, `git branch -D <branch>`, then `git worktree prune`. The engine runs this for every handle in a `finally`/`allSettled`, so worktrees and their branches are reaped even when a run throws.

## Seeding synthesis: `applyDiffToWorktree(worktreePath, diff)`

The optional method on `WorktreeManagerLike`. It applies a captured candidate diff into a synthesis worktree with `git apply --3way --index`. Because the worktree was created from the **same base SHA** the diff was captured against, the 3-way apply is conflict-free. `--index` stages the result; the later `captureDiff` (`git add -A`) re-stages, so the two compose cleanly. This lets the synthesizer start from the best passing candidate's known-good tree rather than re-deriving the agreed core. The diff is normalized to end with a newline before being piped to git over stdin.

## Apply-to-branch: the one human gate

`applyToBranch(repoPath, runId, diff)` lands an approved diff — and is the single mandatory human gate. It is deliberately conservative:

1. Asserts the repo is a git repo.
2. Requires a **clean working tree** (`git status --porcelain` must be empty), throwing and asking the user to commit or stash first — because applying switches branches.
3. Creates and checks out a **fresh** branch `frites/apply/<runId>` via `git switch -c`.
4. Applies the diff with `git apply --3way --index`. On failure it throws, noting that the branch is created and checked out so the user can resolve manually.

It **never** touches the user's current branch history and **never** pushes — landing a result is always an explicit, reviewable action on an isolated branch. See [Safety model](../product/safety-model.md) for how this fits the broader blast-radius posture.
