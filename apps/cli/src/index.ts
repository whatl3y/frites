#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type AgentSpec,
  type EngineDeps,
  type EngineEvent,
  type Task,
  configSources,
  detectOracle,
  diffSize,
  getByPath,
  globalConfigPath,
  loadConfig,
  parseConfigValue,
  readConfigFile,
  repoConfigPath,
  resolveConfig,
  runEngine,
  runOracle,
  setByPath,
  starterConfig,
  unsetByPath,
  writeConfigFile,
} from "@frites/core";
import { defaultRunners, makeRunAgent } from "@frites/agents";
import { WorktreeManager } from "@frites/isolation";
import { existsSync } from "node:fs";
import { runGateway, runLogs, runService } from "./service.js";

// ── entrypoint dispatch ──

async function main(): Promise<void> {
  // `pnpm frites -- config …` forwards the `--` separator literally as argv[0]; drop it
  // so subcommand dispatch (and `--flags`) work whether or not pnpm injected it.
  const raw = process.argv.slice(2);
  const argv = raw[0] === "--" ? raw.slice(1) : raw;
  const first = argv[0];
  if (first === "config") return runConfig(argv.slice(1));
  if (first === "gateway") return runGateway(argv.slice(1));
  if (first === "service") return runService(argv.slice(1));
  if (first === "install") return runService(["install", ...argv.slice(1)]);
  if (first === "uninstall") return runService(["uninstall", ...argv.slice(1)]);
  if (first === "start") return runService(["install", ...argv.slice(1)]);
  if (first === "stop") return runService(["uninstall", ...argv.slice(1)]);
  if (first === "restart") return runService(["restart", ...argv.slice(1)]);
  if (first === "status") return runService(["status", ...argv.slice(1)]);
  if (first === "logs") return runLogs(argv.slice(1));
  if (first === "run") return runTask(argv.slice(1));
  if (first === "help" || first === "--help" || first === "-h") {
    printTopUsage();
    return;
  }
  return runTask(argv); // default: treat all args as a run task
}

function printTopUsage(): void {
  console.error(
    [
      "frites — multi-agent coding council",
      "",
      "Install: frites install [--port N]        # install/start the gateway service",
      "Manage:  frites status | restart | stop | uninstall",
      "Logs:    frites logs [-f|--follow] [-n N] [--level debug|info|warn|error]",
      "Gateway: frites gateway [--port N] [--host addr]  # run in foreground",
      'Run:     frites "<task>" [--repo path] [--n N] [--agents claude,codex] [--accept ...] [--base ref] [--apply]',
      "Config:  frites config <init|show|get|set|unset|validate|path> [--global] [--repo path]",
      "Compat:  frites service <install|uninstall|restart|status|logs> [--port N]",
    ].join("\n"),
  );
}

// ── `frites config ...` ──

interface ConfigArgs {
  sub: string;
  positional: string[];
  global: boolean;
  repo: string;
  force: boolean;
}

function parseConfigArgs(argv: string[]): ConfigArgs {
  const out: ConfigArgs = {
    sub: argv[0] ?? "",
    positional: [],
    global: false,
    repo: process.cwd(),
    force: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--global") out.global = true;
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--force") out.force = true;
    else out.positional.push(a);
  }
  return out;
}

