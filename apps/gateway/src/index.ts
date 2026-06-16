#!/usr/bin/env node
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import {
  type AgentAction,
  type AgentSpec,
  type FritesConfig,
  type FanOutDecision,
  type ToolDef,
  decideFanOut,
  llmJudgeFanOut,
  loadConfig,
  runActionCouncil,
  runAnswerCouncil,
  stripInjectedContext,
} from "@frites/core";
import { type ChildEvent, estimateCostUsd, pricingFor, runCompletion } from "@frites/agents";
import { type Logger, createLogger, resolveLogLevel } from "./logger.js";
import { type ProgressSink, createProgressSink } from "./progress.js";

const HOST = process.env.FRITES_GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.FRITES_GATEWAY_PORT ?? 6767);
const config: FritesConfig = loadConfig(process.cwd());
const passApiKeys = config.passApiKeys || process.env.FRITES_PASS_API_KEYS === "1";
// Optional shared-secret on inbound requests (off by default to keep the quickstart simple).
const GATEWAY_TOKEN = process.env.FRITES_GATEWAY_TOKEN ?? "";
// How often to emit a "still working — Ns" heartbeat to the client during a long turn.
const HEARTBEAT_MS = Number(process.env.FRITES_HEARTBEAT_MS ?? 5000);
// How often (ms) to refresh a per-agent "~N tok · Ns" telemetry line while a child streams.
const TELEMETRY_MS = Number(process.env.FRITES_TELEMETRY_MS ?? 2000);
// Per-child progress verbosity: "telemetry" (state + token/time counters) or "interleaved"
// (also stream each child's output, agent-prefixed). Env overrides config.progressDetail.
const PROGRESS_DETAIL: "telemetry" | "interleaved" =
  process.env.FRITES_PROGRESS_DETAIL === "interleaved"
    ? "interleaved"
    : process.env.FRITES_PROGRESS_DETAIL === "telemetry"
      ? "telemetry"
      : config.progressDetail;
// Placeholder signature for the ephemeral progress `thinking` block. The real Anthropic API
// signs thinking; we don't, and we strip thinking on the way back in (see blocksToText), so this
// is never verified by anyone — it just keeps the block well-formed for clients that expect one.
const PROGRESS_SIGNATURE = Buffer.from("frites-progress").toString("base64");

