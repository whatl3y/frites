import type { FritesConfig } from "./config.js";
import { withChildDirective } from "./config.js";
import { diffSize } from "./judge.js";
import type {
  AgentSpec,
  Candidate,
  OracleResult,
  ReconcileDecision,
  SynthesisInfo,
  Task,
} from "./types.js";

// ── Eligibility ──

export interface SynthesisEligibility {
  eligible: boolean;
  /** Human-readable reason when eligible === false (used for the synthesis-skipped event). */
  reason?: string;
  /** Usable, oracle-passing candidates (the synthesis inputs). */
  passing: Candidate[];
}

/**
 * Decide whether the synthesis stage should run. v1 requires: synthesis enabled, an executable
 * oracle (synthesis is only ever recommended when oracle-verified), and at least
 * `synthesisMinCandidates` candidates that both produced a usable change AND passed the oracle.
 */
export function evaluateSynthesisEligibility(
  candidates: Candidate[],
  oracle: OracleResult[],
  config: FritesConfig,
  hasOracle: boolean,
): SynthesisEligibility {
  if (config.synthesisMode === "off") {
    return { eligible: false, reason: "synthesis disabled (synthesisMode=off)", passing: [] };
  }
  if (!hasOracle) {
    return {
      eligible: false,
      reason: "no executable oracle; v1 synthesis only recommends oracle-verified candidates",
      passing: [],
    };
  }
  const byId = new Map(oracle.map((o) => [o.agentId, o]));
  const passing = candidates.filter(
    (c) =>
      c.status === "succeeded" &&
      c.filesTouched.length > 0 &&
      byId.get(c.agentId)?.passed === true,
  );
  if (passing.length < config.synthesisMinCandidates) {
    return {
      eligible: false,
      reason: `only ${passing.length} candidate(s) passed the oracle; need ${config.synthesisMinCandidates} for synthesis`,
      passing,
    };
  }
  return { eligible: true, passing };
}

// ── Synthesizer selection ──

/** A reserved synthesizer id (synthesis-1, synthesis-2, …) guaranteed not to collide with `taken`. */
export function reservedSynthesisId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; ; i++) {
    const id = `synthesis-${i}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Pick the synthesizer AgentSpec. Prefers config.synthesisAgent, else the first claude child among
 * the selected agents (claude enforces --max-budget-usd, so synthesisBudgetUsd actually bites),
 * else the first selected agent. Synthesis budget/timeout overrides are mapped onto the spec here —
 * the runner only honors AgentSpec fields, so standalone synthesis* config keys must be threaded
 * through this spec or they silently no-op.
 */
export function selectSynthesizer(
  agents: AgentSpec[],
  config: FritesConfig,
  reservedId: string,
): AgentSpec | undefined {
  const base =
    config.synthesisAgent ??
    agents.find((a) => a.kind === "claude-cli") ??
    agents[0];
  if (!base) return undefined;
  return {
    ...base,
    id: reservedId,
    // The synthesis prompt is self-contained and strict; per-agent diversity framing would dilute it.
    framing: undefined,
    maxBudgetUsd: config.synthesisBudgetUsd ?? base.maxBudgetUsd ?? config.perChildBudgetUsd,
    timeoutMs: config.synthesisTimeoutMs ?? base.timeoutMs ?? config.perChildTimeoutMs,
    hardTimeoutMs:
      config.synthesisHardTimeoutMs ?? base.hardTimeoutMs ?? config.perChildHardTimeoutMs,
  };
}

// ── Prompt construction ──

export interface SynthesisPromptOpts {
  task: Task;
  base: { ref: string; sha: string };
  /** All oracle-passing inputs (including the seed). */
  passing: Candidate[];
  /** The candidate whose diff seeded the synthesis worktree, if seeding succeeded. */
  seedId?: string;
  /** agentId -> live worktree path, for read-only reference of the non-seed inputs. */
  worktreePaths: Map<string, string>;
  config: FritesConfig;
}

/**
 * Build the (strict) synthesizer prompt. The worktree already contains the seed candidate's
 * implementation; the synthesizer integrates the OTHER passing candidates' deltas. Non-seed diffs
 * are embedded up to `synthesisMaxDiffChars` (smallest first); past the cap, a candidate is reduced
 * to its file list + read-only worktree path so nothing is silently dropped.
 */
export function buildSynthesisPrompt(opts: SynthesisPromptOpts): string {
  const { task, base, passing, seedId, worktreePaths, config } = opts;
  const others = passing.filter((c) => c.agentId !== seedId);
  const parts: string[] = [];

  parts.push(
    "You are integrating several INDEPENDENT, already-passing implementations of ONE task into a " +
      "single best implementation. Each input below was produced by a different agent in isolation " +
      "and already passed the project's build/lint/test oracle on its own.",
  );

  parts.push(`\n\nTASK:\n${task.instructions}`);
  if (task.acceptanceCriteria) {
    parts.push(`\n\nACCEPTANCE CRITERIA:\n${task.acceptanceCriteria}`);
  }
  parts.push(`\n\nBASE: ${base.ref} @ ${base.sha.slice(0, 7)}`);

  if (seedId) {
    parts.push(
      `\n\nYour working tree ALREADY CONTAINS the implementation from "${seedId}" (it passed the ` +
        `oracle). Treat it as your STARTING POINT, not as the final answer — refine and extend it.`,
    );
  } else {
    parts.push(
      `\n\nYour working tree is the clean base. Reconstruct the integrated implementation from the ` +
        `candidate material below.`,
    );
  }

  parts.push("\n\nOTHER PASSING CANDIDATES (source material — NOT mandatory patches):");
  let remaining = config.synthesisMaxDiffChars;
  const bySize = [...others].sort((a, b) => diffSize(a.diff) - diffSize(b.diff));
  for (const c of bySize) {
    const path = worktreePaths.get(c.agentId);
    const head =
      `\n\n— ${c.agentId} (${c.kind}${c.model ? `/${c.model}` : ""}), ` +
      `files: ${c.filesTouched.join(", ") || "(none)"}, oracle: pass`;
    parts.push(head);
    if (c.diff.length <= remaining) {
      remaining -= c.diff.length;
      parts.push(`\n\`\`\`diff\n${c.diff}\n\`\`\``);
    } else {
      parts.push(
        `\n[diff omitted: ${c.diff.length} chars exceeded the remaining ${remaining}-char budget]` +
          (path ? ` — full tree available read-only at: ${path}` : ""),
      );
    }
    if (c.summary) parts.push(`\nSummary: ${c.summary.slice(0, 400)}`);
  }

  const refPaths = others
    .map((c) => worktreePaths.get(c.agentId))
    .filter((p): p is string => !!p);
  if (refPaths.length > 0) {
    parts.push(
      `\n\nThe other candidates' full working trees are available READ-ONLY for inspection at:\n` +
        refPaths.map((p) => `- ${p}`).join("\n") +
        `\n(Use them if an embedded diff was capped, or to understand context. Do NOT modify them.)`,
    );
  }

  parts.push(
    "\n\nINSTRUCTIONS:\n" +
      "- Produce ONE integrated implementation in THIS working tree using the strongest ideas from the candidates.\n" +
      "- Do NOT blindly concatenate patches. Resolve conflicts by understanding the code.\n" +
      "- Keep ONLY changes that serve the task and acceptance criteria; drop redundant, stylistically inconsistent, or over-broad edits.\n" +
      "- Prefer a smaller, coherent integration over combining every idea.\n" +
      "- Match existing conventions and keep the result internally consistent across files.\n" +
      "- If tests exist, run them and keep them green before you finish.",
  );

  return withChildDirective(parts.join(""), config.childDirective);
}

