import { type FritesConfig, withChildDirective } from "./config.js";

export interface FanOutDecision {
  fanOut: boolean;
  n: number;
  reason: string;
}

const HARD_SIGNAL =
  /\b(why|how come|compare|trade-?offs?|design|architect|debug|analy[sz]e|prove|optimi[sz]e|root cause|pros and cons|best way|explain|evaluate|recommend)\b/i;

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
    const fan = /fan-?out|multiple|yes/i.test(verdict);
    return {
      fanOut: fan,
      n: fan ? config.defaultN : 1,
      reason: `llm-judge: ${verdict.trim().slice(0, 40)}`,
    };
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