// Process-level logging (startup, server errors); per-turn logging uses a child logger.
const rootLog: Logger = createLogger({ level: resolveLogLevel(config.logLevel) });

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}
function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
/** Compact token count: exact under 1k, else k-suffixed (e.g. 19901 → "19.9k", 7068 → "7.1k"). */
function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}
/** Provider-comparable usage string: total input (cached portion noted) → output. */
function fmtUsage(inTok: number, cached: number, outTok: number): string {
  const cachedPart = cached > 0 ? ` (${fmtTok(cached)} cached)` : "";
  return `${fmtTok(inTok)} in${cachedPart} → ${fmtTok(outTok)} out`;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/** Short human label for an agent in progress/logs, e.g. "claude-cli:opus". */
function childLabel(spec?: AgentSpec): string {
  if (!spec) return "claude-cli";
  return `${spec.kind}${spec.model ? `:${spec.model}` : ""}`;
}
/** A progress emitter feeds BOTH the structured log and the client-facing progress stream. */
type Emit = (human: string, fields?: Record<string, unknown>) => void;
/**
 * Per-turn IO: the progress channel (thinking/reasoning block), the live answer channel (the
 * actual answer block, streamed as the synthesizer produces it), and two emitters — `emit` for
 * milestone status lines (info log) and `emitDetail` for high-frequency telemetry/interleaved
 * text (debug log). Both also push to the progress channel when one is attached.
 */
interface ActiveAgent {
  who: string;
  state: string;
  startedAt: number;
  updatedAt: number;
}

interface TurnContext {
  turnLog: Logger;
  progress: ProgressSink | null;
  answer: ProgressSink | null;
  emit: Emit;
  emitDetail: Emit;
  detail: "telemetry" | "interleaved";
  activeAgents: Map<string, ActiveAgent>;
}
function heartbeatLine(since: number, activeAgents?: Map<string, ActiveAgent>): string {
  const elapsed = Math.round((Date.now() - since) / 1000);
  const active = [...(activeAgents?.values() ?? [])];
  if (!active.length) return `· still working — ${elapsed}s elapsed`;
  const now = Date.now();
  const waiting = active
    .map((a) => `${a.who}: ${a.state}, ${Math.round((now - a.updatedAt) / 1000)}s ago`)
    .join("; ");
  return `· still working — ${elapsed}s elapsed · waiting on ${waiting}`;
}
function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
function isBackgroundModel(model: unknown): boolean {
  return typeof model === "string" && /haiku|small|fast/i.test(model);
}
function chunk(text: string, size = 400): string[] {
  if (!text) return [""];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
function authorized(req: IncomingMessage): boolean {
  if (!GATEWAY_TOKEN) return true;
  const hdr = (req.headers.authorization ?? req.headers["x-api-key"] ?? "") as string;
  const provided = Buffer.from(hdr.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(GATEWAY_TOKEN);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// ── content extraction (Anthropic messages + OpenAI Responses input) ──

function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === "string") return b;
        const t = b?.type;
        if ((t === "text" || t === "input_text" || t === "output_text") && typeof b.text === "string")
          return b.text;
        if (t === "tool_result" || t === "function_call_output")
          return `[tool_result] ${typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? b.output ?? "")}`;
        if (t === "tool_use" || t === "function_call")
          return `[tool_use ${b.name ?? ""} ${JSON.stringify(b.input ?? b.arguments ?? {})}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractAnthropicPrompt(body: any): string {
  const parts: string[] = [];
  const sysText = typeof body.system === "string" ? body.system : blocksToText(body.system);
  if (sysText.trim()) parts.push(`System:\n${sysText}`);
  for (const m of body.messages ?? []) {
    const role = m.role === "assistant" ? "Assistant" : "User";
    const text = blocksToText(m.content);
    if (text.trim()) parts.push(`${role}: ${text}`);
  }
  return parts.join("\n\n");
}

function lastUserText(messages: any[]): string {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      const t = blocksToText(messages[i].content);
      if (t.trim()) return t;
    }
  }
  return "";
}

/**
 * A tool-loop CONTINUATION turn: the host is feeding a tool result back to keep the agentic loop
 * going, not making a fresh request. We detect it from the request shape (no server-side session
 * memory needed) — the last user message carries a `tool_result` (Anthropic) / the last input item
 * is a `function_call_output` (Responses). Used by fanOutScope=first-turn to run a single agent
 * through the mechanical loop and reserve fan-out for the substantive request turn.
 */
function isAnthropicContinuation(messages: any[]): boolean {
  const last = messages?.[messages.length - 1];
  if (last?.role !== "user" || !Array.isArray(last.content)) return false;
  return last.content.some((b: any) => b?.type === "tool_result");
}

function isResponsesContinuation(input: unknown): boolean {
  if (!Array.isArray(input) || input.length === 0) return false;
  const last = input[input.length - 1];
  if (last?.type === "function_call_output") return true;
  return Array.isArray(last?.content) && last.content.some((b: any) => b?.type === "function_call_output");
}

function extractAnthropicTools(body: any): ToolDef[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .filter((t: any) => t && typeof t.name === "string")
    .map((t: any) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

function extractResponsesPrompt(body: any): string {
  const parts: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim())
    parts.push(`System:\n${body.instructions}`);
  const input = body.input;
  if (typeof input === "string") parts.push(`User: ${input}`);
  else if (Array.isArray(input)) {
    for (const item of input) {
      const role = item?.role === "assistant" ? "Assistant" : "User";
      const text = blocksToText(item?.content ?? item);
      if (text.trim()) parts.push(`${role}: ${text}`);
    }
  }
  return parts.join("\n\n");
}

function responsesLastUser(body: any): string {
  const input = body.input;
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i--) {
      if (input[i]?.role !== "assistant") {
        const t = blocksToText(input[i]?.content ?? input[i]);
        if (t.trim()) return t;
      }
    }
  }
  return "";
}

/**
 * Recover the caller's working directory from the request. Claude Code (and Codex) embed an env
 * block in the system prompt — e.g. "Primary working directory: /path" — so we can run the child
 * THERE and let it actually read the repo, instead of an empty temp dir it then complains about.
 * Returns undefined unless we find an absolute path that exists and is a directory.
 */
function extractWorkingDir(body: any): string | undefined {
  const texts: string[] = [];
  if (body.system)
    texts.push(typeof body.system === "string" ? body.system : blocksToText(body.system));
  if (typeof body.instructions === "string") texts.push(body.instructions);
  for (const m of body.messages ?? []) texts.push(blocksToText(m.content));
  if (typeof body.input === "string") texts.push(body.input);
  else for (const it of body.input ?? []) texts.push(blocksToText(it?.content ?? it));
  const hay = texts.join("\n");
  const m =
    hay.match(/^[\s\-*]*(?:primary |current )?working directory\s*[:=]\s*(.+?)\s*$/im) ??
    hay.match(/^[\s\-*]*cwd\s*[:=]\s*(.+?)\s*$/im);
  const p = m?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!p || !isAbsolute(p)) return undefined;
  try {
    return statSync(p).isDirectory() ? p : undefined;
  } catch {
    return undefined; // path doesn't exist / not accessible
  }
}

// ── per-session turn cap + cumulative spend (the gateway process is long-lived) ──

const sessions = new Map<string, { turns: number; usd: number }>();
function sessionKey(stablePrefix: string): string {
  return createHash("sha1").update(stablePrefix).digest("hex").slice(0, 16);
}

// ── the council turn: decide the next ACTION (answer or tool call) ──

interface Spend {
  usd: number;
  calls: number;
}
interface TurnResult {
  action: AgentAction;
  spend: Spend;
  fannedOut: boolean;
  reason: string;
}

function specFor(ctx: { role: "child" | "synth"; index: number }, override?: AgentSpec | null) {
  if (override) return override; // background turns pin a single child to the requested cheap model
  const agents = config.defaultAgents;
  return ctx.role === "synth" ? agents[0] : agents[ctx.index % agents.length];
}

async function runAgentTurn(
  transcript: string,
  decisionBasis: string,
  tools: ToolDef[],
  model: string,
  io: TurnContext,
  continuation: boolean,
  cwd?: string,
): Promise<TurnResult> {
  const { emit, emitDetail } = io;
  const spend: Spend = { usd: 0, calls: 0 };
  const turnStart = Date.now();
  const track = (r: { text: string; costUsd?: number }): string => {
    spend.calls++;
    spend.usd += r.costUsd ?? 0;
    return r.text;
  };
  // Only answer turns can stream a live final answer (tool turns emit a JSON action we parse, not
  // prose) — and only the producer of the final answer routes its text to the answer block.
  const isAnswerTurn = tools.length === 0;

  // Background/utility traffic from the host — title generation, conversation summarization, topic
  // classification, or an explicitly cheap-tier subagent — comes in labelled with a small/fast
  // model (e.g. haiku). It must NEVER fan out: that would turn a throwaway housekeeping call into N
  // metered children. Pin a SINGLE child to the model the host actually asked for, tools or not.
  const background = isBackgroundModel(model);
  const bgSpec: AgentSpec | null = background ? { id: "background", kind: "claude-cli", model } : null;

  // Fan-out worthiness is a property of the CURRENT request, not the whole transcript. Resolve it
  // up front so the per-child wrapper knows whether a single child IS the final answer.
  let decision: FanOutDecision;
  if (background) {
    decision = { fanOut: false, n: 1, reason: `background model ${model}` };
    emit(`single background agent [${model}] (no fan-out)`);
  } else if (config.fanOutScope === "first-turn" && continuation) {
    // Mechanical tool-loop step — fan-out was already spent on the substantive request turn, so
    // drive the loop with one agent (see config.fanOutScope). Re-engages on the next user request.
    decision = { fanOut: false, n: 1, reason: "tool-loop continuation: single agent" };
    emit("single agent — tool-loop continuation (fan-out reserved for the request turn)");
  } else if (config.fanOutPolicy === "auto") {
    const heuristic = decideFanOut(decisionBasis, config);
    if (!heuristic.fanOut) {
      decision = heuristic;
    } else {
      emit("judging whether to consult multiple agents…");
      const classify = (q: string) =>
        runCompletion("claude-cli", q, { config, model: "haiku", passApiKeys, timeoutMs: 60_000 }).then(track);
      decision = await llmJudgeFanOut(decisionBasis, classify, config);
    }
  } else {
    decision = decideFanOut(decisionBasis, config);
  }

  // Wrap each child/synth call so its start, duration, cost, tokens, streamed output, and any
  // failure surface in BOTH the server log and the client progress stream. This is where the
  // per-agent visibility comes from; the final-answer producer streams into the answer block.
  const complete = async (p: string, ctx: { role: "child" | "synth"; index: number }) => {
    const spec = specFor(ctx, bgSpec);
    const who =
      ctx.role === "synth" ? "synthesizer" : `agent ${ctx.index + 1} (${childLabel(spec)})`;
    const tag = ctx.role === "synth" ? "synth" : String(ctx.index + 1);
    const startedAt = Date.now();
    // ONLY the synthesizer live-streams into the answer block. It's handed the children's answers
    // (no reason to read files) and steered to emit answer-only, so its text deltas == its final
    // `result` with no preamble. A lone child (no fan-out) can narrate/read before answering, whose
    // pre-answer deltas aren't in claude's `result`; we route its text to telemetry/interleaved
    // instead and emit its clean `result` chunked at turn end (anthropicStream/responsesStream).
    const isFinalAnswer = isAnswerTurn && !!io.answer && ctx.role === "synth";
    if (ctx.role !== "synth") emit(`→ ${who} working…`, { agent: who });

    // Track this agent in the live roster the heartbeat reads, so a long silent stretch renders
    // "waiting on agent 1 (claude…): running Bash, 40s ago" instead of a bare elapsed tick. Keyed
    // by `who` (unique per child/synth within a turn); dropped when the call settles (finally).
    // `touch()` with no arg refreshes the timestamp but keeps the last state (usage pings).
    const touch = (state?: string): void => {
      const prev = io.activeAgents.get(who);
      io.activeAgents.set(who, {
        who,
        state: state ?? prev?.state ?? "working",
        startedAt,
        updatedAt: Date.now(),
      });
    };
    touch("starting");

    let chars = 0;
    let lastOut = 0;
    let lastIn = 0;
    let lastCacheRead = 0;
    let lastTick = 0;
    let lineBuf = "";
    const flushLines = (final = false): void => {
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const ln = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        emitDetail(`[${tag}] ${ln}`);
      }
      if (final && lineBuf.trim()) {
        emitDetail(`[${tag}] ${lineBuf}`);
        lineBuf = "";
      }
    };
    const onEvent = (ev: ChildEvent): void => {
      if (ev.type === "usage") {
        if (typeof ev.outputTokens === "number") lastOut = ev.outputTokens;
        if (typeof ev.inputTokens === "number") lastIn = ev.inputTokens;
        if (typeof ev.cacheReadTokens === "number") lastCacheRead = ev.cacheReadTokens;
        touch(); // refresh liveness; usage pings carry no new state of their own
        return;
      }
      if (ev.type === "start") {
        touch("working"); // child CLI initialized
        return;
      }
      if (ev.type === "tool") {
        touch(`running ${ev.name}`); // stays until the next event — the "Ns ago" shows how long
        emitDetail(`→ ${who} used ${ev.name}`, { agent: who, tool: ev.name });
        return;
      }
      if (ev.type === "reasoning") {
        touch("thinking"); // tracked for liveness; reasoning text stays out of the panel for now
        return;
      }
      if (ev.type !== "text") return;
      chars += ev.delta.length;
      if (isFinalAnswer) {
        io.answer?.push(ev.delta); // live answer stream (raw delta — no forced newline)
        return;
      }
      touch("responding");
      // Non-final child: in interleaved mode surface its output (line-buffered + agent-prefixed);
      // in either mode refresh a throttled per-agent token/elapsed counter.
      if (io.detail === "interleaved" && io.progress) {
        lineBuf += ev.delta;
        flushLines();
      }
      if (io.progress) {
        const now = Date.now();
        if (now - lastTick >= TELEMETRY_MS) {
          lastTick = now;
          const estTok = lastOut || Math.max(1, Math.ceil(chars / 4));
          // claude reports input at message_start (so show in→out live); codex only at turn end.
          const inPart = lastIn ? `${fmtTok(lastIn)} in → ` : "";
          emitDetail(`· ${who} ${inPart}~${estTok} out · ${secs(now - startedAt)}`, { agent: who });
        }
      }
    };

    try {
      const r = await runCompletion(spec?.kind ?? "claude-cli", p, {
        config,
        model: spec?.model,
        passApiKeys,
        timeoutMs: config.perChildTimeoutMs,
        cwd, // run the child in the caller's repo so it can actually read it
        onEvent,
      });
      if (io.detail === "interleaved" && !isFinalAnswer) flushLines(true);
      const ms = Date.now() - startedAt;
      // Normalized, provider-comparable usage: total input (with the cached/reused portion called
      // out) → output, plus cost. claude self-reports cost authoritatively; codex reports none, so
      // we estimate from config.pricing when available (marked `~`) instead of leaving it blank —
      // which previously made codex look free next to claude. See packages/agents/src/pricing.ts.
      const inTok = r.inputTokens ?? lastIn ?? 0;
      const cachedTok = r.cacheReadTokens ?? lastCacheRead ?? 0;
      const outTok = r.outputTokens ?? lastOut ?? 0;
      const reportedUsd = r.costUsd;
      const estUsd =
        reportedUsd == null
          ? estimateCostUsd(pricingFor(spec?.model, config.pricing), r)
          : undefined;
      const usd = reportedUsd ?? estUsd;
      const usageStr = fmtUsage(inTok, cachedTok, outTok);
      const costStr =
        usd != null ? ` · ${estUsd != null ? "~" : ""}$${usd.toFixed(4)}` : " · cost n/a";
      emit(
        ctx.role === "synth"
          ? `✓ synthesis complete (${secs(ms)} · ${usageStr}${costStr})`
          : `✓ ${who} responded (${secs(ms)} · ${usageStr}${costStr})`,
        {
          agent: who,
          ms,
          inputTokens: inTok || undefined,
          cachedTokens: cachedTok || undefined,
          outputTokens: outTok || undefined,
          tokens: outTok || undefined, // back-compat: prior field was output tokens
          usd,
          costEstimated: estUsd != null || undefined,
        },
      );
      // Roll the EFFECTIVE cost (reported or estimated) into turn spend so the total isn't blind
      // to codex's contribution.
      return track({ ...r, costUsd: usd });
    } catch (e) {
      const ms = Date.now() - startedAt;
      emit(`✗ ${who} failed (${secs(ms)}): ${errMsg(e)}`, { agent: who, ms });
      throw e;
    } finally {
      io.activeAgents.delete(who); // drop from the live roster once settled (success or failure)
    }
  };

  // A single consolidated recap line closes out the progress channel — so even when the client
  // collapses the live thinking/reasoning block, its summary view states at a glance what the
  // council did this turn (agents consulted, wall time, calls, cost). The full per-agent detail
  // lives in the gateway log (`frites logs -f --level debug`), the durable after-the-fact view.
  const recap = (fannedOut: boolean): void => {
    const head = fannedOut
      ? `${decision.n} agents + synth`
      : background
        ? `1 background agent [${model}]`
        : "single agent";
    emit(
      `◆ council recap — ${head} · ${secs(Date.now() - turnStart)} · ${spend.calls} call(s)` +
        (spend.usd ? ` · $${spend.usd.toFixed(4)}` : ""),
      { agents: decision.n, fannedOut, ms: Date.now() - turnStart, usd: spend.usd },
    );
  };

  // Background/utility turns (title-gen, summarization, the cheap-tier subagent) must stay cheap:
  // strip the exhaustiveness directive so a throwaway haiku call isn't told to read the repo and
  // run tests. Substantive turns — fanned-out OR single — keep it.
  const councilConfig = background ? { ...config, childDirective: "" } : config;
  if (tools.length > 0) {
    const r = await runActionCouncil(transcript, tools, { complete, config: councilConfig, onProgress: emit, decision });
    recap(r.fannedOut);
    return { action: r.action, spend, fannedOut: r.fannedOut, reason: r.decision.reason };
  }
  const r = await runAnswerCouncil(transcript, { complete, config: councilConfig, onProgress: emit, decision });
  recap(r.fannedOut);
  return { action: { kind: "answer", text: r.answer }, spend, fannedOut: r.fannedOut, reason: r.decision.reason };
}

/** Run a turn under the session cap, accumulating + logging cumulative spend. */
function servedTurn(
  key: string,
  model: string,
  turnLog: Logger,
  run: () => Promise<TurnResult>,
): Promise<TurnResult> {
  const sess = sessions.get(key) ?? { turns: 0, usd: 0 };
  if (sess.turns >= config.maxTurns) {
    turnLog.warn(`session hit maxTurns=${config.maxTurns} — forcing stop`, { session: key });
    return Promise.resolve({
      action: {
        kind: "answer",
        text: `frites: per-session turn cap (${config.maxTurns}) reached — stopping to avoid runaway cost. Raise \`maxTurns\` in config if this was intended.`,
      },
      spend: { usd: 0, calls: 0 },
      fannedOut: false,
      reason: "turn-cap",
    });
  }
  const startedAt = Date.now();
  return run().then((t) => {
    sess.turns += 1;
    sess.usd += t.spend.usd;
    sessions.set(key, sess);
    const act = t.action.kind === "tool" ? `tool:${t.action.name}` : "answer";
    turnLog.info(`turn done → ${act}`, {
      model,
      usd: Number(t.spend.usd.toFixed(4)),
      calls: t.spend.calls,
      fannedOut: t.fannedOut,
      reason: t.reason,
      ms: Date.now() - startedAt,
      session: key,
      sessionTurn: `${sess.turns}/${config.maxTurns}`,
      sessionUsd: Number(sess.usd.toFixed(3)),
    });
    return t;
  });
}

