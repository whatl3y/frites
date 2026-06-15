import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ChildKind, DistraiConfig } from "@distrai/core";
import { assertDepth, buildChildEnv, currentDepth } from "./env-sandbox";

/**
 * A normalized streaming event from a child completion, delivered live as the CLI produces it.
 * claude-cli streams at token granularity (incremental text deltas); codex-cli at item
 * granularity (the whole agent message arrives at once). Both surface token usage. The gateway
 * turns these into per-agent progress + a live answer stream.
 */
export type ChildEvent =
  | { type: "start" }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool"; name: string }
  | {
      type: "usage";
      /** Total input tokens (all categories summed) — comparable across providers. */
      inputTokens?: number;
      outputTokens?: number;
      /** Cached/reused portion of the input (cache reads). */
      cacheReadTokens?: number;
      /** Cache-write portion of the input (claude only; codex reports none). */
      cacheCreationTokens?: number;
    };

export interface CompletionOptions {
  config: DistraiConfig;
  model?: string;
  signal?: AbortSignal;
  passApiKeys?: boolean;
  timeoutMs?: number;
  /**
   * The caller's real working directory (the repo the outer CLI was launched in), parsed from
   * the inbound request. When present and valid the child runs THERE so it can actually read the
   * repo — instead of an empty scratch dir, which made it tell the user it had no file access.
   * We never delete a caller-supplied dir; only scratch dirs we create are cleaned up.
   */
  cwd?: string;
  /** Receives normalized streaming events as the child produces them (incremental). */
  onEvent?: (ev: ChildEvent) => void;
}

export interface CompletionResult {
  text: string;
  /** Reported child spend in USD, when the backend provides it (claude does; codex may not). */
  costUsd?: number;
  /**
   * TOTAL input tokens (all categories summed), normalized so claude and codex are comparable:
   * claude reports fresh/cache-read/cache-write disjointly and we sum them; codex reports a
   * single inclusive `input_tokens` we pass through. `cacheReadTokens` is the cached/reused
   * subset; `cacheCreationTokens` the cache-write subset (claude only).
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Mutable accumulator threaded through the per-line parsers as a child streams. */
export interface StreamAcc {
  /** Authoritative final text (claude `result`, codex `agent_message`). */
  text: string;
  /** Concatenation of streamed text deltas — fallback when no authoritative text appears. */
  streamed: string;
  costUsd?: number;
  /** Total input tokens (all categories summed) — see CompletionResult.inputTokens. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export function newAcc(): StreamAcc {
  return { text: "", streamed: "" };
}

// ── per-CLI line → event translation (pure; unit-tested against captured fixtures) ──

/**
 * Normalize an Anthropic `usage` object into a single comparable input total. Anthropic reports
 * fresh `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` as DISJOINT
 * categories that sum to the full prompt size, so the true input footprint is their sum — not the
 * `input_tokens` field alone (which is only the uncached remainder). Returns undefined when the
 * object carries no input counts at all.
 */
function claudeInput(
  u: any,
): { total: number; read: number; create: number } | undefined {
  if (!u) return undefined;
  const fresh = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const read = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const create =
    typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  if (u.input_tokens == null && !read && !create) return undefined;
  return { total: fresh + read + create, read, create };
}

/**
 * Parse one line of claude `--output-format stream-json --include-partial-messages` NDJSON.
 * Mutates `acc` (final text / cost / tokens) and returns the streaming events it produced.
 */
export function parseClaudeLine(line: string, acc: StreamAcc): ChildEvent[] {
  const out: ChildEvent[] = [];
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return out; // tolerate non-JSON / partial lines
  }
  if (obj.type === "system" && obj.subtype === "init") {
    out.push({ type: "start" });
    return out;
  }
  if (obj.type === "stream_event") {
    const ev = obj.event ?? {};
    if (ev.type === "message_start") {
      const u = claudeInput(ev.message?.usage);
      if (u) {
        acc.inputTokens = u.total;
        acc.cacheReadTokens = u.read;
        acc.cacheCreationTokens = u.create;
        out.push({
          type: "usage",
          inputTokens: u.total,
          cacheReadTokens: u.read,
          cacheCreationTokens: u.create,
        });
      }
    } else if (ev.type === "content_block_start") {
      const cb = ev.content_block ?? {};
      if (cb.type === "tool_use" && typeof cb.name === "string") {
        out.push({ type: "tool", name: cb.name });
      }
    } else if (ev.type === "content_block_delta") {
      const d = ev.delta ?? {};
      if (d.type === "text_delta" && typeof d.text === "string") {
        acc.streamed += d.text;
        out.push({ type: "text", delta: d.text });
      } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
        out.push({ type: "reasoning", delta: d.thinking });
      }
    } else if (ev.type === "message_delta") {
      const u = ev.usage;
      if (u && typeof u.output_tokens === "number") {
        acc.outputTokens = u.output_tokens;
        out.push({ type: "usage", outputTokens: u.output_tokens });
      }
    }
    return out;
  }
  if (obj.type === "result") {
    if (typeof obj.total_cost_usd === "number") acc.costUsd = obj.total_cost_usd;
    if (typeof obj.result === "string") acc.text = obj.result;
    const u = obj.usage;
    if (u) {
      const input = claudeInput(u);
      if (input) {
        acc.inputTokens = input.total;
        acc.cacheReadTokens = input.read;
        acc.cacheCreationTokens = input.create;
      }
      if (typeof u.output_tokens === "number") acc.outputTokens = u.output_tokens;
    }
  }
  return out;
}

