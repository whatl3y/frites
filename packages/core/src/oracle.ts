import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { CommandResult, OracleCommands, OracleResult } from "./types.js";

const OUTPUT_TAIL = 4000;

/** Detect a package manager + test/build/lint commands from a repo, unless overridden. */
export async function detectOracle(
  repoPath: string,
  override: OracleCommands & { autoDetect?: boolean },
): Promise<OracleCommands> {
  const explicit: OracleCommands = {
    build: override.build,
    test: override.test,
    lint: override.lint,
  };
  if (explicit.build || explicit.test || explicit.lint) return explicit;
  if (override.autoDetect === false) return {};

  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) return {};
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    scripts = pkg.scripts ?? {};
  } catch {
    return {};
  }
  const pm = detectPackageManager(repoPath);
  const out: OracleCommands = {};
  if (scripts.test) out.test = `${pm} run test`;
  if (scripts.build) out.build = `${pm} run build`;
  if (scripts.lint) out.lint = `${pm} run lint`;
  return out;
}

function detectPackageManager(repoPath: string): string {
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "bun.lockb"))) return "bun";
  return "npm";
}

export async function runCommand(
  cwd: string,
  command: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise<CommandResult>((resolve) => {
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > OUTPUT_TAIL) output = output.slice(-OUTPUT_TAIL);
    };
    const child = spawn(command, {
      cwd,
      shell: true,
      env: opts.env ?? process.env,
      signal: opts.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : undefined;
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const finish = (exitCode: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({
        command,
        ran: true,
        passed: exitCode === 0,
        exitCode,
        durationMs: Date.now() - started,
        output: output.trim(),
      });
    };
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        command,
        ran: false,
        passed: false,
        exitCode: null,
        durationMs: Date.now() - started,
        output: String(err),
      });
    });
    child.on("close", finish);
  });
}

/** Run the configured oracle commands against one candidate's worktree. */
export async function runOracle(
  cwd: string,
  agentId: string,
  commands: OracleCommands,
  opts: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<OracleResult> {
  const result: OracleResult = { agentId, passed: true, hadOracle: false };
  // Order matters: build -> lint -> test. A build failure short-circuits the rest.
  for (const key of ["build", "lint", "test"] as const) {
    const command = commands[key];
    if (!command) continue;
    result.hadOracle = true;
    const cmd = await runCommand(cwd, command, opts);
    result[key] = cmd;
    if (!cmd.passed) {
      result.passed = false;
      break;
    }
  }
  // If no command ran, this candidate has no executable oracle.
  if (!result.hadOracle) result.passed = false;
  return result;
}
