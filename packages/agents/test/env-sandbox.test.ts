import { describe, expect, it } from "vitest";
import { assertDepth, buildChildEnv } from "@frites/agents";

describe("buildChildEnv", () => {
  it("scrubs base-URL vars, withholds API keys, and bumps depth", () => {
    const env = buildChildEnv({
      parentEnv: {
        HOME: "/home/u",
        PATH: "/usr/bin",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
        OPENAI_BASE_URL: "http://127.0.0.1:9999",
        ANTHROPIC_API_KEY: "sk-ant-secret",
        SOMETHING_ELSE: "leak-me",
      },
      depth: 0,
      maxDepth: 1,
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // subscription-first: withheld
    expect(env.SOMETHING_ELSE).toBeUndefined(); // not on allowlist
    expect(env.HOME).toBe("/home/u");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FRITES_DEPTH).toBe("1");
    expect(env.FRITES_CHILD).toBe("1");
  });

  it("passes API keys only when asked, but never lets a base-URL through extraEnv", () => {
    const env = buildChildEnv({
      parentEnv: { ANTHROPIC_API_KEY: "sk-ant-secret" },
      depth: 0,
      maxDepth: 2,
      passApiKeys: true,
      extraEnv: { ANTHROPIC_BASE_URL: "http://sneaky" },
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe("assertDepth (recursion fuse)", () => {
  it("throws once depth reaches maxDepth", () => {
    expect(() => assertDepth(1, 1)).toThrow(/recursion fuse/);
    expect(() => assertDepth(2, 1)).toThrow();
  });
  it("allows spawning below maxDepth", () => {
    expect(() => assertDepth(0, 1)).not.toThrow();
  });
});
