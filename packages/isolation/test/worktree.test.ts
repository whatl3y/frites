import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "@frites/isolation";

const repos: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "frites-it-"));
  repos.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  // Non-interactive shell: disable commit/tag signing or `git commit` hangs on pinentry
  // when the user has a global commit.gpgsign=true.
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "tag.gpgsign", "false"]);
  writeFileSync(join(dir, "foo.txt"), "hello\n");
  writeFileSync(join(dir, ".gitignore"), ".frites/\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

afterEach(() => {
  for (const r of repos.splice(0)) {
    try {
      execFileSync("rm", ["-rf", r]);
    } catch {
      /* best effort */
    }
  }
});

describe("WorktreeManager (real git)", () => {
  it("creates an isolated worktree, captures a diff, cleans up, and applies to a fresh branch", async () => {
    const repo = makeRepo();
    const wt = new WorktreeManager();

    const base = await wt.resolveBase(repo);
    expect(base.sha).toMatch(/^[0-9a-f]{7,}/);

    const handle = await wt.create(repo, "run1", "A", base.sha);
    expect(existsSync(handle.path)).toBe(true);

    // Simulate an agent doing real work inside its isolated worktree.
    await mkdir(join(handle.path, "src"), { recursive: true });
    await writeFile(join(handle.path, "src", "bar.ts"), "export const x = 1;\n");
    await writeFile(join(handle.path, "foo.txt"), "hello world\n");

    const { diff, filesTouched } = await wt.captureDiff(handle.path);
    expect(filesTouched).toContain("src/bar.ts");
    expect(filesTouched).toContain("foo.txt");
    expect(diff).toContain("export const x = 1;");

    await wt.cleanup(repo, handle);
    expect(existsSync(handle.path)).toBe(false);

    // Apply the captured diff onto a fresh branch on the (clean) repo.
    const { branch } = await wt.applyToBranch(repo, "run1", diff);
    expect(branch).toBe("frites/apply/run1");
    expect(existsSync(join(repo, "src", "bar.ts"))).toBe(true);
    expect(readFileSync(join(repo, "foo.txt"), "utf8")).toBe("hello world\n");
  });

  it("refuses non-git directories with a helpful error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frites-nogit-"));
    repos.push(dir);
    const wt = new WorktreeManager();
    await expect(wt.resolveBase(dir)).rejects.toThrow(/not a git repository/);
  });
});
