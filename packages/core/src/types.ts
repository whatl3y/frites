/** The kinds of child agent frites can dispatch. Extensible (api-* children land later). */
export type ChildKind = "claude-cli" | "codex-cli";

export interface AgentSpec {
  id: string;
  kind: ChildKind;
  model?: string;
  /** Prompt-framing variant used for diversity, e.g. "minimal change" vs "clean refactor". */
  framing?: string;
  maxBudgetUsd?: number;
  /** Idle timeout override (max silence before reap). Falls back to config.perChildTimeoutMs. */
  timeoutMs?: number;
  /** Optional absolute wall-clock ceiling override. Falls back to config.perChildHardTimeoutMs (off when unset). */
  hardTimeoutMs?: number;
  /**
   * Codex-only reasoning depth (`model_reasoning_effort`). Falls back to config.codexReasoningEffort
   * when omitted. Ignored by claude children.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export interface Task {
  instructions: string;
  repoPath: string;
  /** Base ref to branch each worktree from. Defaults to HEAD. */
  baseRef?: string;
  acceptanceCriteria?: string;
  /** Number of children; defaults from config when omitted. Ignored if `agents` is set. */
  n?: number;
  agents?: AgentSpec[];
}

export type CandidateStatus = "succeeded" | "empty" | "errored" | "timed-out";

export type BackendFailureKind =
  | "rate-limit"
  | "usage-limit"
  | "quota-exceeded"
  | "auth"
  | "context-length"
  | "backend-overloaded"
  | "cancelled"
  | "unknown";

export interface BackendFailure {
  kind: BackendFailureKind;
  provider?: ChildKind;
  message: string;
  statusCode?: number;
  limitType?: string;
  rawStatus?: string;
  resetAt?: number;
  resetAtIso?: string;
  retryAfterSeconds?: number;
}

export interface Candidate {
  agentId: string;
  kind: ChildKind;
  /** Model this candidate ran (from its AgentSpec), needed to resolve pricing for cost estimates. */
  model?: string;
  worktreePath: string;
  branch: string;
  diff: string;
  filesTouched: string[];
  status: CandidateStatus;
  /** Final assistant message / summary emitted by the agent, if any. */
  summary?: string;
  error?: string;
  backendFailure?: BackendFailure;
  logPath?: string;
  costUsd?: number;
  /**
   * Normalized, provider-comparable token usage. `inputTokens` is the TOTAL input (all categories
   * summed); `cacheReadTokens`/`cacheCreationTokens` are its cached/cache-write subsets. `outputTokens`
   * is reasoning-inclusive on both providers. Lets the report show codex's footprint instead of zero
   * even when its backend reports no cost.
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** True when this candidate was produced by the synthesis stage (not a fanned-out child). */
  synthesis?: boolean;
  /** For a synthesis candidate: the agent ids whose passing diffs it integrated. */
  synthesizedFrom?: string[];
}

export interface CommandResult {
  command: string;
  ran: boolean;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Truncated tail of combined stdout+stderr. */
  output: string;
}

export interface OracleResult {
  agentId: string;
  build?: CommandResult;
  lint?: CommandResult;
  test?: CommandResult;
  /** Overall pass: every configured command that ran exited 0. */
  passed: boolean;
  /** True when at least one discriminating command actually ran for this candidate. */
  hadOracle: boolean;
}

export type ReconcileDecision =
  | "single" // only one agent; it succeeded
  | "tests" // oracle filtered many down to exactly one survivor
  | "judge" // multiple survivors; LLM/heuristic tie-break
  | "synthesis" // an oracle-passing synthesized candidate was preferred over the originals
  | "near-miss" // no survivor passed the oracle; closest surfaced
  | "no-oracle"; // no executable oracle existed; best-effort pick

/**
 * Outcome of the optional synthesis stage. Present on RunResult only when synthesisMode != "off".
 * `attempted` is false when synthesis was eligible-checked but skipped (with a reason); true when a
 * synthesizer actually ran. Surfaces enough for the MCP/CLI to explain what happened and why a
 * fallback occurred.
 */
export interface SynthesisInfo {
  attempted: boolean;
  /** Why synthesis was skipped (only when attempted === false). */
  skippedReason?: string;
  /** Passing candidate ids fed to the synthesizer. */
  inputs: string[];
  /** Reserved agent id of the synthesizer run (e.g. "synthesis-1"), when attempted. */
  synthesizerId?: string;
  /** The candidate whose diff seeded the synthesis worktree, if seeding succeeded. */
  seededFrom?: string;
  /** Did the synthesized candidate pass the oracle? */
  passed?: boolean;
  /** Was the synthesized candidate ultimately recommended over the originals? */
  recommended?: boolean;
  /** When synthesis ran but was not recommended, why frites fell back to an original. */
  fallbackReason?: string;
}

export interface RunResult {
  runId: string;
  recommended?: Candidate;
  candidates: Candidate[];
  oracle: OracleResult[];
  decision: ReconcileDecision;
  rationale: string;
  costNote: string;
  /** Present only when synthesis is enabled (synthesisMode != "off"). */
  synthesis?: SynthesisInfo;
}

export interface OracleCommands {
  build?: string;
  test?: string;
  lint?: string;
}