function actionText(action: AgentAction): string {
  return action.kind === "answer"
    ? action.text
    : `(frites chose tool ${action.name}; not supported on this surface yet)`;
}

// ── Anthropic Messages encoding (/v1/messages) ──

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function anthropicStream(
  res: ServerResponse,
  model: string,
  inputTokens: number,
  turn: Promise<TurnResult>,
  progress: ProgressSink | null,
  answer: ProgressSink | null,
  turnLog: Logger,
  activeAgents: Map<string, ActiveAgent>,
): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = newId("msg");
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  const ping = setInterval(() => sse(res, "ping", { type: "ping" }), 3000);

  // Progress rides an ephemeral `thinking` block at index 0 (visible, but visually distinct from
  // the answer and ignored by the gateway when the client echoes it back — so it never pollutes
  // the answer or the next turn). The answer/tool block then follows at index 1. As soon as the
  // final answer starts streaming we close the thinking block and stream the answer LIVE — so the
  // client renders tokens as the synthesizer produces them, not after the whole turn completes.
  const ci = progress ? 1 : 0; // answer/tool block index (0 normally, 1 after the thinking block)
  let thinkingOpen = false;
  let answerOpen = false;
  let streamed = "";
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  if (progress) {
    thinkingOpen = true;
    sse(res, "content_block_start", {
      type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" },
    });
    const writeThinking = (text: string): void => {
      if (!thinkingOpen) return; // dropped once the answer block opens (can't append after stop)
      sse(res, "content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "thinking_delta", thinking: text.endsWith("\n") ? text : `${text}\n` },
      });
    };
    writeThinking("frites — working…");
    progress.onMessage(writeThinking);
    const since = Date.now();
    heartbeat = setInterval(() => writeThinking(heartbeatLine(since, activeAgents)), HEARTBEAT_MS);
  }

  const closeThinking = (): void => {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    if (heartbeat) clearInterval(heartbeat);
    sse(res, "content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "signature_delta", signature: PROGRESS_SIGNATURE },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  };
  const openAnswer = (): void => {
    if (answerOpen) return;
    closeThinking();
    answerOpen = true;
    sse(res, "content_block_start", { type: "content_block_start", index: ci, content_block: { type: "text", text: "" } });
  };
  const writeAnswer = (delta: string): void => {
    if (!delta) return;
    openAnswer();
    streamed += delta;
    sse(res, "content_block_delta", { type: "content_block_delta", index: ci, delta: { type: "text_delta", text: delta } });
  };
  if (answer) answer.onMessage(writeAnswer);

  let action: AgentAction;
  try {
    action = (await turn).action;
  } catch (e) {
    turnLog.error("turn failed", { error: errMsg(e) });
    action = { kind: "answer", text: `frites gateway error: ${errMsg(e)}` };
  } finally {
    clearInterval(ping);
    if (heartbeat) clearInterval(heartbeat);
    if (progress) progress.end();
    if (answer) answer.end();
  }

  if (action.kind === "answer") {
    if (answerOpen) {
      // Streamed live; emit only any unsent suffix (normally empty — deltas == final text). If the
      // authoritative text isn't an extension of what streamed (a rare synth that narrated/read a
      // file before answering — its preamble deltas aren't in claude's `result`), we can't retract
      // already-sent deltas, so the block keeps what streamed; log the divergence.
      if (action.text !== streamed && !action.text.startsWith(streamed))
        turnLog.warn("answer/stream divergence", { streamedLen: streamed.length, answerLen: action.text.length });
      const suffix = action.text.startsWith(streamed) ? action.text.slice(streamed.length) : "";
      if (suffix) sse(res, "content_block_delta", { type: "content_block_delta", index: ci, delta: { type: "text_delta", text: suffix } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: ci });
    } else {
      // Nothing streamed live (turn-cap / error / answer disabled) → emit it now, chunked.
      closeThinking();
      sse(res, "content_block_start", { type: "content_block_start", index: ci, content_block: { type: "text", text: "" } });
      for (const piece of chunk(action.text))
        sse(res, "content_block_delta", { type: "content_block_delta", index: ci, delta: { type: "text_delta", text: piece } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: ci });
    }
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(action.text) },
    });
  } else {
    closeThinking();
    const toolId = newId("toolu");
    sse(res, "content_block_start", {
      type: "content_block_start", index: ci,
      content_block: { type: "tool_use", id: toolId, name: action.name, input: {} },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta", index: ci,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(action.input) },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index: ci });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(JSON.stringify(action.input)) },
    });
  }
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function anthropicJson(res: ServerResponse, model: string, inputTokens: number, t: TurnResult): void {
  const content =
    t.action.kind === "answer"
      ? [{ type: "text", text: t.action.text }]
      : [{ type: "tool_use", id: newId("toolu"), name: t.action.name, input: t.action.input }];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: newId("msg"), type: "message", role: "assistant", model, content,
      stop_reason: t.action.kind === "answer" ? "end_turn" : "tool_use", stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(actionText(t.action)) },
    }),
  );
}

