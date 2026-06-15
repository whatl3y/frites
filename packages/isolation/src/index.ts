import { spawn } from "node:child_process";
import { join } from "node:path";
import type { WorktreeHandle, WorktreeManagerLike } from "@frites/core";

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function git(
  args: string[],
  opts: { cwd?: string; input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (err) =>
      resolve({ code: null, stdout, stderr: String(err) }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

async function gitOrThrow(
  args: string[],
  opts: { cwd?: string; input?: string } = {},
): Promise<string> {
  const r = await git(args, opts);
  if (r.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r.stdout.trim();
}

// Exclude pathspecs so generated artifacts never pollute candidate diffs.
const DIFF_EXCLUDES = [
  ":(exclude)node_modules",
  ":(exclude)dist",
  ":(exclude).frites",
];

export class WorktreeManager implements WorktreeManagerLike {
  async assertGitRepo(repoPath: string): Promise<void> {
    const r = await git(["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
    });
    if (r.code !== 0 || r.stdout.trim() !== "true") {
      throw new Error(
        `${repoPath} is not a git repository. frites needs a git repo to isolate ` +
          `agents in worktrees. Run \`git init\` (and commit a baseline) first.`,
      );
    }
  }

  async resolveBase(
    repoPath: string,
    ref?: string,
  ): Promise<{ ref: string; sha: string }> {
    await this.assertGitRepo(repoPath);
    const target = ref ?? "HEAD";
    const sha = await gitOrThrow(["rev-parse", target], { cwd: repoPath });
    return { ref: target, sha };
  }

  async create(
    repoPath: string,
    runId: string,
    agentId: string,
    baseSha: string,
  ): Promise<WorktreeHandle> {
    // Child branches live under frites/run/<runId>/... so they never collide at the
    // git-ref level with the apply branch frites/apply/<runId> (refs are files: a
    // branch named frites/<runId> cannot coexist with frites/<runId>/<agentId>).
    const branch = `frites/run/${runId}/${agentId}`;
    const path = join(repoPath, ".frites", "worktrees", runId, agentId);
    await gitOrThrow(
      ["worktree", "add", "--quiet", "-b", branch, path, baseSha],
      { cwd: repoPath },
    );
    return { path, branch };
  }

  async captureDiff(
    worktreePath: string,
  ): Promise<{ diff: string; filesTouched: string[] }> {
    // Stage everything (incl. new files) so the diff is complete, then read it back.
    await gitOrThrow(["add", "-A"], { cwd: worktreePath });
    const diff = await gitOrThrow(
      ["diff", "--staged", "--no-color", "--", ".", ...DIFF_EXCLUDES],
      { cwd: worktreePath },
    );
    const names = await gitOrThrow(
      ["diff", "--staged", "--name-only", "--", ".", ...DIFF_EXCLUDES],
      { cwd: worktreePath },
    );
    const filesTouched = names
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return { diff, filesTouched };
  }

  async cleanup(repoPath: string, handle: WorktreeHandle): Promise<void> {
    await git(["worktree", "remove", "--force", handle.path], { cwd: repoPath });
    await git(["branch", "-D", handle.branch], { cwd: repoPath });
    await git(["worktree", "prune"], { cwd: repoPath });
  }

  /**
   * Land an approved diff onto a FRESH branch — the one mandatory human gate.
   * Never touches the user's current branch's history and never pushes.
   */
  async applyToBranch(
    repoPath: string,
    runId: string,
    diff: string,
  ): Promise<{ branch: string }> {
    await this.assertGitRepo(repoPath);
    const status = await gitOrThrow(["status", "--porcelain"], {
      cwd: repoPath,
    });
    if (status.trim().length > 0) {
      throw new Error(
        "Working tree is not clean. Commit or stash your changes before applying a " +
          "frites result (frites will switch to a new branch).",
      );
    }
    const branch = `frites/apply/${runId}`;
    await gitOrThrow(["switch", "-c", branch], { cwd: repoPath });
    const applied = await git(["apply", "--3way", "--index"], {
      cwd: repoPath,
      input: diff.endsWith("\n") ? diff : diff + "\n",
    });
    if (applied.code !== 0) {
      throw new Error(
        `Created branch ${branch} but \`git apply\` failed: ${applied.stderr.trim()}. ` +
          `Resolve manually; the branch is checked out.`,
      );
    }
    return { branch };
  }
}
