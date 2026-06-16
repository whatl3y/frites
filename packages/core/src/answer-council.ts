import { type FritesConfig, withChildDirective } from "./config.js";

export interface FanOutDecision {
  fanOut: boolean;
  n: number;
  reason: string;
}

const HARD_SIGNAL =
  /\b(why|how come|compare|trade-?offs?|design|architect|debug|analy[sz]e|prove|optimi[sz]e|root cause|pros and cons|best way|explain|evaluate|recommend)\b/i;

/**
 * Harness-injected wrapper tags whose contents are NOT the user's request. Claude Code splices
 * these into the user turn (background context, IDE state); a fan-out judge asked to classify
 * "the request" gets confused by them and replies in prose instead of a verdict — which then
 * trips a loose parser. Stripping them first lets the judge (and the length/newline heuristic)
 * see the real ask. Conservative by design: only KNOWN harness tags are removed (never generic
 * XML), so a user who pastes markup in their actual question keeps it intact. Extend this list if
 * the harness starts splicing new wrapper tags.
 */
const INJECTED_TAGS = ["system-reminder", "ide_selection"];

/**
 * Remove harness-injected scaffolding from text destined for the fan-out classifier. Returns the
 * cleaned text; callers should fall back to the ORIGINAL when this comes back empty — a turn that
 * was all scaffolding has no real request to classify, so feeding the judge "" helps nobody (the
 * strict verdict parser then fails closed on whatever the confused judge says).
 */