// ── OpenAI Responses encoding (/v1/responses) — answer-only for now ──

function responseEnvelope(
  id: string,
  model: string,
  status: string,
  text?: string,
  reasoning?: { id: string; text: string },
) {
  const output: unknown[] = [];
  if (reasoning)
    output.push({
      id: reasoning.id, type: "reasoning",
      summary: [{ type: "summary_text", text: reasoning.text }],
    });
  if (text !== undefined)
    output.push({
      id: newId("msg"), type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  return {
    id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model, output,
    usage: text === undefined ? undefined : { input_tokens: 0, output_tokens: estimateTokens(text), total_tokens: estimateTokens(text) },
  };
}

async function responsesStream(
  res: ServerResponse,
  model: string,
  turn: Promise<TurnResult>,
  progress: ProgressSink | null,
  answerSink: ProgressSink | null,
  turnLog: Logger,
  activeAgents: Map<string, ActiveAgent>,
): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const respId = newId("resp");
  const itemId = newId("msg");
  const reasoningId = newId("rs");
  sse(res, "response.created", { type: "response.created", response: responseEnvelope(respId, model, "in_progress") });
  const ping = setInterval(
    () => sse(res, "response.in_progress", { type: "response.in_progress", response: responseEnvelope(respId, model, "in_progress") }),
    3000,
  );

  // Codex analog of the thinking channel: stream progress as a reasoning summary (output item 0),
  // then the answer message (output item 1) — streamed LIVE as the synthesizer produces it. Same
  // rationale as the Anthropic surface — ephemeral reasoning, doesn't pollute the answer.
  const oi = progress ? 1 : 0; // message output index (0 normally, 1 after the reasoning item)
  let reasoningText = "";
  let reasoningOpen = false;
  let answerOpen = false;
  let streamed = "";
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  if (progress) {
    reasoningOpen = true;
    sse(res, "response.output_item.added", {
      type: "response.output_item.added", output_index: 0,
      item: { id: reasoningId, type: "reasoning", summary: [] },
    });
    sse(res, "response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added", item_id: reasoningId, output_index: 0,
      summary_index: 0, part: { type: "summary_text", text: "" },
    });
    const writeReason = (text: string): void => {
      if (!reasoningOpen) return; // dropped once the answer item opens
      const line = text.endsWith("\n") ? text : `${text}\n`;
      reasoningText += line;
      sse(res, "response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta", item_id: reasoningId, output_index: 0,
        summary_index: 0, delta: line,
      });
    };
    writeReason("frites — working…");
    progress.onMessage(writeReason);
    const since = Date.now();
    heartbeat = setInterval(() => writeReason(heartbeatLine(since, activeAgents)), HEARTBEAT_MS);
  }

  const closeReasoning = (): void => {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    if (heartbeat) clearInterval(heartbeat);
    sse(res, "response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done", item_id: reasoningId, output_index: 0,
      summary_index: 0, text: reasoningText,
    });
    sse(res, "response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done", item_id: reasoningId, output_index: 0,
      summary_index: 0, part: { type: "summary_text", text: reasoningText },
    });
    sse(res, "response.output_item.done", {
      type: "response.output_item.done", output_index: 0,
      item: { id: reasoningId, type: "reasoning", summary: [{ type: "summary_text", text: reasoningText }] },
    });
  };
  const openAnswer = (): void => {
    if (answerOpen) return;
    closeReasoning();
    answerOpen = true;
    sse(res, "response.output_item.added", {
      type: "response.output_item.added", output_index: oi,
      item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    sse(res, "response.content_part.added", {
      type: "response.content_part.added", item_id: itemId, output_index: oi, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };
  const writeAnswer = (delta: string): void => {
    if (!delta) return;
    openAnswer();
    streamed += delta;
    sse(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: oi, content_index: 0, delta });
  };
  if (answerSink) answerSink.onMessage(writeAnswer);

  let answer: string;
  try {
    answer = actionText((await turn).action);
  } catch (e) {
    turnLog.error("turn failed", { error: errMsg(e) });
    answer = `frites gateway error: ${errMsg(e)}`;
  } finally {
    clearInterval(ping);
    if (heartbeat) clearInterval(heartbeat);
    if (progress) progress.end();
    if (answerSink) answerSink.end();
  }

  if (!answerOpen) {
    // Nothing streamed live → open the message item and emit it now, chunked.
    closeReasoning();
    openAnswer();
    for (const piece of chunk(answer)) writeAnswer(piece);
  } else {
    // Streamed live; emit only any unsent suffix (normally empty — deltas == final text).
    if (answer !== streamed && !answer.startsWith(streamed))
      turnLog.warn("answer/stream divergence", { streamedLen: streamed.length, answerLen: answer.length });
    const suffix = answer.startsWith(streamed) ? answer.slice(streamed.length) : "";
    if (suffix) writeAnswer(suffix);
  }
  // Canonical text (output_text.done / response.completed) is the authoritative council answer —
  // Responses clients treat .done as truth, so even if a rare divergence put preamble in the live
  // deltas, the recorded answer stays clean.
  const finalText = answer || streamed;
  sse(res, "response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: oi, content_index: 0, text: finalText });
  sse(res, "response.output_item.done", {
    type: "response.output_item.done", output_index: oi,
    item: { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: finalText, annotations: [] }] },
  });
  sse(res, "response.completed", {
    type: "response.completed",
    response: responseEnvelope(respId, model, "completed", finalText, progress ? { id: reasoningId, text: reasoningText } : undefined),
  });
  res.end();
}

// ── routing ──

/**
 * Build the per-turn IO. Milestone lines (`emit`) go to the info log; high-frequency telemetry /
 * interleaved text (`emitDetail`) goes to the debug log; both push to the progress channel when
 * it's attached. The progress channel exists only when the client is streaming AND streamProgress
 * is on; the answer channel exists whenever the client is streaming (so the final answer streams
 * live regardless of the progress setting).
 */
function makeTurnContext(streaming: boolean): TurnContext {
  const turnLog = rootLog.child({ turn: shortId() });
  const progress = streaming && config.streamProgress ? createProgressSink() : null;
  const answer = streaming ? createProgressSink() : null;
  const emit: Emit = (human, fields) => {
    turnLog.info(human, fields);
    progress?.push(human);
  };
  const emitDetail: Emit = (human, fields) => {
    turnLog.debug(human, fields);
    progress?.push(human);
  };
  return { turnLog, progress, answer, emit, emitDetail, detail: PROGRESS_DETAIL, activeAgents: new Map() };
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}");
  const model = typeof body.model === "string" ? body.model : "frites";
  const prompt = extractAnthropicPrompt(body);
  const tools = extractAnthropicTools(body);
  const sysText = typeof body.system === "string" ? body.system : blocksToText(body.system);
  const key = sessionKey(sysText + "\n" + (body.messages?.[0] ? blocksToText(body.messages[0].content) : ""));
  // Classify the user's ACTUAL ask, not the harness scaffolding (system-reminders, IDE context)
  // spliced into the user turn — that scaffolding is what made the fan-out judge reply in prose
  // ("I don't see a user request to evaluate…") instead of a verdict. Fall back to the raw text if
  // stripping leaves nothing (a turn that was all scaffolding has no cleaner request to offer).
  const rawBasis = lastUserText(body.messages ?? []) || prompt;
  const decisionBasis = stripInjectedContext(rawBasis) || rawBasis;
  const cwd = extractWorkingDir(body);
  const continuation = isAnthropicContinuation(body.messages ?? []);
  const io = makeTurnContext(!!body.stream);
  const { turnLog } = io;
  // Tool turns emit a parsed JSON action, not prose — they don't stream a live answer block.
  const answerSink = tools.length === 0 ? io.answer : null;
  turnLog.info("POST /v1/messages", {
    model, policy: config.fanOutPolicy, scope: config.fanOutScope, tools: tools.length,
    stream: !!body.stream, session: key, cwd, continuation,
    detail: io.progress ? io.detail : undefined,
  });
  if (turnLog.enabled("debug")) turnLog.debug("decision basis", { basis: decisionBasis.slice(0, 200) });
  const turn = servedTurn(key, model, turnLog, () =>
    runAgentTurn(prompt, decisionBasis, tools, model, io, continuation, cwd),
  );
  if (body.stream) await anthropicStream(res, model, estimateTokens(prompt), turn, io.progress, answerSink, turnLog, io.activeAgents);
  else anthropicJson(res, model, estimateTokens(prompt), await turn);
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}");
  const model = typeof body.model === "string" ? body.model : "frites";
  const prompt = extractResponsesPrompt(body);
  const key = sessionKey((typeof body.instructions === "string" ? body.instructions : "") + "\n" + prompt.slice(0, 200));
  // See handleMessages: classify the real ask, not injected scaffolding; fall back to raw if empty.
  const rawBasis = responsesLastUser(body) || prompt;
  const decisionBasis = stripInjectedContext(rawBasis) || rawBasis;
  const cwd = extractWorkingDir(body);
  const continuation = isResponsesContinuation(body.input);
  const io = makeTurnContext(!!body.stream);
  const { turnLog } = io;
  turnLog.info("POST /v1/responses", {
    model, policy: config.fanOutPolicy, scope: config.fanOutScope, stream: !!body.stream,
    session: key, cwd, continuation,
    detail: io.progress ? io.detail : undefined,
  });
  if (turnLog.enabled("debug")) turnLog.debug("decision basis", { basis: decisionBasis.slice(0, 200) });
  // Codex tool-call (function_call) emission is a follow-up; answer synthesis only here.
  const turn = servedTurn(key, model, turnLog, () =>
    runAgentTurn(prompt, decisionBasis, [], model, io, continuation, cwd),
  );
  if (body.stream) await responsesStream(res, model, turn, io.progress, io.answer, turnLog, io.activeAgents);
  else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseEnvelope(newId("resp"), model, "completed", actionText((await turn).action))));
  }
}

