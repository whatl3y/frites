import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRunContext,
  AgentRunOutput,
  AgentSpec,
  ChildKind,
  DistraiConfig,
  RunAgentFn,
} from "@distrai/core";
import { assertDepth, buildChildEnv, currentDepth } from "./env-sandbox";

export interface RunAccumulator {
  summary?: string;
  costUsd?: number;
}

/** Adapter describing how to invoke and read one CLI backend. */
export interface CliRunnerDef {
  kind: ChildKind;
  command: string;
  buildArgv(spec: AgentSpec, ctx: AgentRunContext): string[];
  /** Parse one line of stdout (typically NDJSON), emitting progress + accumulating results. */
  onLine(line: string, emit: (message: string) => void, acc: RunAccumulator): void;
}

const KILL_GRACE_MS = 3000;

function spawnAndStream(
  def: CliRunnerDef,
  argv: string[],
  ctx: AgentRunContext,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  logPath: string,
): Promise<AgentRunOutput> {
  return new Promise<AgentRunOutput>((resolve) => {
    const child = spawn(def.command, argv, {
      cwd: ctx.cwd,
      env,
      detached: true, // own process group → tree-kill via -pid
      // Prompt rides stdin, not argv: real transcripts exceed ARG_MAX → spawn E2BIG.
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Deliver the prompt over stdin and close it. The EOF is what stops the child
    // from waiting for more input (the prior "codex hangs" footgun was an *open*
    // stdin with no EOF); both claude (-p) and codex (`-`) read until EOF. Swallow
    // EPIPE in case the child dies before draining what we wrote.
    child.stdin?.on("error", () => {
      /* EPIPE: child exited before reading stdin */
    });
    child.stdin?.end(ctx.prompt);

    const acc: RunAccumulator = {};
    const logChunks: string[] = [];
    let killedReason: "timeout" | "abort" | null = null;
    let buf = "";

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    const escalate = () => setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);

    const timer = setTimeout(() => {
      killedReason = "timeout";
      killGroup("SIGTERM");
      escalate();
    }, timeoutMs);

    const onAbort = () => {
      killedReason = "abort";
      killGroup("SIGTERM");
      escalate();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (b: Buffer) => {
      const s = b.toString();
      logChunks.push(s);
      buf += s;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) {
          try {
            def.onLine(line, ctx.onProgress, acc);
          } catch {
            /* tolerate schema drift */
          }
        }
      }
    });
    child.stderr?.on("data", (b: Buffer) => logChunks.push(b.toString()));

    const writeLog = () => {
      try {
        writeFileSync(logPath, logChunks.join(""));
      } catch {
        /* best effort */
      }
    };

    child.on("error", (err) => {
      cleanup();
      writeLog();
      resolve({ status: "errored", error: String(err), logPath, ...acc });
    });

    child.on("close", (code) => {
      cleanup();
      writeLog();
      const status: AgentRunOutput["status"] =
        killedReason === "timeout"
          ? "timed-out"
          : code === 0
            ? "succeeded"
            : "errored";
      resolve({
        status,
        summary: acc.summary,
        costUsd: acc.costUsd,
        error:
          status === "errored"
            ? killedReason === "abort"
              ? "aborted"
              : `exit code ${code}`
            : undefined,
        logPath,
      });
    });
  });
}

export interface MakeRunAgentOptions {
  runners: CliRunnerDef[];
  config: DistraiConfig;
  passApiKeys?: boolean;
}

/** Build the RunAgentFn the engine calls, wired with the configured CLI backends. */
export function makeRunAgent(opts: MakeRunAgentOptions): RunAgentFn {
  const byKind = new Map(opts.runners.map((r) => [r.kind, r]));
  return async (spec: AgentSpec, ctx: AgentRunContext): Promise<AgentRunOutput> => {
    const def = byKind.get(spec.kind);
    if (!def) {
      return { status: "errored", error: `No runner registered for kind '${spec.kind}'` };
    }
    const depth = currentDepth();
    assertDepth(depth, opts.config.maxDepth);
    const env = buildChildEnv({
      depth,
      maxDepth: opts.config.maxDepth,
      passApiKeys: opts.passApiKeys,
    });
    // Apply config defaults so per-child budget/timeout actually take effect even
    // when a spec omits them.
    const effSpec: AgentSpec = {
      ...spec,
      maxBudgetUsd: spec.maxBudgetUsd ?? opts.config.perChildBudgetUsd,
      timeoutMs: spec.timeoutMs ?? opts.config.perChildTimeoutMs,
      // Codex reasoning depth: per-agent override wins, else the config default ("high"). Only
      // codex reads this (see codex.ts); claude children ignore it.
      reasoningEffort:
        spec.kind === "codex-cli"
          ? (spec.reasoningEffort ?? opts.config.codexReasoningEffort)
          : spec.reasoningEffort,
    };
    const timeoutMs = effSpec.timeoutMs ?? opts.config.perChildTimeoutMs;
    const argv = def.buildArgv(effSpec, ctx);
    const logPath = join(tmpdir(), `distrai-${spec.id}-${Date.now()}.log`);
    return spawnAndStream(def, argv, ctx, env, timeoutMs, logPath);
  };
}
