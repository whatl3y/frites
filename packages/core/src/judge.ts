import type { Candidate } from "./types";

/** Count changed (added/removed) lines in a unified diff, excluding headers. */
export function diffSize(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) n++;
  }
  return n;
}

export interface JudgeVerdict {
  winner: Candidate;
  rationale: string;
}

/**
 * Heuristic tie-breaker among test-passing survivors: prefer the smallest diff
 * (smallest blast radius), then fewest files touched. This is the v1 default; an
 * LLM pairwise judge (called with frites's own credentials) lands in a later phase.
 */
export function heuristicJudge(survivors: Candidate[]): JudgeVerdict {
  if (survivors.length === 0) {
    throw new Error("heuristicJudge called with no survivors");
  }
  const ranked = [...survivors].sort((a, b) => {
    const da = diffSize(a.diff);
    const db = diffSize(b.diff);
    if (da !== db) return da - db;
    return a.filesTouched.length - b.filesTouched.length;
  });
  const winner = ranked[0]!;
  const rationale =
    survivors.length === 1
      ? `Only candidate to pass the oracle.`
      : `Chosen from ${survivors.length} test-passing candidates by smallest blast radius ` +
        `(${diffSize(winner.diff)} changed lines across ${winner.filesTouched.length} file(s)).`;
  return { winner, rationale };
}
