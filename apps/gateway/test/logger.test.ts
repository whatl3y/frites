import { describe, expect, it } from "vitest";
import { createLogger, isLogLevel, resolveLogLevel } from "../src/logger";

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const log = createLogger({ now: () => "T", write: (l) => lines.push(l), ...opts });
  return { log, lines };
}

describe("createLogger level filtering", () => {
  it("drops records below the threshold", () => {
    const { log, lines } = capture({ level: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("WARN");
    expect(lines[1]).toContain("ERROR");
  });

  it("enabled() matches the threshold", () => {
    const { log } = capture({ level: "info" });
    expect(log.enabled("debug")).toBe(false);
    expect(log.enabled("info")).toBe(true);
    expect(log.enabled("error")).toBe(true);
  });
});

describe("text rendering", () => {
  it("formats timestamp, padded level, turn prefix, and fields", () => {
    const { log, lines } = capture({ level: "debug" });
    log.child({ turn: "abc123" }).info("turn done", { usd: 0.12, calls: 2 });
    expect(lines[0]).toBe('T INFO  [abc123] turn done  usd=0.12 calls=2');
  });

  it("quotes string field values containing whitespace", () => {
    const { log, lines } = capture();
    log.info("msg", { agent: "agent 1 (claude-cli)" });
    expect(lines[0]).toContain('agent="agent 1 (claude-cli)"');
  });

  it("omits undefined fields", () => {
    const { log, lines } = capture();
    log.info("msg", { usd: undefined, calls: 1 });
    expect(lines[0]).toBe("T INFO  msg  calls=1");
  });
});

describe("json rendering", () => {
  it("emits one JSON object per record with merged base fields", () => {
    const { log, lines } = capture({ json: true });
    log.child({ turn: "z" }).warn("careful", { code: 7 });
    expect(JSON.parse(lines[0])).toEqual({ ts: "T", level: "warn", msg: "careful", turn: "z", code: 7 });
  });
});

describe("resolveLogLevel", () => {
  it("env wins over config, config over default", () => {
    const prev = process.env.FRITES_LOG_LEVEL;
    delete process.env.FRITES_LOG_LEVEL;
    expect(resolveLogLevel(undefined)).toBe("info");
    expect(resolveLogLevel("warn")).toBe("warn");
    process.env.FRITES_LOG_LEVEL = "debug";
    expect(resolveLogLevel("warn")).toBe("debug");
    if (prev === undefined) delete process.env.FRITES_LOG_LEVEL;
    else process.env.FRITES_LOG_LEVEL = prev;
  });

  it("ignores garbage levels", () => {
    expect(isLogLevel("nope")).toBe(false);
    expect(resolveLogLevel("nope")).toBe("info");
  });
});
