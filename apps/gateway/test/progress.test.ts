import { describe, expect, it } from "vitest";
import { createProgressSink } from "../src/progress";

describe("createProgressSink", () => {
  it("buffers messages pushed before a listener attaches, then replays them in order", () => {
    const sink = createProgressSink();
    sink.push("a");
    sink.push("b");
    const seen: string[] = [];
    sink.onMessage((t) => seen.push(t));
    expect(seen).toEqual(["a", "b"]);
  });

  it("delivers messages live once a listener is attached", () => {
    const sink = createProgressSink();
    const seen: string[] = [];
    sink.onMessage((t) => seen.push(t));
    sink.push("x");
    sink.push("y");
    expect(seen).toEqual(["x", "y"]);
  });

  it("mixes buffered + live without loss or duplication", () => {
    const sink = createProgressSink();
    sink.push("early");
    const seen: string[] = [];
    sink.onMessage((t) => seen.push(t));
    sink.push("late");
    expect(seen).toEqual(["early", "late"]);
  });

  it("drops messages after end() and reports ended", () => {
    const sink = createProgressSink();
    const seen: string[] = [];
    sink.onMessage((t) => seen.push(t));
    sink.push("before");
    sink.end();
    sink.push("after");
    expect(sink.ended).toBe(true);
    expect(seen).toEqual(["before"]);
  });
});
