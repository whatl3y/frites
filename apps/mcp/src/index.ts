#!/usr/bin/env -S npx tsx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Task, loadConfig, runEngine } from "@frites/core";
import { WorktreeManager } from "@frites/isolation";
import {
  buildEngineDeps,
  describeEvent,
  formatResultText,
  parseAgents,
  persistRun,
  readResult,
  toStructured,
} from "./runtime";

const server = new McpServer({ name: "frites", version: "0.0.0" });

server.registerTool(
  "frites_implement",
  {
    title: "frites: implement via an agent council",
    description:
      "Dispatch a coding task to multiple full agents (claude/codex) in isolated git " +
      "worktrees, filter them with the repo's tests, and return one vetted diff plus a " +
      "comparison. Long-running (minutes). Review the result, then call frites_apply.",
    inputSchema: {
      task: z.string().describe("What to implement or fix"),
      repoPath: z.string().describe("Absolute path to the target git repository"),
      n: z.number().int().min(1).max(5).optional().describe("Number of agents"),
      agents: z
        .string()
        .optional()
        .describe("Comma list of agent kinds, e.g. 'claude,codex'"),
      acceptanceCriteria: z.string().optional(),
      baseRef: z.string().optional().describe("Git ref to branch from (default HEAD)"),
    },
  },
  async (args: any, extra: any) => {
    try {
      const config = await loadConfig(args.repoPath);
      const deps = await buildEngineDeps(args.repoPath, config, extra?.signal);
      const task: Task = {
        instructions: args.task,
        repoPath: args.repoPath,
        n: args.n,
        agents: parseAgents(args.agents),
        acceptanceCriteria: args.acceptanceCriteria,
        baseRef: args.baseRef,
      };
      let step = 0;
      const result = await runEngine(task, deps, (e) => {
        const token = extra?._meta?.progressToken;
        if (token === undefined || !extra?.sendNotification) return;
        extra
          .sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: ++step, message: describeEvent(e) },
          })
          .catch(() => {});
      });
      const { files } = await persistRun(args.repoPath, result);
      const content: any[] = [{ type: "text", text: formatResultText(result) }];
      for (const f of files) {
        content.push({
          type: "resource_link",
          uri: `file://${f.path}`,
          name: `${f.agentId}.diff`,
          mimeType: "text/x-diff",
        });
      }
      return { content, structuredContent: toStructured(result) };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `frites failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "frites_apply",
  {
    title: "frites: apply a vetted result",
    description:
      "Apply the recommended diff from a previous frites_implement run onto a FRESH " +
      "branch (frites/<runId>). Requires a clean working tree. Never pushes.",
    inputSchema: {
      runId: z.string(),
      repoPath: z.string(),
    },
  },
  async (args: any) => {
    try {
      const result = await readResult(args.repoPath, args.runId);
      if (!result.recommended || !result.recommended.diff) {
        return {
          content: [
            { type: "text", text: `Run ${args.runId} has no recommended diff to apply.` },
          ],
          isError: true,
        };
      }
      const wt = new WorktreeManager();
      const { branch } = await wt.applyToBranch(
        args.repoPath,
        args.runId,
        result.recommended.diff,
      );
      return {
        content: [
          {
            type: "text",
            text: `Applied ${result.recommended.agentId}'s diff onto new branch '${branch}'. Review and commit.`,
          },
        ],
        structuredContent: { branch, runId: args.runId },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `apply failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — all logging must go to stderr.
  console.error("frites MCP server running on stdio");
}

main().catch((err) => {
  console.error("frites MCP server failed to start:", err);
  process.exit(1);
});
