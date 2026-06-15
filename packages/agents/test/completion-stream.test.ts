import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ChildEvent, type StreamAcc, newAcc, parseClaudeLine, parseCodexLine } from "../src/completion";

function fixture(name: string): string[] {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim());
}

function run(
  lines: string[],
  parse: (line: string, acc: StreamAcc) => ChildEvent[],
): { events: ChildEvent[]; acc: StreamAcc } {
  const acc = newAcc();
  const events: ChildEvent[] = [];
  for (const line of lines) events.push(...parse(line, acc));
  return { events, acc };
}

describe("parseClaudeLine (real --output-format stream-json fixture)", () => {
  const { events, acc } = run(fixture("claude-stream.jsonl"), parseClaudeLine);

  it("emits a start event from system/init", () => {
    expect(events[0]).toEqual({ type: "start" });
  });

  it("streams incremental text deltas that concatenate to the final answer", () => {
    const text = events
      .filter((e): e is { type: "text"; delta: string } => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("hi there friend");
    expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(1); // token-level
  });

  it("captures authoritative final text, cost, and token usage", () => {
    expect(acc.text).toBe("hi there friend");
    expect(acc.costUsd).toBeCloseTo(0.186213, 5);
    // inputTokens is the TOTAL footprint: fresh 2695 + cache-write 17206 + cache-read 0 = 19901.
    // (The raw `input_tokens` field alone is only 2695 — the uncached remainder.)
    expect(acc.inputTokens).toBe(19901);
    expect(acc.cacheCreationTokens).toBe(17206);
    expect(acc.cacheReadTokens).toBe(0);
    expect(acc.outputTokens).toBe(7);
  });

  it("emits live usage events (input from message_start, output from message_delta)", () => {
    const usage = events.filter((e) => e.type === "usage");
    expect(usage.some((e: any) => typeof e.inputTokens === "number")).toBe(true);
    expect(usage.some((e: any) => e.outputTokens === 7)).toBe(true);
  });

  it("detects tool_use via content_block_start", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Read" } },
    });
    expect(parseClaudeLine(line, newAcc())).toEqual([{ type: "tool", name: "Read" }]);
  });

  it("tolerates non-JSON / partial lines without throwing", () => {
    expect(parseClaudeLine("not json {", newAcc())).toEqual([]);
    expect(parseClaudeLine("", newAcc())).toEqual([]);
  });
});

describe("parseCodexLine (real exec --json fixture)", () => {
  const { events, acc } = run(fixture("codex-stream.jsonl"), parseCodexLine);

  it("emits a start event from thread.started", () => {
    expect(events[0]).toEqual({ type: "start" });
  });

  it("surfaces the whole agent message as one text event (item granularity)", () => {
    const text = events
      .filter((e): e is { type: "text"; delta: string } => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("hi there friend");
    expect(acc.text).toBe("hi there friend");
  });

  it("captures token usage from turn.completed (no cost from codex)", () => {
    // codex `input_tokens` is the inclusive total; `cached_input_tokens` is the cached SUBSET of
    // it (NOT additive) — so input stays 11163 and the cached portion is surfaced separately.
    expect(acc.inputTokens).toBe(11163);
    expect(acc.cacheReadTokens).toBe(9600);
    expect(acc.cacheCreationTokens).toBeUndefined(); // codex has no cache-write concept
    expect(acc.outputTokens).toBe(7);
    expect(acc.costUsd).toBeUndefined();
    expect(events.some((e: any) => e.type === "usage" && e.outputTokens === 7)).toBe(true);
  });

  it("keeps returned text byte-identical to the streamed deltas for multi-message turns", () => {
    const acc2 = newAcc();
    parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "part one" } }), acc2);
    parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "part two" } }), acc2);
    expect(acc2.text).toBe(acc2.streamed);
    expect(acc2.text).toBe("part one\npart two");
  });

  it("understands legacy msg-wrapped text as a fallback", () => {
    const acc3 = newAcc();
    parseCodexLine(JSON.stringify({ msg: { type: "agent_message", message: "legacy text" } }), acc3);
    expect(acc3.text).toBe("legacy text");
  });
});
