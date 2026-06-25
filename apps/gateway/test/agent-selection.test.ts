import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@frites/core";
import { candidateSpecs, preferredIndex } from "../src/agent-selection.js";

const defaults: AgentSpec[] = [
  { id: "claude-1", kind: "claude-cli" },
  { id: "codex-1", kind: "codex-cli" },
];

describe("candidateSpecs", () => {
  it("fans out across the default agents for a normal (non-background) turn", () => {
    expect(candidateSpecs(defaults, null)).toEqual(defaults);
    expect(candidateSpecs(defaults)).toEqual(defaults);
  });

  it("pins a background turn to the cheap override and does NOT add premium failover targets", () => {
    const override: AgentSpec = { id: "background", kind: "claude-cli", model: "haiku" };
    const result = candidateSpecs(defaults, override);
    // Only the cheap override — never the full-price default agents. A suppressed cheap provider
    // fails the cheap turn rather than silently escalating to a premium council agent.
    expect(result).toEqual([override]);
    expect(result).toHaveLength(1);
    expect(result.some((s) => s.id !== "background")).toBe(false);
  });
});

describe("preferredIndex", () => {
  it("starts the synthesizer at index 0", () => {
    expect(preferredIndex({ role: "synth", index: -1 }, defaults)).toBe(0);
  });

  it("round-robins children across the candidate list", () => {
    expect(preferredIndex({ role: "child", index: 0 }, defaults)).toBe(0);
    expect(preferredIndex({ role: "child", index: 1 }, defaults)).toBe(1);
    expect(preferredIndex({ role: "child", index: 2 }, defaults)).toBe(0);
  });

  it("is safe on an empty candidate list", () => {
    expect(preferredIndex({ role: "child", index: 3 }, [])).toBe(0);
  });
});
