# Isolation

The `@frites/isolation` package (`packages/isolation`) gives each child agent its own git worktree to edit in, captures the resulting diff, and lands an approved diff on a fresh branch. `WorktreeManager` implements the `WorktreeManagerLike` interface the [core engine](core-engine.md) depends on, so the engine has zero git coupling. See the package overview in [services/isolation](../services/isolation.md).

The authoritative implementation result is never the child's output text; it is the git diff captured from its worktree. This is what makes the worktree path frites's strongest verification surface.

## Worktree lifecycle

### Resolve base

`resolveBase(repoPath, ref?)` first asserts the path is a git repo (`assertGitRepo` runs `git rev-parse --is-inside-work-tree`; a non-repo raises an instructive error pointing at `git init`). It then resolves the base ref (default `HEAD`) to a concrete SHA with `git rev-parse`, so every child branches from the same immutable commit.

### Create

`create(repoPath, runId, agentId, baseSha)` runs:

```
git worktree add --quiet -b frites/run/<runId>/<agentId> .frites/worktrees/<runId>/<agentId> <baseSha>
```

The worktree path lives under `.frites/worktrees/<runId>/<agentId>` inside the repo (gitignored, local to the repo). The branch is namespaced `frites/run/<runId>/<agentId>` so it can never collide at the ref level with the apply branch `frites/apply/<runId>`. Git refs are files, so a branch named `frites/<runId>` could not coexist with `frites/<runId>/<agentId>`.

The engine creates worktrees concurrently (one per child) and registers each handle in its shared `handles` map the instant `create` returns, so cleanup always covers them on any later throw.

## captureDiff

After a child exits, `captureDiff(worktreePath)` reads the actual change out of git:

1. `git add -A`: stage everything, including new files, so the diff is complete.
2. `git diff --staged --no-color -- . <excludes>`: the unified diff.
3. `git diff --staged --name-only -- . <excludes>`: the touched-file list.

The excludes (`DIFF_EXCLUDES`) drop `node_modules`, `dist`, and `.frites` so generated artifacts never pollute candidate diffs. A candidate is usable only when its status is `succeeded` and it touched at least one file; this captured diff is the candidate's `diff` and `filesTouched`.

## Seeding the synthesis worktree

`applyDiffToWorktree(worktreePath, diff)` exists to seed the [synthesis](core-engine.md) worktree from a known-good tree. It runs `git apply --3way --index`, applying a captured candidate diff into a worktree created from the same base SHA (so the 3-way apply is conflict-free). `--index` stages the result, and the diff is newline-terminated if needed. This method is optional on the interface; when it is absent or throws, synthesis falls back to fresh-from-base.

## Apply to branch

`applyToBranch(repoPath, runId, diff)` is the one mandatory human gate. It is separate from implementation and lands an approved diff:

1. Assert the path is a git repo.
2. **Require a clean working tree**: `git status --porcelain` must be empty, else it throws asking the user to commit or stash first (frites is about to switch branches).
3. `git switch -c frites/apply/<runId>`: create and check out a fresh branch.
4. `git apply --3way --index` the diff. If apply fails, it throws with the branch already checked out so the user can resolve manually.

It never touches the user's current branch history, never auto-merges, and never pushes. The MCP `frites_apply` tool drives this path; with synthesis, a reviewer can pass an explicit `candidateId` to land a tighter passing child instead of the recommendation. See the [safety model](../product/safety-model.md) for the apply gate's place in the blast-radius controls.

## Cleanup assumptions

`cleanup(repoPath, handle)` tears down one worktree:

```
git worktree remove --force <path>
git branch -D <branch>
git worktree prune
```

`--force` and `prune` make cleanup reliable even when a worktree was left dirty or a crash interrupted a run. The engine runs cleanup for every registered handle (children and synthesis alike) inside a single `finally` via `Promise.allSettled`, so one failed removal never blocks the others. Because the other passing children's worktrees stay alive on disk until that `finally`, the synthesizer can reference them read-only during a run.

## Related

- [Isolation service](../services/isolation.md): package overview.
- [Core engine](core-engine.md): how the engine drives the worktree manager.
- [Safety model](../product/safety-model.md): the apply gate and blast-radius controls.
- [Agents and runners](agents-and-runners.md): how children run inside these worktrees.