/**
 * Parse one line of codex `exec --json` JSONL. The schema drifts between versions, so this is
 * intentionally defensive and understands both the new thread/turn/item events (0.139+) and the
 * older `msg`-wrapped shape. Mutates `acc` and returns the streaming events it produced.
 */
export function parseCodexLine(line: string, acc: StreamAcc): ChildEvent[] {
  const out: ChildEvent[] = [];
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return out;
  }
  const t: unknown = obj.type ?? obj.msg?.type;
  if (t === "thread.started" || t === "turn.started" || t === "session.created") {
    out.push({ type: "start" });
    return out;
  }
  if (typeof t === "string" && t.startsWith("item.")) {
    const item = obj.item ?? {};
    // codex emits the whole message at item.completed (no token-level deltas in this version).
    if (t === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      const sep = acc.streamed ? "\n" : "";
      const piece = sep + item.text;
      acc.streamed += piece;
      acc.text = acc.streamed; // keep returned text byte-identical to what we streamed
      out.push({ type: "text", delta: piece });
    } else if (t === "item.completed" && item.type === "reasoning") {
      const rtext =
        typeof item.text === "string"
          ? item.text
          : Array.isArray(item.summary)
            ? item.summary.map((s: any) => s?.text ?? "").join("")
            : "";
      if (rtext.trim()) out.push({ type: "reasoning", delta: rtext });
    } else if (typeof item.type === "string" && /command|exec|patch|file/i.test(item.type)) {
      if (t === "item.started" || t === "item.completed") out.push({ type: "tool", name: item.type });
    }
    return out;
  }
  if (t === "turn.completed" || t === "turn.failed") {
    const u = obj.usage ?? obj.msg?.usage;
    if (u) {
      // codex `input_tokens` is already the inclusive total (cached is a SUBSET, not additive),
      // unlike claude where the categories are disjoint — so we pass it through without summing.
      if (typeof u.input_tokens === "number") acc.inputTokens = u.input_tokens;
      if (typeof u.cached_input_tokens === "number") acc.cacheReadTokens = u.cached_input_tokens;
      if (typeof u.output_tokens === "number") acc.outputTokens = u.output_tokens;
      if (typeof u.cost_usd === "number") acc.costUsd = u.cost_usd;
      out.push({
        type: "usage",
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens:
          typeof u.cached_input_tokens === "number" ? u.cached_input_tokens : undefined,
      });
    }
    return out;
  }
  // legacy fallback: older codex emitted free-form text on `message`/`msg.message`/`text`.
  const legacy: unknown = obj.message ?? obj.msg?.message ?? obj.text;
  if (typeof legacy === "string" && legacy.trim()) {
    acc.text = legacy.trim();
  }
  return out;
}

function finalText(acc: StreamAcc, raw: string): string {
  return acc.text || acc.streamed.trim() || raw.trim();
}

/**
 * Run a single agent as an ANSWER-ONLY completion (no worktree, read-only sandbox) and
 * return its text + reported cost/tokens. Used by the transparent-proxy answer council. Output is
 * streamed as it's produced (opts.onEvent), so callers can show live per-agent progress instead
 * of waiting for the whole reply. Env is scrubbed (recursion guard) so children never call back
 * into distrai.
 */
