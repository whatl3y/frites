import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getByPath,
  loadConfig,
  mergeDeep,
  parseConfigValue,
  repoConfigPath,
  resolveConfig,
  setByPath,
  unsetByPath,
  writeConfigFile,
} from "@frites/core";

describe("config helpers", () => {
  it("mergeDeep: later layers win; nested objects merge field-wise", () => {
    const merged = mergeDeep(
      { a: 1, oracle: { test: "a", autoDetect: true } },
      { a: 2, oracle: { test: "b" } },
    );
    expect(merged.a).toBe(2);
    expect(merged.oracle).toEqual({ test: "b", autoDetect: true });
  });

  it("get/set/unset by dot path", () => {
    let o: Record<string, unknown> = {};
    o = setByPath(o, "oracle.test", "pnpm test");
    expect(getByPath(o, "oracle.test")).toBe("pnpm test");
    o = setByPath(o, "defaultN", 3);
    expect(getByPath(o, "defaultN")).toBe(3);
    o = unsetByPath(o, "oracle.test");
    expect(getByPath(o, "oracle.test")).toBeUndefined();
  });

  it("parseConfigValue coerces JSON and falls back to raw string", () => {
    expect(parseConfigValue("3")).toBe(3);
    expect(parseConfigValue("true")).toBe(true);
    expect(parseConfigValue("pnpm test")).toBe("pnpm test");
    expect(parseConfigValue('["a","b"]')).toEqual(["a", "b"]);
  });

  it("progress defaults: streaming on, telemetry-only detail; accepts interleaved", () => {
    const def = resolveConfig({});
    expect(def.streamProgress).toBe(true);
    expect(def.progressDetail).toBe("telemetry");
    expect(resolveConfig({ progressDetail: "interleaved" }).progressDetail).toBe("interleaved");
    expect(() => resolveConfig({ progressDetail: "nonsense" })).toThrow();
  });

  it("allows defaultN up to the shared fan-out guardrail", () => {
    expect(resolveConfig({ defaultN: 10 }).defaultN).toBe(10);
    expect(() => resolveConfig({ defaultN: 11 })).toThrow();
  });
});

describe("loadConfig layering", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "frites-cfg-"));
    prev = process.env.FRITES_GLOBAL_CONFIG;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.FRITES_GLOBAL_CONFIG;
    else process.env.FRITES_GLOBAL_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("repo overrides global overrides schema defaults", () => {
    const gPath = join(dir, "global.json");
    process.env.FRITES_GLOBAL_CONFIG = gPath;
    writeConfigFile(gPath, { defaultN: 4, perChildBudgetUsd: 9 });
    const repo = join(dir, "repo");
    writeConfigFile(repoConfigPath(repo), { defaultN: 2 });

    const cfg = loadConfig(repo);
    expect(cfg.defaultN).toBe(2); // repo wins
    expect(cfg.perChildBudgetUsd).toBe(9); // inherited from global
    expect(cfg.maxDepth).toBe(1); // schema default
  });

  it("falls back to global when the repo has no config", () => {
    const gPath = join(dir, "global.json");
    process.env.FRITES_GLOBAL_CONFIG = gPath;
    writeConfigFile(gPath, { defaultN: 5 });
    const cfg = loadConfig(join(dir, "repo-empty"));
    expect(cfg.defaultN).toBe(5);
  });
});