export function stripInjectedContext(text: string): string {
  if (!text) return text;
  let out = text;
  for (const tag of INJECTED_TAGS) {
    // Remove well-formed blocks. Non-greedy body + literal close tag → linear scan, no catastrophic
    // backtracking; non-greedy also stops two SEPARATE blocks being merged across the text between.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"), " ");
    // Mop up ORPHAN delimiters left by nested same-type tags or an unclosed tag. These names are
    // reserved harness tags, so a lone <tag>/</tag> is residue, not user prose — drop just the
    // delimiter (keep surrounding words) so no tag syntax leaks into the classifier.
    out = out.replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), " ");
  }
  // Tidy the whitespace the removals leave behind (trailing spaces, blank-line runs).
  return out.replace(/[^\S\n]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Decide whether a prompt is worth N-way fan-out, honoring config.fanOutPolicy.
 * v1 is heuristic; swap in an LLM judge later for true "coordinator judgement".
 */
export function decideFanOut(
  prompt: string,
  config: FritesConfig,
): FanOutDecision {
  const n = config.defaultN;
  switch (config.fanOutPolicy) {
    case "never":
      return { fanOut: false, n: 1, reason: "policy=never" };
    case "always":
      return { fanOut: true, n, reason: "policy=always" };
    case "necessary": {
      const fan = prompt.trim().length > 400 || HARD_SIGNAL.test(prompt);
      return {
        fanOut: fan,
        n: fan ? n : 1,
        reason: fan ? "necessary: substantive prompt" : "necessary: trivial — single agent",
      };
    }
    default: {
      // auto
      const fan =
        prompt.trim().length > 120 ||
        HARD_SIGNAL.test(prompt) ||
        prompt.includes("\n");
      return {
        fanOut: fan,
        n: fan ? n : 1,
        reason: fan ? "auto: non-trivial — fanning out" : "auto: trivial — single agent",
      };
    }
  }
}

export interface AnswerCouncilDeps {
  /** Call one model. role distinguishes proposer children from the synthesizer. */
  complete: (
    prompt: string,
    ctx: { role: "child" | "synth"; index: number },
  ) => Promise<string>;
  config: FritesConfig;
  onProgress?: (message: string) => void;
  /** Precomputed fan-out decision (e.g. from llmJudgeFanOut); falls back to decideFanOut. */
  decision?: FanOutDecision;
}

/**
 * Map a judge's reply to a decision. The judge is asked for exactly ONE word — "fan-out" or
 * "single" — so we parse STRICTLY (anchored at the start of the reply) and fail CLOSED: only a
 * reply that clearly begins with a "fan-out" token fans out; "single" and ANY non-compliant reply
 * resolve to a single agent.
 *
 * This replaces a loose `/fan-?out|multiple|yes/i.test(verdict)` that scanned the WHOLE reply: the
 * judge prompt itself contains the word "MULTIPLE", and a model that answers in a sentence instead
 * of one word ("…I can consult multiple agents…") would trip it and wrongly take the expensive
 * fan-out path. The `reason` now reports the PARSED verdict (and, when unclear, a quoted preview),
 * so the progress line reflects the decision that was actually made rather than arbitrary prose.
 */
export function parseFanOutVerdict(verdict: string, config: FritesConfig): FanOutDecision {
  const head = verdict.trim().replace(/^["'`*\s]+/, "").toLowerCase();
  const saysFanOut = /^fan[-\s]?out\b/.test(head);
  const saysSingle = /^single\b/.test(head);
  const kind = saysFanOut ? "fan-out" : saysSingle ? "single" : "unclear→single";
  const reason =
    saysFanOut || saysSingle
      ? `llm-judge: ${kind}`
      : `llm-judge: ${kind} (${JSON.stringify(verdict.trim().slice(0, 40))})`;
  return { fanOut: saysFanOut, n: saysFanOut ? config.defaultN : 1, reason };
}

/**
 * Ask a cheap model to judge whether a prompt warrants multi-agent fan-out — the
 * "coordinator uses its best judgement" mode. Falls back to the heuristic on any error.
 */
export async function llmJudgeFanOut(
  prompt: string,
  classify: (q: string) => Promise<string>,
  config: FritesConfig,
): Promise<FanOutDecision> {
  try {
    const verdict = await classify(
      "You decide whether a user's request warrants consulting MULTIPLE independent " +
        "expert agents (then synthesizing) versus a single agent. Reply with exactly one word.\n" +
        "Reply 'fan-out' if it is open-ended, contested, high-stakes, design/architecture, " +
        "requires weighing multiple approaches or perspectives, or benefits from cross-checking " +
        "for correctness.\n" +
        "Reply 'single' if it is simple, factual, has one clear answer, or is trivial.\n\n" +
        "Request:\n" +
        prompt,
    );
    return parseFanOutVerdict(verdict, config);
  } catch {
    return decideFanOut(prompt, config);
  }
}

export interface AnswerCouncilResult {
  answer: string;
  fannedOut: boolean;
  decision: FanOutDecision;
  childAnswers: string[];
}

const ANSWER_FORMATTING_DIRECTIVE = [
  "Format the final user-facing answer as readable GitHub-flavored Markdown when structure helps:",
  "use short headings, bold emphasis, numbered lists, bullet lists, tables, and links where appropriate.",
  "Do not force formatting for trivial one-line answers, and do not wrap the whole response in a code block.",
].join(" ");

function withAnswerFormatting(prompt: string): string {
  return `${prompt}\n\n${ANSWER_FORMATTING_DIRECTIVE}`;
}

/**
 * The transparent-proxy brain for answer/reasoning turns: optionally fan out to N
 * children (diverse framings), then synthesize one vetted answer. No worktrees/tools —
 * this is Stance-A text synthesis. Heavy file-editing lives in the worktree (MCP) path.
 */
export async function runAnswerCouncil(
  prompt: string,
  deps: AnswerCouncilDeps,
): Promise<AnswerCouncilResult> {
  const log = deps.onProgress ?? (() => {});
  const decision = deps.decision ?? decideFanOut(prompt, deps.config);

  if (!decision.fanOut) {
    log(`single agent (${decision.reason})`);
    const sole = withChildDirective(withAnswerFormatting(prompt), deps.config.childDirective);
    const answer = await deps.complete(sole, { role: "child", index: 0 });
    return { answer, fannedOut: false, decision, childAnswers: [answer] };
  }

  log(`consulting ${decision.n} agents (${decision.reason})`);
  const framings = deps.config.defaultAgents
    .map((a) => a.framing)
    .filter((f): f is string => !!f);

  const childAnswers = await Promise.all(
    Array.from({ length: decision.n }, (_, i) => {
      const framing = framings.length ? framings[i % framings.length] : undefined;
      const framed = withChildDirective(
        framing ? `${prompt}\n\n(Approach: ${framing})` : prompt,
        deps.config.childDirective,
      );
      return deps
        .complete(framed, { role: "child", index: i })
        .catch(
          (e) =>
            `(agent ${i + 1} failed: ${e instanceof Error ? e.message : String(e)})`,
        );
    }),
  );

  log("synthesizing");
  const answer = await deps.complete(buildSynthesisPrompt(withAnswerFormatting(prompt), childAnswers), {
    role: "synth",
    index: -1,
  });
  return { answer, fannedOut: true, decision, childAnswers };
}

function buildSynthesisPrompt(question: string, answers: string[]): string {
  const blocks = answers
    .map((a, i) => `=== Response ${i + 1} ===\n${a}`)
    .join("\n\n");
  return [
    "You are a coordinator. Several agents independently answered the user's request below.",
    "Synthesize ONE best, vetted answer: keep what they agree on, adjudicate disagreements,",
    "drop anything unsupported or wrong. Do not mention that multiple responses existed —",
    "just give the single best answer directly. Never mention sandboxes, working directories,",
    "or missing file access, and strip any such remarks from the source answers — they are",
    "runtime artifacts, not part of the user's answer.",
    "Output ONLY the final answer text. Do NOT narrate what you're doing, do NOT write a",
    "preamble like \"Here's the answer\" or \"Let me…\", and do NOT inspect files — you already",
    "have the responses you need. Your reply is streamed verbatim to the user as the answer, so",
    "the very first characters you emit must be the answer itself.",
    "",
    `User request:\n${question}`,
    "",
    `Independent responses:\n${blocks}`,
  ].join("\n");
}
