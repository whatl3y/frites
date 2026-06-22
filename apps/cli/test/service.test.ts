import { describe, expect, it } from "vitest";
import { lastListeningMs } from "../src/service";

const listening = (ts: string) =>
  `${ts} INFO  listening on http://127.0.0.1:6767 — Anthropic (/v1/messages)`;

describe("lastListeningMs", () => {
  it("parses the epoch-ms of a single listening line", () => {
    const ts = "2026-06-18T14:26:56.265Z";
    expect(lastListeningMs(listening(ts))).toBe(Date.parse(ts));
  });

  it("returns the most recent listening line across restarts", () => {
    const older = "2026-06-17T22:38:15.136Z";
    const newer = "2026-06-18T14:26:56.265Z";
    const log = [
      listening(older),
      "2026-06-18T14:26:24.056Z INFO  [fec3f5e2] turn done → answer",
      listening(newer),
    ].join("\n");
    expect(lastListeningMs(log)).toBe(Date.parse(newer));
  });

  it("returns undefined when no line announces a start", () => {
    expect(
      lastListeningMs("2026-06-18T14:00:00.000Z INFO  turn done → answer"),
    ).toBeUndefined();
  });

  it("returns undefined when the leading token is not a timestamp", () => {
    expect(lastListeningMs("nope listening on http://127.0.0.1:6767")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(lastListeningMs("")).toBeUndefined();
  });
});
