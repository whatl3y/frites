import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSpec,
  type FritesConfig,
  type EngineDeps,
  type EngineEvent,
  type RunResult,
  detectOracle,
  diffSize,
  runOracle,
} from "@frites/core";
import { defaultRunners, makeRunAgent } from "@frites/agents";
import { WorktreeManager } from "@frites/isolation";

export async function buildEngineDeps(
  repoPath: string,
  config: FritesConfig,
  signal?: AbortSignal,
): Promise<EngineDeps> {
  const oracleCommands = await detectOracle(repoPath, { ...config.oracle });
  return {
    worktrees: new WorktreeManager(),
    runAgent: makeRunAgent({
      runners: defaultRunners,
      config,
      passApiKeys:
        config.passApiKeys || process.env.FRITES_PASS_API_KEYS === "1",
    }),
    runOracle,
    oracleCommands,
    config,
    newRunId: () => randomUUID().slice(0, 8),
    signal,
  };
}

export function parseAgents(spec?: string): AgentSpec[] | undefined {
  if (!spec) return undefined;
  const specs: AgentSpec[] = [];
  spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((k, i) => {
      const kind = k.startsWith("codex")
        ? "codex-cli"
        : k.startsWith("claude")
          ? "claude-cli"
          : null;
      if (kind) specs.push({ id: `${kind}-${i + 1}`, kind });
    });
  return specs.length ? specs : undefined;
}

export async function persistRun(
  repoPath: string,
  result: RunResult,
): Promise<{ dir: string; files: Array<{ agentId: string; path: string }> }> {
  const dir = join(repoPath, ".frites", "runs", result.runId);
  await mkdir(dir, { recursive: true });
  const files: Array<{ agentId: string; path: string }> = [];
  for (const c of result.candidates) {
    if (c.diff) {
      const path = join(dir, `${c.agentId}.diff`);
      await writeFile(path, c.diff);
      files.push({ agentId: c.agentId, path });
    }
  }
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  return { dir, files };
}

export async function readResult(
  repoPath: string,
  runId: string,
): Promise<RunResult> {
  const raw = await readFile(
    join(repoPath, ".frites", "runs", runId, "result.json"),
    "utf8",
  );
  return JSON.parse(raw) as RunResult;
}

export function describeEvent(e: EngineEvent): string {
  switch (e.type) {
    case "run-started":
      return `Consulting ${e.n} agent(s)…`;
    case "base-resolved":
      return `Base ${e.ref} @ ${e.sha.slice(0, 7)}`;
    case "agent-started":
      return `${e.agentId} (${e.kind}) started`;
    case "agent-progress":
      return `${e.agentId}: ${e.message}`;
    case "agent-finished":
      return `${e.agentId} finished (${e.status}, ${e.filesTouched} file(s))`;
    case "oracle-started":
      return `Testing ${e.agentId}…`;
    case "oracle-finished":
      return `${e.agentId} oracle: ${e.passed ? "PASS" : "FAIL"}`;
    case "reconcile":
      return `Reconciling (${e.decision}, ${e.survivors} survivor(s))`;
    case "warning":
      return `⚠ ${e.message}`;
    case "done":
      return `Done${e.recommended ? `: recommending ${e.recommended}` : ""}`;
  }
}

export function toStructured(result: RunResult): Record<string, unknown> {
  const oracleById = new Map(result.oracle.map((o) => [o.agentId, o]));
  return {
    runId: result.runId,
    decision: result.decision,
    rationale: result.rationale,
    recommended: result.recommended?.agentId ?? null,
    costNote: result.costNote,
    candidates: result.candidates.map((c) => ({
      agentId: c.agentId,
      kind: c.kind,
      status: c.status,
      filesTouched: c.filesTouched.length,
      diffSize: diffSize(c.diff),
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cachedTokens: c.cacheReadTokens,
      costUsd: c.costUsd,
      oraclePassed: oracleById.get(c.agentId)?.passed ?? false,
      error: c.error,
    })),
  };
}

/** Compact token count, e.g. 11163 → "11.2k". */
function fmtTok(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Per-candidate token cell as `in→out` (output is reasoning-inclusive). Returns "n/a" only when a
 * backend reported nothing — codex now reports both, so it no longer reads as zero next to claude.
 */
function tokensCell(c: { inputTokens?: number; outputTokens?: number }): string {
  const i = c.inputTokens ?? 0;
  const o = c.outputTokens ?? 0;
  if (!i && !o) return "n/a";
  return `${fmtTok(i)}→${fmtTok(o)}`;
}

export function formatResultText(result: RunResult): string {
  const oracleById = new Map(result.oracle.map((o) => [o.agentId, o]));
  const lines: string[] = [];
  lines.push(`# frites run ${result.runId} — decision: ${result.decision}`);
  lines.push("");
  lines.push(result.rationale);
  lines.push("");
  if (result.recommended) {
    lines.push(
      `**Recommended:** ${result.recommended.agentId} ` +
        `(${result.recommended.filesTouched.length} file(s), ${diffSize(result.recommended.diff)} changed lines)`,
    );
  } else {
    lines.push("**Recommended:** none — no usable candidate.");
  }
  lines.push("");
  lines.push("| agent | kind | status | files | Δlines | tokens (in→out) | oracle |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const c of result.candidates) {
    const o = oracleById.get(c.agentId);
    const oracle = o?.hadOracle ? (o.passed ? "pass" : "fail") : "n/a";
    lines.push(
      `| ${c.agentId} | ${c.kind} | ${c.status} | ${c.filesTouched.length} | ${diffSize(c.diff)} | ${tokensCell(c)} | ${oracle} |`,
    );
  }
  lines.push("");
  lines.push(`_${result.costNote}_`);
  lines.push("");
  lines.push(
    `Review the linked diffs. To land the recommended one on a fresh branch, call ` +
      `\`frites_apply\` with runId="${result.runId}".`,
  );
  return lines.join("\n");
}
