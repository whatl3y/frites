import { describe, expect, it } from "vitest";
import {
  ModelBackendError,
  backendFailureFrom,
  classifyBackendFailure,
} from "../src/backend-errors";
import { isSuppressibleFailure } from "../src/backend-policy";

describe("backend error classification", () => {
  it("classifies a Claude five-hour limit event when the backend reports it is blocked", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "limited",
        resetsAt: 1781531400,
        rateLimitType: "five_hour",
      },
    });

    const failure = classifyBackendFailure({ stdout: line }, "claude-cli", 1);
    expect(failure?.kind).toBe("usage-limit");
    expect(failure?.provider).toBe("claude-cli");
    expect(failure?.limitType).toBe("five_hour");
    expect(failure?.resetAtIso).toBe("2026-06-15T13:50:00.000Z");
  });

  it("does not treat an allowed Claude rate-limit telemetry event as a failure", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1781531400,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
      },
    });

    expect(classifyBackendFailure({ stdout: line }, "claude-cli")).toBeUndefined();
  });

  it("never derives a SUPPRESSIBLE failure from answer prose that mentions limit/auth phrases", () => {
    // A healthy turn whose answer body legitimately discusses rate limits/auth, with a non-zero exit
    // for an unrelated reason. The prose on stdout must never produce a suppressible kind (which would
    // disable a perfectly healthy provider for minutes-to-hours). A benign non-suppressible "unknown"
    // is acceptable — it surfaces the exit without poisoning provider health.
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      result:
        "To handle HTTP 429 rate limit and 403 Forbidden errors, retry once you hit the usage limit; check your quota.",
      total_cost_usd: 0.01,
    });
    const claudeFailure = classifyBackendFailure({ stdout }, "claude-cli", 1);
    expect(isSuppressibleFailure(claudeFailure)).toBe(false);
    expect(claudeFailure?.kind).not.toBe("usage-limit");

    // codex variant: agent prose streamed to stdout, no structured error, exit non-zero.
    const codexOut = "I recommend checking for a 503 Service Unavailable or quota exhausted state.";
    const codexFailure = classifyBackendFailure({ stdout: codexOut }, "codex-cli", 1);
    expect(isSuppressibleFailure(codexFailure)).toBe(false);
  });

  it("still classifies a real failure surfaced on the error channel even when stdout carries an answer", () => {
    const stdout = JSON.stringify({ type: "result", is_error: false, result: "here is your answer" });
    const stderr = "Error: 429 Too Many Requests";
    expect(classifyBackendFailure({ stdout, stderr }, "codex-cli", 1)?.kind).toBe("rate-limit");
  });

  it("still classifies a structured error event on stdout (result.is_error)", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      api_error_status: 429,
      result: "rate limit exceeded",
    });
    expect(classifyBackendFailure({ stdout }, "claude-cli", 1)?.kind).toBe("rate-limit");
  });

  it("classifies common stderr text from backend exits", () => {
    expect(classifyBackendFailure("Error: 429 Too Many Requests", "codex-cli", 1)?.kind).toBe(
      "rate-limit",
    );
    expect(
      classifyBackendFailure("Claude usage limit reached. Try again later.", "claude-cli", 1)
        ?.kind,
    ).toBe("usage-limit");
    expect(classifyBackendFailure("context_length_exceeded", "codex-cli", 1)?.kind).toBe(
      "context-length",
    );
  });

  it("keeps structured failure metadata on thrown backend errors", () => {
    const failure = classifyBackendFailure("429 rate limit", "codex-cli", 1)!;
    const err = new ModelBackendError(failure, "stderr tail");

    expect(backendFailureFrom(err)).toEqual(failure);
    expect(err.message).toContain("Codex backend rate limit hit");
  });
});