export async function runCompletion(
  kind: ChildKind,
  prompt: string,
  opts: CompletionOptions,
): Promise<CompletionResult> {
  const depth = currentDepth();
  assertDepth(depth, opts.config.maxDepth);
  const env = buildChildEnv({
    depth,
    maxDepth: opts.config.maxDepth,
    passApiKeys: opts.passApiKeys,
  });
  const timeoutMs = opts.timeoutMs ?? opts.config.perChildTimeoutMs;
  // Run in the caller's real repo when we have one (so reads actually work); otherwise an empty
  // scratch dir. Only `scratch` — a dir WE created — is ever removed; the caller's repo never is.
  const repoCwd =
    opts.cwd && isAbsolute(opts.cwd) && existsSync(opts.cwd) ? opts.cwd : undefined;
  const scratch = repoCwd ? undefined : mkdtempSync(join(tmpdir(), "distrai-ans-"));
  const cwd = repoCwd ?? (scratch as string);
  const acc = newAcc();
  const emit = (events: ChildEvent[]) => {
    if (!opts.onEvent) return;
    for (const ev of events) opts.onEvent(ev);
  };
  try {
    if (kind === "claude-cli") {
      // Prompt is piped to stdin (not argv) — large transcripts exceed ARG_MAX → E2BIG.
      const args = [
        "-p",
        "--output-format",
        "stream-json", // realtime NDJSON event stream (was buffered `json`)
        "--verbose", // required to surface the full event stream under -p
        "--include-partial-messages", // token-level content_block_delta text as it's generated
        "--strict-mcp-config", // don't auto-load distrai's own MCP (recursion guard)
        "--setting-sources",
        "project", // NOT user — user settings may set ANTHROPIC_BASE_URL=gateway → recursion fork-bomb
        // Read-only guard: the council child inspects + answers (or proposes a tool the HOST runs);
        // it must never silently edit the caller's files. Deny overrides any permissive project
        // settings; reads/greps still work under the default permission mode. `--disallowedTools`
        // is variadic, so each tool name is its own argv token (a joined string = one bogus name).
        "--disallowedTools",
        "Edit",
        "Write",
        "NotebookEdit",
      ];
      if (opts.model) args.push("--model", opts.model);
      const raw = await runStreaming(
        "claude",
        args,
        cwd,
        env,
        timeoutMs,
        prompt,
        (line) => emit(parseClaudeLine(line, acc)),
        opts.signal,
      );
      return {
        text: finalText(acc, raw),
        costUsd: acc.costUsd,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens,
      };
    }
    // codex: read-only sandbox so it can only answer, never edit. `-o` writes the final message to
    // a file OUTSIDE the repo as a fallback if the JSON event stream yields no agent_message.
    const outDir = scratch ?? mkdtempSync(join(tmpdir(), "distrai-out-"));
    const lastFile = join(outDir, "last.txt");
    try {
      const args = [
        "exec",
        "--ignore-user-config", // don't load ~/.codex/config.toml (may route to gateway → recursion); auth still via CODEX_HOME
        "--json", // emit events as JSONL so we can stream them
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-c",
        'approval_policy="never"',
        "-o",
        lastFile,
      ];
      // Match the execute path's reasoning depth so codex answers as thoroughly as it acts. `-c`
      // overrides apply even under --ignore-user-config. The value is validated by the model API:
      // "high"/"medium"/"low" work; "minimal" 400s on the default model (incompatible with its
      // web_search/image_gen tools). The shipped default is "high", so this path is safe.
      if (opts.config.codexReasoningEffort) {
        args.push("-c", `model_reasoning_effort="${opts.config.codexReasoningEffort}"`);
      }
      if (opts.model) args.push("-m", opts.model);
      args.push("-"); // read prompt from stdin (piped below), not argv → avoids E2BIG
      const raw = await runStreaming(
        "codex",
        args,
        cwd,
        env,
        timeoutMs,
        prompt,
        (line) => emit(parseCodexLine(line, acc)),
        opts.signal,
      );
      const fallback = !acc.text && existsSync(lastFile) ? readFileSync(lastFile, "utf8") : raw;
      return {
        text: finalText(acc, fallback),
        costUsd: acc.costUsd,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens,
      };
    } finally {
      if (outDir !== scratch) rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Spawn a CLI, pipe the prompt over stdin, and deliver stdout to `onLine` one newline-delimited
 * line at a time as it arrives (so callers stream). Resolves with the full raw stdout (for the
 * final-text fallback); rejects on non-zero exit / timeout / abort.
 */
function runStreaming(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  stdin: string,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      detached: true,
      // Prompt rides stdin, not argv: real transcripts exceed ARG_MAX → spawn E2BIG.
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Write the prompt and close stdin (EOF) so the child stops waiting for input.
    // Swallow EPIPE in case the child exits before draining what we wrote.
    child.stdin?.on("error", () => {
      /* EPIPE: child gone before reading stdin */
    });
    child.stdin?.end(stdin);
    let out = "";
    let err = "";
    let buf = "";
    const killGroup = (s: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, s);
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      killGroup("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      killGroup("SIGKILL");
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (b: Buffer) => {
      const s = b.toString();
      out += s;
      buf += s;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) {
          try {
            onLine(line);
          } catch {
            /* tolerate schema drift / parser errors */
          }
        }
      }
    });
    child.stderr?.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Flush any trailing line without a terminating newline.
      if (buf.trim()) {
        try {
          onLine(buf);
        } catch {
          /* ignore */
        }
      }
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`));
    });
  });
}
