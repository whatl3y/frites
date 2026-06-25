import { describe, expect, it } from "vitest";
import type { AgentSpec, BackendFailure } from "@frites/core";
import {
  BackendSuppressionController,
  isRetryableWithAnotherProvider,
  isSuppressibleFailure,
  suppressionDurationMs,
} from "../src/backend-policy";

const agents: AgentSpec[] = [
  { id: "claude", kind: "claude-cli" },
  { id: "codex", kind: "codex-cli" },
];

function failure(kind: BackendFailure["kind"], provider = "claude-cli" as const): BackendFailure {
  return { kind, provider, message: kind };
}

describe("backend suppression policy", () => {
  it("uses backend reset timestamps when available", () => {
    const f = { ...failure("usage-limit"), resetAt: 2000 };
    expect(suppressionDurationMs(f, 1_500_000)).toBe(500_000);
  });

  it("suppresses retryable provider/account failures but not prompt-shape failures", () => {
    expect(isSuppressibleFailure(failure("usage-limit"))).toBe(true);
    expect(isRetryableWithAnotherProvider(failure("rate-limit"))).toBe(true);
    expect(isSuppressibleFailure(failure("context-length"))).toBe(false);
    expect(isRetryableWithAnotherProvider(failure("unknown"))).toBe(false);
  });

  it("selects the next unsuppressed provider in round-robin order", () => {
    const policy = new BackendSuppressionController(() => 0);
    policy.recordFailure(failure("usage-limit"));

    expect(policy.selectAgent(agents, { preferredIndex: 0 })?.kind).toBe("codex-cli");
    expect(policy.selectAgent(agents, { preferredIndex: 1 })?.kind).toBe("codex-cli");
  });

  it("respects per-call attempted providers", () => {
    const policy = new BackendSuppressionController(() => 0);
    expect(
      policy.selectAgent(agents, {
        preferredIndex: 0,
        attempted: new Set(["claude-cli"]),
      })?.kind,
    ).toBe("codex-cli");
  });

  it("expires suppressions", () => {
    let now = 0;
    const policy = new BackendSuppressionController(() => now);
    policy.recordFailure({ ...failure("rate-limit"), retryAfterSeconds: 1 });

    expect(policy.isSuppressed("claude-cli")).toBeTruthy();
    now = 1001;
    expect(policy.isSuppressed("claude-cli")).toBeUndefined();
    expect(policy.selectAgent(agents, { preferredIndex: 0 })?.kind).toBe("claude-cli");
  });
});
