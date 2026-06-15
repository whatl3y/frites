import type { CliRunnerDef } from "./runner";

/**
 * Headless Claude Code. Reuses the machine's subscription OAuth (keychain) — no API key
 * needed; for headless use this draws the metered Agent-SDK credit. `--strict-mcp-config`
 * + `--setting-sources user` keep the child from auto-loading frites (recursion guard).
 */
export const claudeRunner: CliRunnerDef = {
  kind: "claude-cli",
  command: "claude",
  buildArgv(spec, _ctx) {
    // Prompt is piped to stdin by the runner (see spawnAndStream), not passed as
    // an arg — large transcripts would otherwise blow past ARG_MAX (spawn E2BIG).
    const argv = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--strict-mcp-config",
      "--setting-sources",
      "project",
    ];
    if (spec.model) argv.push("--model", spec.model);
    if (spec.maxBudgetUsd) argv.push("--max-budget-usd", String(spec.maxBudgetUsd));
    return argv;
  },
  onLine(line, emit, acc) {
    const obj = JSON.parse(line) as Record<string, any>;
    if (obj.type === "system" && obj.subtype === "init") {
      emit("session started");
      return;
    }
    if (obj.type === "assistant" && obj.message?.content) {
      for (const block of obj.message.content as Array<Record<string, any>>) {
        if (block.type === "tool_use") emit(`using ${block.name}`);
        else if (
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim()
        ) {
          acc.summary = block.text.trim().slice(0, 2000);
        }
      }
      return;
    }
    if (obj.type === "result") {
      if (typeof obj.total_cost_usd === "number") acc.costUsd = obj.total_cost_usd;
      if (typeof obj.result === "string") acc.summary = obj.result.slice(0, 2000);
      emit("finished");
    }
  },
};
