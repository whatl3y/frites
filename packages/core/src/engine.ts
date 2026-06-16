import type { FritesConfig, ModelPricing } from "./config.js";
import { type EngineEventHandler, noopEventHandler } from "./events.js";
import { heuristicJudge } from "./judge.js";
import { estimateCostUsd, pricingFor } from "./pricing.js";
import {
  applySynthesisPreference,
  buildSynthesisPrompt,
  evaluateSynthesisEligibility,
  reservedSynthesisId,
  selectSynthesizer,
  type SynthesisStageResult,
} from "./synthesis.js";
import type {
  AgentSpec,
  Candidate,
  OracleCommands,
  OracleResult,
  ReconcileDecision,
  RunResult,
  SynthesisInfo,
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
  /**
   * Optional: apply a captured candidate diff into a (base-SHA) worktree to SEED synthesis from a
   * known-good tree. Optional so existing fakes/implementers keep compiling; when absent or it
   * throws, synthesis falls back to fresh-from-base.
   */
  applyDiffToWorktree?(worktreePath: string, diff: string): Promise<void>;
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
  /** Normalized, provider-comparable token usage (reasoning-inclusive output). See Candidate. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
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

    // ── SYNTHESIS (optional; off by default) ──
    const stage = await maybeRunSynthesis(
      agents,
      task,
      base,
      runId,
      candidates,
      oracle,
      deps,
      handles,
      onEvent,
    );

    // The synthesis candidate is a normal Candidate: appending it to BOTH result arrays keeps
    // costNote, persistRun, the comparison table, and toStructured working off one source of truth.
    const allCandidates = stage?.candidate
      ? [...candidates, stage.candidate]
      : candidates;
    const allOracle = stage?.oracle ? [...oracle, stage.oracle] : oracle;

    // ── RECONCILE (pure, over the ORIGINAL candidates) + synthesis-aware preference ──
    const passingOriginals = candidates.filter(
      (c) =>
        c.status === "succeeded" &&
        c.filesTouched.length > 0 &&
        oracle.find((o) => o.agentId === c.agentId)?.passed === true,
    );
    const base0 = reconcile(candidates, oracle, deps.oracleCommands);
    const { recommended, decision, rationale, info } = applySynthesisPreference(
      base0,
      stage,
      passingOriginals,
      deps.config,
    );
    onEvent({
      type: "reconcile",
      decision,
      // The survivor count describes the original candidate pool reconcile chose from; the synthesis
      // candidate is surfaced separately (synthesis events + RunResult.synthesis), so it is not added
      // here — otherwise a synthesis-fallback would show an inflated count next to a "judge" decision.
      survivors: oracle.filter((o) => o.passed).length,
    });
    onEvent({ type: "done", runId, recommended: recommended?.agentId });

    return {
      runId,
      recommended,
      candidates: allCandidates,
      oracle: allOracle,
      decision,
      rationale,
      costNote: costNote(allCandidates, deps.config.pricing),
      synthesis: info,
    };
  } finally {
    await Promise.allSettled(
      [...handles.values()].map((h) => worktrees.cleanup(task.repoPath, h)),
    );
  }
}

/**
 * Optional synthesis stage. Runs only when enabled and >= synthesisMinCandidates candidates passed
 * the oracle. Builds a fresh worktree from the same base SHA, SEEDS it with the best passing
 * candidate's diff (so the synthesizer refines a known-good tree rather than re-deriving the agreed
 * core), runs the configured synthesizer there, captures its diff, and runs the SAME oracle. The
 * synthesis worktree handle is registered in `handles` the instant it is created so the engine's
 * finally still reaps it on any later throw. Returns undefined when synthesis is disabled.
 */
async function maybeRunSynthesis(
  agents: AgentSpec[],
  task: Task,
  base: { ref: string; sha: string },
  runId: string,
  candidates: Candidate[],
  oracle: OracleResult[],
  deps: EngineDeps,
  handles: Map<string, WorktreeHandle>,
  onEvent: EngineEventHandler,
): Promise<SynthesisStageResult | undefined> {
  const { config } = deps;
  if (config.synthesisMode === "off") return undefined;

  const hasOracle =
    !!deps.oracleCommands.build ||
    !!deps.oracleCommands.test ||
    !!deps.oracleCommands.lint;
  const elig = evaluateSynthesisEligibility(candidates, oracle, config, hasOracle);
  if (!elig.eligible) {
    onEvent({ type: "synthesis-skipped", reason: elig.reason! });
    return { info: { attempted: false, skippedReason: elig.reason, inputs: [] } };
  }
  if (deps.signal?.aborted) {
    const reason = "run aborted before synthesis";
    onEvent({ type: "synthesis-skipped", reason });
    return { info: { attempted: false, skippedReason: reason, inputs: [] } };
  }

  const passing = elig.passing;
  const inputs = passing.map((c) => c.agentId);
  const seed = heuristicJudge(passing).winner; // smallest passing diff = safest seed
  const synthId = reservedSynthesisId([
    ...handles.keys(),
    ...agents.map((a) => a.id),
    ...candidates.map((c) => c.agentId),
  ]);
  const synthSpec = selectSynthesizer(agents, config, synthId);
  const info: SynthesisInfo = { attempted: true, inputs, synthesizerId: synthId };

  if (!synthSpec) {
    info.attempted = false;
    info.skippedReason = "no agent available to synthesize";
    onEvent({ type: "synthesis-skipped", reason: info.skippedReason });
    return { info };
  }

  // Create + register BEFORE doing anything else so the finally cleanup always covers this worktree.
  const handle = await deps.worktrees.create(task.repoPath, runId, synthId, base.sha);
  handles.set(synthId, handle);

  // Seed from the best passing candidate's diff (fall back to fresh-from-base if it can't apply).
  let seededFrom: string | undefined;
  if (deps.worktrees.applyDiffToWorktree && seed.diff) {
    try {
      await deps.worktrees.applyDiffToWorktree(handle.path, seed.diff);
      seededFrom = seed.agentId;
    } catch (err) {
      onEvent({
        type: "synthesis-progress",
        message: `seed from ${seed.agentId} failed to apply (${
          err instanceof Error ? err.message : String(err)
        }); synthesizing fresh from base`,
      });
    }
  }
  info.seededFrom = seededFrom;

  onEvent({ type: "synthesis-started", inputAgents: inputs, seededFrom });

  const worktreePaths = new Map<string, string>();
  for (const c of passing) {
    const h = handles.get(c.agentId);
    if (h) worktreePaths.set(c.agentId, h.path);
  }

  const baseCandidate: Candidate = {
    agentId: synthId,
    kind: synthSpec.kind,
    model: synthSpec.model,
    worktreePath: handle.path,
    branch: handle.branch,
    diff: "",
    filesTouched: [],
    status: "errored",
    synthesis: true,
    synthesizedFrom: inputs,
  };

  try {
    const out = await deps.runAgent(synthSpec, {
      cwd: handle.path,
      prompt: buildSynthesisPrompt({
        task,
        base,
        passing,
        seedId: seededFrom,
        worktreePaths,
        config,
      }),
      signal: deps.signal ?? new AbortController().signal,
      onProgress: (message) => onEvent({ type: "synthesis-progress", message }),
    });
    const { diff, filesTouched } = await deps.worktrees.captureDiff(handle.path);
    const status: Candidate["status"] =
      out.status !== "succeeded"
        ? out.status
        : filesTouched.length > 0
          ? "succeeded"
          : "empty";
    const candidate: Candidate = {
      ...baseCandidate,
      diff,
      filesTouched,
      status,
      summary: out.summary,
      error: out.error,
      logPath: out.logPath,
      costUsd: out.costUsd,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      cacheReadTokens: out.cacheReadTokens,
      cacheCreationTokens: out.cacheCreationTokens,
    };
    onEvent({
      type: "synthesis-finished",
      status,
      filesTouched: filesTouched.length,
    });

    let synthOracle: OracleResult | undefined;
    if (status === "succeeded") {
      onEvent({ type: "synthesis-oracle-started" });
      synthOracle = await deps.runOracle(handle.path, synthId, deps.oracleCommands, {
        signal: deps.signal,
        timeoutMs: deps.config.perChildTimeoutMs,
      });
      onEvent({ type: "synthesis-oracle-finished", passed: synthOracle.passed });
    }
    return { candidate, oracle: synthOracle, info };
  } catch (err) {
    const candidate: Candidate = {
      ...baseCandidate,
      error: err instanceof Error ? err.message : String(err),
    };
    onEvent({ type: "synthesis-finished", status: "errored", filesTouched: 0 });
    return { candidate, info };
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
    model: spec.model,
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
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      cacheReadTokens: out.cacheReadTokens,
      cacheCreationTokens: out.cacheCreationTokens,
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

function costNote(
  candidates: Candidate[],
  pricing?: Record<string, ModelPricing>,
): string {
  // Prefer the backend's self-reported cost (claude); fall back to a pricing-table estimate from
  // captured tokens (codex against the ChatGPT backend reports no cost_usd, which used to make it
  // look free next to claude). Estimation is opt-in — it only kicks in when rates are configured.
  let total = 0;
  let counted = 0;
  let anyEstimated = false;
  for (const c of candidates) {
    let usd = c.costUsd;
    if (usd == null) {
      usd = estimateCostUsd(pricingFor(c.model, pricing), c);
      if (usd != null) anyEstimated = true;
    }
    if (usd != null) {
      total += usd;
      counted++;
    }
  }
  if (counted === 0) {
    return "Cost telemetry not available from these child backends (configure `pricing` to estimate).";
  }
  const approx = anyEstimated ? "~" : "";
  return `Approx total child spend: ${approx}$${total.toFixed(3)} across ${counted} agent(s).`;
}
