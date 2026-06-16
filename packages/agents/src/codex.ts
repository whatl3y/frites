import type { CliRunnerDef } from "./runner.js";

/**
 * Headless Codex. Reuses the machine's ChatGPT sign-in (~/.codex/auth.json). Approval is
 * set via `-c approval_policy="never"` (the `--ask-for-approval` flag exits 2); the
 * `workspace-write` sandbox lets it edit within the worktree. NDJSON event schema drifts
 * between versions, so the parser is intentionally defensive.
 */
export const codexRunner: CliRunnerDef = {
  kind: "codex-cli",
  command: "codex",
  buildArgv(spec, ctx) {
    const argv = [
      "exec",
      "--ignore-user-config", // don't load config.toml (may route to gateway → recursion); auth via CODEX_HOME
      "--json",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-C",
      ctx.cwd,
      "-c",
      'approval_policy="never"',
    ];
    // Reasoning depth (`model_reasoning_effort`): defaulted to "high" upstream so codex analyzes as
    // hard as claude before acting. The value is validated by the model API, NOT silently ignored:
    // "high"/"medium"/"low" work, but "minimal" 400s on the default codex model because it's
    // incompatible with the built-in web_search/image_gen tools. We ship "high", so the default
    // path is safe; only an explicit "minimal" override trips this.
    if (spec.reasoningEffort) {
      argv.push("-c", `model_reasoning_effort="${spec.reasoningEffort}"`);
    }
    if (spec.model) argv.push("-m", spec.model);
    // `-` makes codex read the prompt from stdin (piped by the runner) instead of
    // argv; transcripts routinely exceed ARG_MAX, which would spawn E2BIG.
    argv.push("-");
    return argv;
  },
  onLine(line, emit, acc) {
    const obj = JSON.parse(line) as Record<string, any>;
    const t: unknown = obj.type ?? obj.msg?.type;
    if (typeof t === "string") {
      if (t.includes("command") || t.includes("exec")) emit("running a command");
      else if (t.includes("patch") || t.includes("apply")) emit("editing files");
      else if (t.includes("message") || t.includes("agent")) emit("thinking");
    }
    const text: unknown = obj.message ?? obj.msg?.message ?? obj.text;
    if (typeof text === "string" && text.trim()) {
      acc.summary = text.trim().slice(0, 2000);
    }
    const usage: any = obj.usage ?? obj.msg?.usage;
    if (usage && typeof usage.cost_usd === "number") acc.costUsd = usage.cost_usd;
  },
};
