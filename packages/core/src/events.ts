import type { CandidateStatus, ChildKind, ReconcileDecision } from "./types.js";

/** Engine progress events. The MCP surface maps these to notifications/progress. */
export type EngineEvent =
  | { type: "run-started"; runId: string; n: number }
  | { type: "base-resolved"; ref: string; sha: string }
  | { type: "agent-started"; agentId: string; kind: ChildKind }
  | { type: "agent-progress"; agentId: string; message: string }
  | {
      type: "agent-finished";
      agentId: string;
      status: CandidateStatus;
      filesTouched: number;
    }
  | { type: "oracle-started"; agentId: string }
  | { type: "oracle-finished"; agentId: string; passed: boolean }
  | { type: "reconcile"; decision: ReconcileDecision; survivors: number }
  | { type: "warning"; message: string }
  | { type: "done"; runId: string; recommended?: string };

export type EngineEventHandler = (e: EngineEvent) => void;

export const noopEventHandler: EngineEventHandler = () => {};
