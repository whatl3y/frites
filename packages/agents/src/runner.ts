import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRunContext,
  AgentRunOutput,
  AgentSpec,
  ChildKind,
  FritesConfig,
  RunAgentFn,
} from "@frites/core";
import { classifyBackendFailure, formatBackendFailure } from "./backend-errors.js";
import { BackendSuppressionController, describeSuppression } from "./backend-policy.js";
import { assertDepth, buildChildEnv, currentDepth } from "./env-sandbox.js";
import { startIdleTimeout } from "./timeout.js";

export interface RunAccumulator {
  summary?: string;
  costUsd?: number;
  /**
   * Normalized, provider-comparable token usage (same shape as the answer-council path). Captured
   * so frites_implement can report codex's footprint instead of zero — the ChatGPT backend reports
   * no `cost_usd`, so tokens are the only signal of how hard codex actually worked. `outputTokens`
   * is reasoning-inclusive on both providers (see codex.ts/claude.ts onLine).
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
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
  hardTimeoutMs: number | undefined,
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
    // Kept apart from logChunks (which interleaves both for the on-disk log): backend-failure
    // classification must mine the answer body on stdout only for STRUCTURED error events, and run
    // its free-text fallback over stderr alone — never over the agent's stdout answer prose.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
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

    // Idle timeout (resets on output), not a wall-clock deadline: a child that's actively streaming
    // events runs as long as it stays productive; only genuine silence reaps it. `idle.touch()` is
    // called on every stdout/stderr chunk below. Optional hard ceiling is the non-resetting backstop.
    const idle = startIdleTimeout({
      idleMs: timeoutMs,
      hardMs: hardTimeoutMs,
      onFire: () => {
        killedReason = "timeout";
        killGroup("SIGTERM");
        escalate();
      },
    });

    const onAbort = () => {
      killedReason = "abort";
      killGroup("SIGTERM");
      escalate();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      idle.clear();
      ctx.signal.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (b: Buffer) => {
      idle.touch();
      const s = b.toString();
      logChunks.push(s);
      stdoutChunks.push(s);
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
    child.stderr?.on("data", (b: Buffer) => {
      idle.touch();
      const s = b.toString();
      logChunks.push(s);
      stderrChunks.push(s);
    });

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
      const backendFailure = classifyBackendFailure(String(err), def.kind);
      resolve({
        status: "errored",
        error: backendFailure ? formatBackendFailure(backendFailure) : String(err),
        backendFailure,
        logPath,
        ...acc,
      });
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
      const backendFailure =
        status === "errored"
          ? classifyBackendFailure(
              { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") },
              def.kind,
              code,
            )
          : undefined;
      resolve({
        status,
        summary: acc.summary,
        costUsd: acc.costUsd,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens,
        error:
          status === "errored"
            ? killedReason === "abort"
              ? "aborted"
              : backendFailure
                ? formatBackendFailure(backendFailure)
                : `exit code ${code}`
            : undefined,
        backendFailure,
        logPath,
      });
    });
  });
}

export interface MakeRunAgentOptions {
  runners: CliRunnerDef[];
  config: FritesConfig;
  passApiKeys?: boolean;
}

/** Build the RunAgentFn the engine calls, wired with the configured CLI backends. */
export function makeRunAgent(opts: MakeRunAgentOptions): RunAgentFn {
  const byKind = new Map(opts.runners.map((r) => [r.kind, r]));
  const backendHealth = new BackendSuppressionController();
  return async (spec: AgentSpec, ctx: AgentRunContext): Promise<AgentRunOutput> => {
    const suppressed = backendHealth.isSuppressed(spec);
    let actualSpec = spec;
    if (suppressed) {
      const replacement = backendHealth.selectAgent(
        opts.config.defaultAgents.filter((a) => byKind.has(a.kind)),
        { attempted: new Set([spec.kind]) },
      );
      if (replacement) {
        ctx.onProgress(
          `${describeSuppression(suppressed)}; using ${replacement.kind}${
            replacement.model ? `:${replacement.model}` : ""
          }`,
        );
        actualSpec = { ...replacement, id: spec.id };
      } else {
        return {
          status: "errored",
          actualKind: spec.kind,
          actualModel: spec.model,
          error: describeSuppression(suppressed),
          backendFailure: suppressed.failure,
        };
      }
    }

    const def = byKind.get(actualSpec.kind);
    if (!def) {
      return { status: "errored", error: `No runner registered for kind '${actualSpec.kind}'` };
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
      ...actualSpec,
      maxBudgetUsd: actualSpec.maxBudgetUsd ?? opts.config.perChildBudgetUsd,
      timeoutMs: actualSpec.timeoutMs ?? opts.config.perChildTimeoutMs,
      hardTimeoutMs: actualSpec.hardTimeoutMs ?? opts.config.perChildHardTimeoutMs,
      // Codex reasoning depth: per-agent override wins, else the config default ("high"). Only
      // codex reads this (see codex.ts); claude children ignore it.
      reasoningEffort:
        actualSpec.kind === "codex-cli"
          ? (actualSpec.reasoningEffort ?? opts.config.codexReasoningEffort)
          : actualSpec.reasoningEffort,
    };
    const timeoutMs = effSpec.timeoutMs ?? opts.config.perChildTimeoutMs;
    const hardTimeoutMs = effSpec.hardTimeoutMs ?? opts.config.perChildHardTimeoutMs;
    const argv = def.buildArgv(effSpec, ctx);
    const logPath = join(tmpdir(), `frites-${spec.id}-${Date.now()}.log`);
    const out = await spawnAndStream(def, argv, ctx, env, timeoutMs, hardTimeoutMs, logPath);
    if (out.backendFailure) backendHealth.recordFailure(out.backendFailure);
    return {
      ...out,
      actualKind: actualSpec.kind,
      actualModel: actualSpec.model,
    };
  };
}
