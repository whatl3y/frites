import type { BackendFailure, BackendFailureKind, ChildKind } from "@frites/core";

export class ModelBackendError extends Error {
  readonly failure: BackendFailure;

  constructor(failure: BackendFailure, detail?: string) {
    const suffix = detail?.trim() ? `: ${trimOneLine(detail, 300)}` : "";
    super(`${formatBackendFailure(failure)}${suffix}`);
    this.name = "ModelBackendError";
    this.failure = failure;
  }
}

export function backendFailureFrom(value: unknown): BackendFailure | undefined {
  if (value instanceof ModelBackendError) return value.failure;
  if (value && typeof value === "object" && "failure" in value) {
    const failure = (value as { failure?: unknown }).failure;
    if (isBackendFailure(failure)) return failure;
  }
  return undefined;
}

export function formatBackendFailure(failure: BackendFailure): string {
  const provider = failure.provider ? `${providerLabel(failure.provider)} ` : "";
  const desc = kindLabel(failure.kind);
  const extras: string[] = [];
  if (failure.limitType) extras.push(`limit=${failure.limitType}`);
  if (failure.statusCode) extras.push(`status=${failure.statusCode}`);
  if (failure.rawStatus) extras.push(`backend_status=${failure.rawStatus}`);
  if (failure.resetAtIso) extras.push(`resets=${failure.resetAtIso}`);
  if (failure.retryAfterSeconds) extras.push(`retry_after=${failure.retryAfterSeconds}s`);
  return `${provider}${desc}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

/** Streams to classify. `stdout` is mined ONLY for structured error events; `stderr` for free text. */
export interface BackendStreams {
  stdout?: string;
  stderr?: string;
}

export function classifyBackendFailure(
  input: string | BackendStreams,
  provider?: ChildKind,
  exitCode?: number | null,
): BackendFailure | undefined {
  // A bare string is the ERROR channel (a spawn error / stderr tail) — there is no answer body to
  // mislead the text classifier, so treat it as stderr with no stdout.
  const stdout = typeof input === "string" ? "" : (input.stdout ?? "");
  const stderr = typeof input === "string" ? input : (input.stderr ?? "");
  // Structured events on stdout carry authoritative, scoped error signals (a non-"allowed"
  // rate_limit_event, turn.failed, result.is_error, an explicit error envelope). classifyJsonLines
  // reads only those error-bearing fields — never the success answer body.
  const fromJson = classifyJsonLines(stdout, provider, exitCode);
  if (fromJson) return fromJson;
  // Plain-text fallback runs ONLY over the error channel (stderr). It must never see the agent's
  // answer prose: a healthy turn whose answer legitimately mentions "429"/"usage limit"/"403" would
  // otherwise be misclassified into a suppressible kind and disable a perfectly healthy provider.
  return classifyText(withoutAllowedRateLimitTelemetry(stderr), provider, exitCode);
}

function classifyJsonLines(
  raw: string,
  provider?: ChildKind,
  exitCode?: number | null,
): BackendFailure | undefined {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
      const info = obj.rate_limit_info;
      const status = typeof info.status === "string" ? info.status : undefined;
      if (status && status !== "allowed") {
        return failure(
          limitKind(info.rateLimitType, textFromUnknown(info)),
          provider,
          textFromUnknown(info),
          {
            limitType: stringish(info.rateLimitType),
            rawStatus: status,
            resetAt: numberish(info.resetsAt),
          },
        );
      }
    }

    const t: unknown = obj.type ?? obj.msg?.type;
    if (t === "turn.failed") {
      const text = [
        textFromUnknown(obj.error),
        textFromUnknown(obj.msg?.error),
        textFromUnknown(obj.message),
        textFromUnknown(obj.msg?.message),
      ]
        .filter(Boolean)
        .join(" ");
      const classified = classifyText(text, provider, exitCode);
      if (classified) return classified;
    }

    if (obj.type === "result" && obj.is_error) {
      const text = [
        textFromUnknown(obj.api_error_status),
        textFromUnknown(obj.result),
        textFromUnknown(obj.error),
      ]
        .filter(Boolean)
        .join(" ");
      const statusCode = numberish(obj.api_error_status);
      const classified = classifyText(text, provider, statusCode ?? exitCode);
      if (classified) return classified;
    }

    if (obj.error) {
      const classified = classifyText(textFromUnknown(obj.error), provider, exitCode);
      if (classified) return classified;
    }
  }
  return undefined;
}

function classifyText(
  raw: string,
  provider?: ChildKind,
  exitCode?: number | null,
): BackendFailure | undefined {
  const text = raw.toLowerCase();
  if (!text && (exitCode == null || exitCode === 0)) return undefined;

  if (/\b(aborted|cancelled|canceled)\b/.test(text)) {
    return failure("cancelled", provider, raw);
  }
  if (
    /context_length_exceeded|context window|context length|max(?:imum)? context|too many tokens|token limit/i.test(
      raw,
    )
  ) {
    return failure("context-length", provider, raw, status(raw));
  }
  if (
    /not logged in|login required|authentication|unauthorized|invalid api key|api key.*missing|permission denied|forbidden|\b401\b|\b403\b/i.test(
      raw,
    )
  ) {
    return failure("auth", provider, raw, status(raw));
  }
  if (
    /five[_ -]?hour|5[- ]?hour|usage limit|limit reached|monthly limit|weekly limit|subscription limit|usage.*exceeded/i.test(
      raw,
    )
  ) {
    return failure("usage-limit", provider, raw, status(raw));
  }
  if (/rate[_ -]?limit|too many requests|\b429\b/i.test(raw)) {
    return failure("rate-limit", provider, raw, status(raw));
  }
  if (/insufficient[_ -]?quota|\bquota\b|credit.*exhaust|billing.*limit/i.test(raw)) {
    return failure("quota-exceeded", provider, raw, status(raw));
  }
  if (/overloaded|service unavailable|temporarily unavailable|server is busy|\b503\b|\b529\b/i.test(raw)) {
    return failure("backend-overloaded", provider, raw, status(raw));
  }
  if (exitCode != null && exitCode !== 0) {
    return failure("unknown", provider, raw, { statusCode: exitCode });
  }
  return undefined;
}

function withoutAllowedRateLimitTelemetry(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as any;
      if (
        obj.type === "rate_limit_event" &&
        obj.rate_limit_info?.status === "allowed"
      ) {
        continue;
      }
    } catch {
      /* non-JSON text remains eligible for regex classification */
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function failure(
  kind: BackendFailureKind,
  provider: ChildKind | undefined,
  raw: string,
  extra: Partial<BackendFailure> = {},
): BackendFailure {
  const resetAt = extra.resetAt;
  return {
    kind,
    provider,
    message: trimOneLine(raw, 500),
    ...extra,
    resetAt,
    resetAtIso:
      typeof resetAt === "number" && Number.isFinite(resetAt)
        ? new Date(resetAt * 1000).toISOString()
        : extra.resetAtIso,
  };
}

function isBackendFailure(value: unknown): value is BackendFailure {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as BackendFailure).kind === "string" &&
    typeof (value as BackendFailure).message === "string"
  );
}

function limitKind(limitType: unknown, text: string): BackendFailureKind {
  const s = `${String(limitType ?? "")} ${text}`.toLowerCase();
  return /five[_ -]?hour|5[- ]?hour|usage|subscription/.test(s)
    ? "usage-limit"
    : "rate-limit";
}

function kindLabel(kind: BackendFailureKind): string {
  switch (kind) {
    case "rate-limit":
      return "backend rate limit hit";
    case "usage-limit":
      return "backend usage limit hit";
    case "quota-exceeded":
      return "backend quota exceeded";
    case "auth":
      return "backend authentication failed";
    case "context-length":
      return "backend context length exceeded";
    case "backend-overloaded":
      return "backend overloaded/unavailable";
    case "cancelled":
      return "backend call cancelled";
    default:
      return "backend call failed";
  }
}

function providerLabel(provider: ChildKind): string {
  return provider === "claude-cli" ? "Claude" : provider === "codex-cli" ? "Codex" : provider;
}

function stringish(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberish(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function status(raw: string): Partial<BackendFailure> {
  const m = raw.match(/\b(401|403|408|409|413|429|500|502|503|529)\b/);
  return m ? { statusCode: Number(m[1]) } : {};
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function trimOneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