function runConfig(argv: string[]): void {
  const args = parseConfigArgs(argv);
  const repo = resolve(args.repo);
  const targetPath = args.global ? globalConfigPath() : repoConfigPath(repo);

  switch (args.sub) {
    case "path": {
      const g = globalConfigPath();
      const r = repoConfigPath(repo);
      console.log(`global: ${g}${existsSync(g) ? "" : "  (not present)"}`);
      console.log(`repo:   ${r}${existsSync(r) ? "" : "  (not present)"}`);
      console.log(
        `\nEffective precedence: defaults < global < repo. Target for writes: ${
          args.global ? "global" : "repo"
        } (${targetPath}).`,
      );
      return;
    }
    case "init": {
      if (existsSync(targetPath) && !args.force) {
        console.error(
          `Config already exists at ${targetPath}. Use --force to overwrite.`,
        );
        process.exit(1);
      }
      writeConfigFile(targetPath, starterConfig());
      console.log(`Wrote starter config to ${targetPath}`);
      return;
    }
    case "show": {
      const cfg = loadConfig(repo);
      const sources = configSources(repo);
      console.error(
        `# sources: ${
          [
            sources.global ? `global(${sources.global})` : null,
            sources.repo ? `repo(${sources.repo})` : null,
          ]
            .filter(Boolean)
            .join(" + ") || "schema defaults only"
        }`,
      );
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }
    case "get": {
      const key = args.positional[0];
      if (!key) return fail("usage: frites config get <key>");
      const cfg = loadConfig(repo) as unknown as Record<string, unknown>;
      const v = getByPath(cfg, key);
      console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
      return;
    }
    case "set": {
      const key = args.positional[0];
      const rawValue = args.positional[1];
      if (!key || rawValue === undefined) {
        return fail('usage: frites config set <key> <value>  (e.g. set defaultN 3)');
      }
      const file = readConfigFile(targetPath) ?? {};
      const next = setByPath(file, key, parseConfigValue(rawValue));
      assertValid(next);
      writeConfigFile(targetPath, next);
      console.log(`Set ${key} in ${targetPath}`);
      return;
    }
    case "unset": {
      const key = args.positional[0];
      if (!key) return fail("usage: frites config unset <key>");
      const file = readConfigFile(targetPath) ?? {};
      const next = unsetByPath(file, key);
      assertValid(next);
      writeConfigFile(targetPath, next);
      console.log(`Unset ${key} in ${targetPath}`);
      return;
    }
    case "validate": {
      const file = readConfigFile(targetPath);
      if (!file) {
        console.log(`No config file at ${targetPath} (defaults will be used).`);
        return;
      }
      try {
        resolveConfig(file);
        console.log(`${targetPath} is valid.`);
      } catch (e) {
        return fail(
          `${targetPath} is invalid:\n${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }
    default:
      return fail(
        "usage: frites config <init|show|get|set|unset|validate|path> [--global] [--repo path] [--force]",
      );
  }
}

function assertValid(obj: Record<string, unknown>): void {
  try {
    resolveConfig(obj);
  } catch (e) {
    fail(
      `Refusing to write — resulting config is invalid:\n${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ── `frites run "<task>"` ──

interface RunArgs {
  task: string;
  repo: string;
  n?: number;
  agents?: string;
  accept?: string;
  base?: string;
  apply: boolean;
}

function parseRunArgs(argv: string[]): RunArgs {
  const out: RunArgs = { task: "", repo: process.cwd(), apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--n") out.n = Number(argv[++i]);
    else if (a === "--agents") out.agents = argv[++i];
    else if (a === "--accept") out.accept = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (!a.startsWith("--")) out.task = out.task ? `${out.task} ${a}` : a;
  }
  return out;
}

function parseAgents(spec?: string): AgentSpec[] | undefined {
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

function describe(e: EngineEvent): string {
  if (e.type === "agent-progress") return `  · ${e.agentId}: ${e.message}`;
  if (e.type === "agent-started") return `▶ ${e.agentId} (${e.kind})`;
  if (e.type === "agent-finished")
    return `■ ${e.agentId}: ${e.status} (${e.filesTouched} file(s))`;
  if (e.type === "oracle-finished")
    return `  oracle ${e.agentId}: ${e.passed ? "PASS" : "FAIL"}`;
  if (e.type === "reconcile") return `↳ ${e.decision} (${e.survivors} survivor(s))`;
  if (e.type === "run-started") return `Consulting ${e.n} agent(s)…`;
  if (e.type === "warning") return `⚠ ${e.message}`;
  return "";
}

async function runTask(argv: string[]): Promise<void> {
  const args = parseRunArgs(argv);
  if (!args.task) {
    printTopUsage();
    process.exit(1);
  }
  const repo = resolve(args.repo);
  const config = loadConfig(repo);
  const oracleCommands = await detectOracle(repo, { ...config.oracle });

  const deps: EngineDeps = {
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
  };

  const task: Task = {
    instructions: args.task,
    repoPath: repo,
    n: args.n,
    agents: parseAgents(args.agents),
    acceptanceCriteria: args.accept,
    baseRef: args.base,
  };

  const result = await runEngine(task, deps, (e) => {
    const line = describe(e);
    if (line) console.error(line);
  });

  console.log(`\n=== frites run ${result.runId} — ${result.decision} ===`);
  console.log(result.rationale);
  for (const c of result.candidates) {
    console.log(
      `  ${c.agentId} [${c.kind}] ${c.status} — ${c.filesTouched.length} file(s), ${diffSize(c.diff)} Δlines`,
    );
  }
  console.log(result.costNote);
  if (result.recommended) console.log(`\nRecommended: ${result.recommended.agentId}`);

  if (args.apply && result.recommended?.diff) {
    const { branch } = await new WorktreeManager().applyToBranch(
      repo,
      result.runId,
      result.recommended.diff,
    );
    console.log(`Applied onto new branch: ${branch}`);
  } else if (result.recommended) {
    console.log("Re-run with --apply to land it on a fresh branch.");
  }
}

main().catch((err) => {
  console.error("frites failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
