import type { AgentSpec, BackendFailure, BackendFailureKind, ChildKind } from "@frites/core";
import { formatBackendFailure, ModelBackendError } from "./backend-errors.js";

export interface BackendSuppression {
  provider: ChildKind;
  until: number;
  failure: BackendFailure;
  reason: string;
}

export interface SelectAgentOptions {
  /** Preferred index in the candidate list; selection scans round-robin from here. */
  preferredIndex?: number;
  /** Providers already tried for this one logical call. */
  attempted?: Set<ChildKind>;
}

const DEFAULT_TTL_MS: Record<BackendFailureKind, number> = {
  "usage-limit": 5 * 60 * 60 * 1000,
  "quota-exceeded": 60 * 60 * 1000,
  auth: 10 * 60 * 1000,
  "rate-limit": 5 * 60 * 1000,
  "backend-overloaded": 60 * 1000,
  "context-length": 0,
  cancelled: 0,
  unknown: 0,
};

export function isSuppressibleFailure(failure?: BackendFailure): failure is BackendFailure {
  return !!failure && DEFAULT_TTL_MS[failure.kind] > 0 && !!failure.provider;
}

export function isRetryableWithAnotherProvider(failure?: BackendFailure): failure is BackendFailure {
  return isSuppressibleFailure(failure);
}

export function suppressionDurationMs(failure: BackendFailure, now = Date.now()): number {
  if (typeof failure.resetAt === "number" && Number.isFinite(failure.resetAt)) {
    const until = failure.resetAt * 1000;
    if (until > now) return until - now;
  }
  if (
    typeof failure.retryAfterSeconds === "number" &&
    Number.isFinite(failure.retryAfterSeconds) &&
    failure.retryAfterSeconds > 0
  ) {
    return failure.retryAfterSeconds * 1000;
  }
  return DEFAULT_TTL_MS[failure.kind] ?? 0;
}

export class BackendSuppressionController {
  private readonly suppressed = new Map<ChildKind, BackendSuppression>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  active(): BackendSuppression[] {
    this.prune();
    return [...this.suppressed.values()];
  }

  get(provider: ChildKind): BackendSuppression | undefined {
    this.prune();
    return this.suppressed.get(provider);
  }

  isSuppressed(specOrProvider: AgentSpec | ChildKind | undefined): BackendSuppression | undefined {
    const provider =
      typeof specOrProvider === "string" ? specOrProvider : specOrProvider?.kind;
    return provider ? this.get(provider) : undefined;
  }

  recordFailure(failure?: BackendFailure): BackendSuppression | undefined {
    if (!isSuppressibleFailure(failure)) return undefined;
    const provider = failure.provider;
    if (!provider) return undefined;
    const ms = suppressionDurationMs(failure, this.now());
    if (ms <= 0) return undefined;
    const until = this.now() + ms;
    const next: BackendSuppression = {
      provider,
      until,
      failure,
      reason: formatBackendFailure(failure),
    };
    const prev = this.suppressed.get(provider);
    if (!prev || prev.until < next.until) this.suppressed.set(provider, next);
    return this.suppressed.get(provider);
  }

  selectAgent(agents: AgentSpec[], opts: SelectAgentOptions = {}): AgentSpec | undefined {
    this.prune();
    if (agents.length === 0) return undefined;
    const attempted = opts.attempted ?? new Set<ChildKind>();
    const start = ((opts.preferredIndex ?? 0) % agents.length + agents.length) % agents.length;
    for (let offset = 0; offset < agents.length; offset++) {
      const spec = agents[(start + offset) % agents.length]!;
      if (attempted.has(spec.kind)) continue;
      if (this.isSuppressed(spec)) continue;
      return spec;
    }
    return undefined;
  }

  suppressedError(provider: ChildKind): ModelBackendError {
    const suppression = this.get(provider);
    const failure: BackendFailure =
      suppression?.failure ?? {
        kind: "unknown",
        provider,
        message: `${provider} is currently suppressed by backend policy`,
      };
    return new ModelBackendError({
      ...failure,
      message: `${formatBackendFailure(failure)} is suppressed until ${
        suppression ? new Date(suppression.until).toISOString() : "the policy expires"
      }`,
    });
  }

  private prune(): void {
    const now = this.now();
    for (const [provider, suppression] of this.suppressed) {
      if (suppression.until <= now) this.suppressed.delete(provider);
    }
  }
}

export function describeSuppression(suppression: BackendSuppression): string {
  return `${suppression.provider} suppressed until ${new Date(suppression.until).toISOString()} (${suppression.reason})`;
}