function handleCountTokens(body: string, res: ServerResponse): void {
  let prompt = "";
  try {
    prompt = extractAnthropicPrompt(JSON.parse(body || "{}"));
  } catch {
    /* ignore */
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ input_tokens: estimateTokens(prompt) }));
}

function handleModels(res: ServerResponse): void {
  const ids = new Set(config.defaultAgents.map((a) => a.model).filter((m): m is string => !!m));
  ids.add("frites-council");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      data: [...ids].map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" })),
    }),
  );
}

const server = createServer((req, res) => {
  const url = (req.url ?? "").split("?")[0];
  (async () => {
    try {
      if (!authorized(req)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: "unauthorized" } }));
        return;
      }
      if (req.method === "POST" && url === "/v1/messages") return await handleMessages(req, res);
      if (req.method === "POST" && url === "/v1/responses") return await handleResponses(req, res);
      if (req.method === "POST" && url === "/v1/messages/count_tokens") return handleCountTokens(await readBody(req), res);
      if (req.method === "GET" && url === "/v1/models") return handleModels(res);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { message: `not found: ${url}` } }));
    } catch (e) {
      rootLog.error("request handler error", { url, error: e instanceof Error ? e.stack : String(e) });
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { message: e instanceof Error ? e.message : String(e) } }));
    }
  })();
});

server.listen(PORT, HOST, () => {
  rootLog.info(`listening on http://${HOST}:${PORT} — Anthropic (/v1/messages) + OpenAI (/v1/responses)`, {
    fanOutPolicy: config.fanOutPolicy,
    fanOutScope: config.fanOutScope,
    maxTurns: config.maxTurns,
    auth: GATEWAY_TOKEN ? "on" : "off",
    streamProgress: config.streamProgress,
    progressDetail: PROGRESS_DETAIL,
    logLevel: rootLog.level,
    agents: config.defaultAgents.map((a) => childLabel(a)).join(","),
  });
});
