import { describe, expect, it } from "vitest";
import {
  type ToolDef,
  parseAction,
  resolveConfig,
  runActionCouncil,
  tryParseAction,
} from "@frites/core";

describe("parseAction", () => {
  it("parses a tool action", () => {
    expect(
      parseAction('{"kind":"tool","name":"Edit","input":{"file_path":"a.ts"},"reason":"x"}'),
    ).toEqual({ kind: "tool", name: "Edit", input: { file_path: "a.ts" }, reason: "x" });
  });
  it("strips ```json fences", () => {
    expect(parseAction('```json\n{"kind":"answer","text":"hi"}\n```')).toEqual({
      kind: "answer",
      text: "hi",
    });
  });
  it("extracts the JSON object from surrounding prose", () => {
    const a = parseAction('Sure! {"kind":"tool","name":"Bash","input":{"command":"ls"}} ok');
    expect(a.kind).toBe("tool");
    if (a.kind === "tool") {
      expect(a.name).toBe("Bash");
      expect(a.input).toEqual({ command: "ls" });
    }
  });
  it("falls back to a plain answer on non-JSON", () => {
    expect(parseAction("just text")).toEqual({ kind: "answer", text: "just text" });
  });
});

describe("parseAction robustness (review regressions)", () => {
  it("keeps a tool call whose value contains braces, with trailing prose", () => {
    const raw =
      '{"kind":"tool","name":"Edit","input":{"file_path":"x.ts","new_string":"export const cfg = { debug: true };"}}\n\nThis adds {a config}.';
    const a = parseAction(raw);
    expect(a.kind).toBe("tool");
    if (a.kind === "tool") expect(String(a.input.new_string)).toContain("{ debug: true }");
  });
  it("parses JSON after leading prose containing a brace", () => {
    const raw = 'I will edit {like so}: {"kind":"tool","name":"Edit","input":{"new_string":"f(){}"}}';
    expect(parseAction(raw).kind).toBe("tool");
  });
  it("picks the first valid action when two objects are present", () => {
    const raw = '{"kind":"tool","name":"Read","input":{"file_path":"a"}} {"kind":"answer","text":"later"}';
    expect(parseAction(raw)).toMatchObject({ kind: "tool", name: "Read" });
  });
  it("recovers a stringified input object", () => {
    const a = parseAction('{"kind":"tool","name":"Bash","input":"{\\"command\\":\\"ls\\"}"}');
    expect(a).toMatchObject({ kind: "tool", input: { command: "ls" } });
  });
  it("tryParseAction rejects a hallucinated tool name against the allowlist", () => {
    const names = new Set(["Read", "Edit"]);
    expect(tryParseAction('{"kind":"tool","name":"Nuke","input":{}}', names)).toBeNull();
    expect(tryParseAction('{"kind":"tool","name":"Edit","input":{}}', names)).toMatchObject({
      kind: "tool",
      name: "Edit",
    });
  });
  it("tolerates trailing commas", () => {
    expect(parseAction('{"kind":"answer","text":"ok",}')).toEqual({ kind: "answer", text: "ok" });
  });
});

describe("runActionCouncil", () => {
  const tools: ToolDef[] = [{ name: "Read", description: "read a file" }, { name: "Edit" }];

  it("fans out, then synthesizes the final action", async () => {
    const config = resolveConfig({
      fanOutPolicy: "always",
      defaultN: 2,
      defaultAgents: [
        { id: "a", kind: "claude-cli" },
        { id: "b", kind: "codex-cli" },
      ],
    });
    const complete = async (_p: string, ctx: { role: "child" | "synth"; index: number }) =>
      ctx.role === "synth"
        ? '{"kind":"tool","name":"Edit","input":{"file_path":"x"}}'
        : '{"kind":"tool","name":"Read","input":{"file_path":"x"}}';
    const r = await runActionCouncil("do the task", tools, { complete, config });
    expect(r.fannedOut).toBe(true);
    expect(r.proposals).toHaveLength(2);
    expect(r.action).toMatchObject({ kind: "tool", name: "Edit" });
  });

  it("uses a single agent (no synth) when policy=never", async () => {
    const config = resolveConfig({ fanOutPolicy: "never" });
    let synthCalled = false;
    const complete = async (_p: string, ctx: { role: "child" | "synth"; index: number }) => {
      if (ctx.role === "synth") synthCalled = true;
      return '{"kind":"answer","text":"ok"}';
    };
    const r = await runActionCouncil("hi", tools, { complete, config });
    expect(r.fannedOut).toBe(false);
    expect(synthCalled).toBe(false);
    expect(r.action).toEqual({ kind: "answer", text: "ok" });
  });
});
