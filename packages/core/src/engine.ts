import type { FritesConfig } from "./config.js";
import { type EngineEventHandler, noopEventHandler } from "./events.js";
import { heuristicJudge } from "./judge.js";
import type {
  AgentSpec,
  Candidate,
  OracleCommands,
  OracleResult,
  ReconcileDecision,
  RunResult,
  Task,
} from "./types.js";

// ── Structural deps (satisfied by @frites/isolation and @frites/agents) ──
// Keeping these as interfaces here means the engine has zero CLI/MCP/git coupling
// and is fully unit-testable with fakes.

export interface WorktreeHandle {
  path: string;
  branch: string;
}

export interface WorktreeManagerLike {
  resolveBase(repoPath: string, ref?: string): Promise<{ ref: string; sha: string }>;
  create(
    repoPath: string,
    runId: string,
    agentId: string,
    baseSha: string,
  ): Promise<WorktreeHandle>;
  captureDiff(
    worktreePath: string,
  ): Promise<{ diff: string; filesTouched: string[] }>;
  cleanup(repoPath: string, handle: WorktreeHandle): Promise<void>;
}

export interface AgentRunContext {
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

export interface AgentRunOutput {
  status: "succeeded" | "errored" | "timed-out";
  summary?: string;
  error?: string;
  logPath?: string;
  costUsd?: number;
}

export type RunAgentFn = (
  spec: AgentSpec,
  ctx: AgentRunContext,
) => Promise<AgentRunOutput>;

export type RunOracleFn = (
  cwd: string,
  agentId: string,
  commands: OracleCommands,
  opts: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<OracleResult>;

export interface EngineDeps {
  worktrees: WorktreeManagerLike;
  runAgent: RunAgentFn;
  runOracle: RunOracleFn;
  oracleCommands: OracleCommands;
  config: FritesConfig;
  newRunId: () => string;
  /** External cancellation (client disconnect). */
  signal?: AbortSignal;
}

// ── Engine ──

export async function runEngine(
  task: Task,
  deps: EngineDeps,
  onEvent: EngineEventHandler = noopEventHandler,
): Promise<RunResult> {
  const { worktrees, config } = deps;
  const runId = deps.newRunId();
  const agents = selectAgents(task, config);
  onEvent({ type: "run-started", runId, n: agents.length });

  const base = await worktrees.resolveBase(task.repoPath, task.baseRef);
  onEvent({ type: "base-resolved", ref: base.ref, sha: base.sha });

  const handles = new Map<string, WorktreeHandle>();
  const candidates: Candidate[] = [];
  try {
    // ── DISPATCH + EXECUTE (concurrent) ──
    const built = await Promise.all(
      agents.map((spec) =>
        runOneAgent(spec, task, base.sha, runId, deps, handles, onEvent),
      ),
    );
    candidates.push(...built);

    // ── ORACLE-FILTER ──
    const oracle = await Promise.all(
      candidates.map((c) =>
        runOracleFor(c, handles.get(c.agentId), deps, onEvent),
      ),
    );

    // ── RECONCILE ──
    const { recommended, decision, rationale } = reconcile(
      candidates,
      oracle,
      deps.oracleCommands,
    );
    onEvent({
      type: "reconcile",
      decision,
      survivors: oracle.filter((o) => o.passed).length,
    });
    onEvent({ type: "done", runId, recommended: recommended?.agentId });

    return {
      runId,
      recommended,
      candidates,
      oracle,
      decision,
      rationale,
      costNote: costNote(candidates),
    };
  } finally {
    await Promise.allSettled(
      [...handles.values()].map((h) => worktrees.cleanup(task.repoPath, h)),
    );
  }
}

async function runOneAgent(
  spec: AgentSpec,
  task: Task,
  baseSha: string,
  runId: string,
  deps: EngineDeps,
  handles: Map<string, WorktreeHandle>,
  onEvent: EngineEventHandler,
): Promise<Candidate> {
  const handle = await deps.worktrees.create(
    task.repoPath,
    runId,
    spec.id,
    baseSha,
  );
  handles.set(spec.id, handle);
  onEvent({ type: "agent-started", agentId: spec.id, kind: spec.kind });

  const base: Candidate = {
    agentId: spec.id,
    kind: spec.kind,
    worktreePath: handle.path,
    branch: handle.branch,
    diff: "",
    filesTouched: [],
    status: "errored",
  };

  try {
    const out = await deps.runAgent(spec, {
      cwd: handle.path,
      prompt: buildPrompt(task, spec, deps.config.childDirective),
      signal: deps.signal ?? new AbortController().signal,
      onProgress: (message) =>
        onEvent({ type: "agent-progress", agentId: spec.id, message }),
    });
    const { diff, filesTouched } = await deps.worktrees.captureDiff(handle.path);
    const status: Candidate["status"] =
      out.status !== "succeeded"
        ? out.status
        : filesTouched.length > 0
          ? "succeeded"
          : "empty";
    const candidate: Candidate = {
      ...base,
      diff,
      filesTouched,
      status,
      summary: out.summary,
      error: out.error,
      logPath: out.logPath,
      costUsd: out.costUsd,
    };
    onEvent({
      type: "agent-finished",
      agentId: spec.id,
      status,
      filesTouched: filesTouched.length,
    });
    return candidate;
  } catch (err) {
    const candidate: Candidate = {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
    onEvent({
      type: "agent-finished",
      agentId: spec.id,
      status: "errored",
      filesTouched: 0,
    });
    return candidate;
  }
}

async function runOracleFor(
  c: Candidate,
  handle: WorktreeHandle | undefined,
  deps: EngineDeps,
  onEvent: EngineEventHandler,
): Promise<OracleResult> {
  const noOracle: OracleResult = {
    agentId: c.agentId,
    passed: false,
    hadOracle: false,
  };
  if (c.status !== "succeeded" || !handle) return noOracle;
  const hasCommands =
    !!deps.oracleCommands.build ||
    !!deps.oracleCommands.test ||
    !!deps.oracleCommands.lint;
  if (!hasCommands) return noOracle;

  onEvent({ type: "oracle-started", agentId: c.agentId });
  const res = await deps.runOracle(handle.path, c.agentId, deps.oracleCommands, {
    signal: deps.signal,
    timeoutMs: deps.config.perChildTimeoutMs,
  });
  onEvent({ type: "oracle-finished", agentId: c.agentId, passed: res.passed });
  return res;
}

// ── Reconciliation ──

function reconcile(
  candidates: Candidate[],
  oracle: OracleResult[],
  commands: OracleCommands,
): { recommended?: Candidate; decision: ReconcileDecision; rationale: string } {
  const byId = new Map(oracle.map((o) => [o.agentId, o]));
  const usable = candidates.filter(
    (c) => c.status === "succeeded" && c.filesTouched.length > 0,
  );
  const hasOracle = !!commands.build || !!commands.test || !!commands.lint;

  if (usable.length === 0) {
    return {
      decision: "near-miss",
      rationale:
        "No agent produced a usable change (all empty, errored, or timed out).",
    };
  }

  if (!hasOracle) {
    const { winner } = heuristicJudge(usable);
    return {
      recommended: winner,
      decision: "no-oracle",
      rationale:
        "No executable test/build oracle was found, so this is a best-effort pick " +
        "by smallest diff — NOT verified by tests. Review carefully.",
    };
  }

  const survivors = usable.filter((c) => byId.get(c.agentId)?.passed);

  if (survivors.length === 0) {
    // Surface the closest near-miss (fewest failing signals / smallest diff).
    const { winner } = heuristicJudge(usable);
    return {
      recommended: winner,
      decision: "near-miss",
      rationale:
        "No candidate passed the oracle. Surfacing the closest attempt; its failing " +
        "checks are in the comparison. Do not apply without fixing the failures.",
    };
  }

  if (survivors.length === 1) {
    const winner = survivors[0]!;
    return {
      recommended: winner,
      decision: candidates.length === 1 ? "single" : "tests",
      rationale:
        candidates.length === 1
          ? "Single agent; passed the oracle."
          : `Oracle filtered ${usable.length} candidates down to the only one that passed.`,
    };
  }

  const { winner, rationale } = heuristicJudge(survivors);
  return { recommended: winner, decision: "judge", rationale };
}

// ── Helpers ──

export function selectAgents(task: Task, config: FritesConfig): AgentSpec[] {
  if (task.agents && task.agents.length > 0) return task.agents;
  const base = config.defaultAgents;
  if (base.length === 0) throw new Error("No default agents configured");
  const n = Math.max(1, Math.min(task.n ?? config.defaultN, 5));
  const out: AgentSpec[] = [];
  for (let i = 0; i < n; i++) {
    const template = base[i % base.length]!;
    const id =
      i < base.length ? template.id : `${template.id}-${Math.floor(i / base.length) + 1}`;
    out.push({ ...template, id });
  }
  return out;
}

export function buildPrompt(task: Task, spec: AgentSpec, directive?: string): string {
  const parts = [task.instructions];
  if (task.acceptanceCriteria) {
    parts.push(`\n\nAcceptance criteria:\n${task.acceptanceCriteria}`);
  }
  if (spec.framing) parts.push(`\n\nApproach: ${spec.framing}`);
  parts.push(
    "\n\nWork only within this repository. Match the existing conventions, style, and " +
      "structure. Make the change complete and runnable; if tests exist, keep them green.",
  );
  if (directive && directive.trim()) parts.push(`\n\n${directive}`);
  return parts.join("");
}

function costNote(candidates: Candidate[]): string {
  const costs = candidates
    .map((c) => c.costUsd)
    .filter((v): v is number => typeof v === "number");
  if (costs.length === 0) {
    return "Cost telemetry not available from these child backends.";
  }
  const total = costs.reduce((a, b) => a + b, 0);
  return `Approx total child spend: $${total.toFixed(3)} across ${costs.length} agent(s).`;
}
