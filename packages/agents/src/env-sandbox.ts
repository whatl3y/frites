/**
 * Child environment is built by ALLOWLIST, never by copying process.env. This is the
 * recursion guard + secret-minimization boundary for full-auto agents.
 */

/** Kept so the child can run and find its OWN auth (keychain is OS-level; codex uses HOME/CODEX_HOME). */
const ALLOWLIST = [
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TZ",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  // Headless Claude subscription token (from `claude setup-token`) — the way Claude auths in
  // containers/CI where the macOS Keychain is unavailable. Not a base-URL, so no recursion risk.
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/** Never allowed through — pointing a child at these would make it call distrai again. */
const SCRUB_EXACT = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "CODEX_BASE_URL",
];

export interface ChildEnvOptions {
  parentEnv?: NodeJS.ProcessEnv;
  /** Current process DISTRAI_DEPTH; the child gets depth + 1. */
  depth: number;
  maxDepth: number;
  /** Subscription-first by default: API keys are withheld so CLIs use OAuth. */
  passApiKeys?: boolean;
  extraEnv?: Record<string, string>;
}

export function assertDepth(depth: number, maxDepth: number): void {
  if (depth >= maxDepth) {
    throw new Error(
      `distrai recursion fuse tripped (DISTRAI_DEPTH=${depth} >= maxDepth=${maxDepth}). ` +
        `A child agent appears to be invoking distrai again. Refusing to spawn.`,
    );
  }
}

export function buildChildEnv(opts: ChildEnvOptions): NodeJS.ProcessEnv {
  const parent = opts.parentEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWLIST) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  if (opts.passApiKeys) {
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      if (parent[key]) env[key] = parent[key];
    }
  }
  if (opts.extraEnv) Object.assign(env, opts.extraEnv);
  // Defense in depth: strip base-URL vars even if reintroduced via extraEnv.
  for (const key of SCRUB_EXACT) delete env[key];
  env.DISTRAI_DEPTH = String(opts.depth + 1);
  env.DISTRAI_CHILD = "1";
  return env;
}

export function currentDepth(parentEnv: NodeJS.ProcessEnv = process.env): number {
  return Number(parentEnv.DISTRAI_DEPTH ?? "0") || 0;
}
