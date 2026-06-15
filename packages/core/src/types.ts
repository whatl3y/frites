/** The kinds of child agent frites can dispatch. Extensible (api-* children land later). */
export type ChildKind = "claude-cli" | "codex-cli";

export interface AgentSpec {
  id: string;
  kind: ChildKind;
  model?: string;
  /** Prompt-framing variant used for diversity, e.g. "minimal change" vs "clean refactor". */
  framing?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
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

export interface Candidate {
  agentId: string;
  kind: ChildKind;
  worktreePath: string;
  branch: string;
  diff: string;
  filesTouched: string[];
  status: CandidateStatus;
  /** Final assistant message / summary emitted by the agent, if any. */
  summary?: string;
  error?: string;
  logPath?: string;
  costUsd?: number;
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
  | "near-miss" // no survivor passed the oracle; closest surfaced
  | "no-oracle"; // no executable oracle existed; best-effort pick

export interface RunResult {
  runId: string;
  recommended?: Candidate;
  candidates: Candidate[];
  oracle: OracleResult[];
  decision: ReconcileDecision;
  rationale: string;
  costNote: string;
}

export interface OracleCommands {
  build?: string;
  test?: string;
  lint?: string;
}
