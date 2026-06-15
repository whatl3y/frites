import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type DistraiConfig, resolveConfig } from "./config";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge plain objects (later layers win); arrays and scalars are replaced wholesale. */
export function mergeDeep(
  ...layers: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      const prev = out[k];
      out[k] = isPlainObject(prev) && isPlainObject(v) ? mergeDeep(prev, v) : v;
    }
  }
  return out;
}

export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) => (isPlainObject(acc) ? acc[key] : undefined),
      obj,
    );
}

export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const clone = structuredClone(obj);
  const keys = path.split(".");
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
  return clone;
}

export function unsetByPath(
  obj: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const clone = structuredClone(obj);
  const keys = path.split(".");
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (!isPlainObject(cur[k])) return clone;
    cur = cur[k] as Record<string, unknown>;
  }
  delete cur[keys[keys.length - 1]!];
  return clone;
}

/** Parse a CLI value: JSON when possible (numbers/bools/arrays/objects), else a raw string. */
export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function globalConfigPath(): string {
  return (
    process.env.DISTRAI_GLOBAL_CONFIG ||
    join(homedir(), ".distrai", "config.json")
  );
}

export function repoConfigPath(repoPath: string): string {
  return join(repoPath, ".distrai", "config.json");
}

export function readConfigFile(
  path: string,
): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(
      `Invalid JSON in ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Config at ${path} must be a JSON object`);
  }
  return parsed;
}

export function writeConfigFile(
  path: string,
  obj: Record<string, unknown>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

export interface ConfigSources {
  global?: string;
  repo?: string;
}

export function configSources(repoPath?: string): ConfigSources {
  const out: ConfigSources = {};
  if (existsSync(globalConfigPath())) out.global = globalConfigPath();
  if (repoPath && existsSync(repoConfigPath(repoPath))) {
    out.repo = repoConfigPath(repoPath);
  }
  return out;
}

/**
 * Resolve effective config by layering: schema defaults < ~/.distrai/config.json <
 * <repo>/.distrai/config.json. Repo settings win over global, global over defaults.
 */
export function loadConfig(repoPath?: string): DistraiConfig {
  const layers: Array<Record<string, unknown> | undefined> = [
    readConfigFile(globalConfigPath()),
  ];
  if (repoPath) layers.push(readConfigFile(repoConfigPath(repoPath)));
  return resolveConfig(mergeDeep(...layers));
}

/** A sensible starter config written by `distrai config init`. */
export function starterConfig(): Record<string, unknown> {
  return {
    defaultN: 2,
    defaultAgents: [
      {
        id: "claude-1",
        kind: "claude-cli",
        model: "opus",
        framing: "Make the smallest correct change that satisfies the task.",
      },
      {
        id: "codex-1",
        kind: "codex-cli",
        model: "gpt-5.5",
        framing: "Prefer a clean, well-structured solution.",
      },
    ],
    perChildTimeoutMs: 600_000,
    perChildBudgetUsd: 2,
    // Make every child analyze + execute exhaustively (not just claude): codex reasons at "high",
    // and a shared thoroughness directive (config schema default) is woven into all child prompts.
    // Set codexReasoningEffort to "minimal"/"low"/"medium" or childDirective to "" to dial back.
    codexReasoningEffort: "high",
    oracle: { autoDetect: true },
    passApiKeys: false,
  };
}