// ── Reconciliation preference ──

export interface SynthesisStageResult {
  candidate?: Candidate;
  oracle?: OracleResult;
  info: SynthesisInfo;
}

export interface ReconcileResult {
  recommended?: Candidate;
  decision: ReconcileDecision;
  rationale: string;
}

/**
 * Apply the synthesis preference on top of the pure reconcile() result over the ORIGINAL candidates.
 * The synthesized candidate is preferred ONLY when it is usable, passed the same oracle, and its
 * blast radius is within synthesisMaxBlastFactor × the combined size of the passing inputs.
 * Otherwise the original reconciliation stands and the fallback reason is recorded.
 */
export function applySynthesisPreference(
  base: ReconcileResult,
  stage: SynthesisStageResult | undefined,
  passingOriginals: Candidate[],
  config: FritesConfig,
): ReconcileResult & { info?: SynthesisInfo } {
  if (!stage) return base; // synthesis disabled
  const info = stage.info;
  if (!info.attempted) return { ...base, info }; // skipped

  const cand = stage.candidate;
  const usable = !!cand && cand.status === "succeeded" && cand.filesTouched.length > 0;
  const passed = stage.oracle?.passed === true;
  info.passed = passed;

  if (!usable || !passed) {
    info.recommended = false;
    info.fallbackReason = !usable
      ? "synthesized candidate produced no usable change"
      : "synthesized candidate failed the oracle";
    return { ...base, info };
  }

  // Blast-radius ceiling: the synthesis may be larger than any single child (it integrates several),
  // but not unboundedly. Compare against factor × the COMBINED input size. No `sumSizes > 0` guard:
  // this is multiplication, so when the inputs have zero counted lines (rename/binary/mode-only) the
  // ceiling is 0 and any non-empty synthesis correctly falls back, while a zero-line synthesis (≤ 0)
  // is still allowed. A 0-line synthesis with touched files is a legitimate small change.
  const synthSize = diffSize(cand!.diff);
  const sumSizes = passingOriginals.reduce((n, c) => n + diffSize(c.diff), 0);
  if (synthSize > config.synthesisMaxBlastFactor * sumSizes) {
    info.recommended = false;
    info.fallbackReason =
      `synthesized diff (${synthSize} Δlines) exceeded ${config.synthesisMaxBlastFactor}× the ` +
      `combined input size (${sumSizes} Δlines); kept the best original passing candidate to avoid an over-broad change`;
    return { ...base, info };
  }

  info.recommended = true;
  const inputs = info.inputs.join(", ");
  return {
    recommended: cand,
    decision: "synthesis",
    rationale:
      `Synthesized candidate integrated ${inputs}` +
      (info.seededFrom ? ` (seeded from ${info.seededFrom})` : "") +
      ` and passed the same build/lint/test oracle — ${synthSize} changed lines across ` +
      `${cand!.filesTouched.length} file(s). Preferred over the best original passing candidate; review the diff before applying.`,
    info,
  };
}
