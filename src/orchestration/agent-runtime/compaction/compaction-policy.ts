import { CHECKPOINT_LIMIT_BYTES } from "../../session/conversation-checkpoint.js";

/** Proactive compaction fires at the configured token count or at this share
 *  of the model's context window, whichever comes first. */
const PROACTIVE_TRIGGER_RATIO = 0.85;

/** The context sizes at which an automatic reset can be due, in the order
 *  they apply: the configured token count capped at the window share, then the
 *  window share. The compaction plan owner takes the first one that the fresh
 *  context is below (ARCH-CONTEXT-036). A non-positive configured count
 *  disables automatic resets, so it yields none and only manual and
 *  context-overflow compaction run. */
export function proactiveCompactionTriggers(contextLimit: number, configuredTokens: number): readonly number[] {
  if (configuredTokens <= 0) return [];
  const windowShare = Math.ceil(contextLimit * PROACTIVE_TRIGGER_RATIO);
  return configuredTokens < windowShare ? [configuredTokens, windowShare] : [windowShare];
}

/** The one characters-per-token ratio of every context budget. Code-heavy
 *  output is denser, so a budget built on it is an estimate. */
export const CHARS_PER_TOKEN = 4;
/** The context that a planned save round needs after the request that
 *  triggers it: one full checkpoint read and one full rewrite. */
export const SAVE_ROUND_RESERVE_TOKENS = (2 * CHECKPOINT_LIMIT_BYTES) / CHARS_PER_TOKEN;

const DEFAULT_TURN_BUDGET_CHARS = 200_000;
const MIN_TURN_BUDGET_CHARS = 16_000;
// Fraction of a model's context window the whole turn's tool output may
// occupy: the system prompt, tool schemas, history, and the model's own
// reply all compete for the same window.
const PER_TURN_WINDOW_FRACTION = 0.3;

/** The fixed share of the window that one tool batch may occupy: proportional
 *  for small models, clamped at the default so large (200K+) models are
 *  unchanged, floored so a tiny model still gets a usable budget. */
export function turnBudgetChars(contextWindowTokens: number | undefined): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return DEFAULT_TURN_BUDGET_CHARS;
  const proportional = Math.floor(contextWindowTokens * CHARS_PER_TOKEN * PER_TURN_WINDOW_FRACTION);
  return Math.max(MIN_TURN_BUDGET_CHARS, Math.min(proportional, DEFAULT_TURN_BUDGET_CHARS));
}

/** The bound of one request's tool batch. `admit` reports the characters the
 *  batch put into the next request, after the bound was enforced. */
export interface TurnOutputBound {
  readonly chars: number;
  /** Reads keep their exemption only while the fixed share binds: under
   *  headroom pressure every result except author-bounded text can be
   *  replaced, and the save round that the next request plans ends the
   *  persist-then-read cycle. */
  readonly readsExempt: boolean;
  admit(chars: number): void;
}

/** The fixed-share bound for a batch that no request follows, such as the
 *  handoff of an exhausted budget. */
export function fixedTurnOutputBound(contextWindowTokens: number | undefined): TurnOutputBound {
  return { chars: turnBudgetChars(contextWindowTokens), readsExempt: true, admit: () => {} };
}

/** The one context admission budget of a loop (ARCH-CONTEXT-029). Tool
 *  batches and delivered input, such as subagent results, draw from the
 *  headroom that the next planned save needs, so content that lands below
 *  the compaction trigger never pushes the save request past the context
 *  window. */
export interface ContextAdmission {
  /** Opens the window of one request and reserves its tool batch bound.
   *  Call it after the request is prepared, so `usage` measures its input. */
  openRequest(): TurnOutputBound;
  /** Characters that content entering the next request may still take. */
  remainingChars(): number;
  /** Holds `chars` under `id` for content sized now that a later request
   *  carries, such as a subagent result before its notification is in the
   *  history. The hold outlasts every request until `admit` delivers `id`. */
  reserve(id: string, chars: number): void;
  /** Charges content that entered the history after the request opened, and
   *  releases the holds of the ids that it delivers. */
  admit(chars: number, delivered?: readonly string[]): void;
}

/** `usage` is the live estimate of the next request's input tokens and the
 *  context window of its planned attempt. Content that this budget does not
 *  admit, such as the assistant's own output, is outside the estimate. */
export function createContextAdmission(usage: () => { promptTokens: number; contextLimit: number }): ContextAdmission {
  const headroomChars = (): number => {
    const { promptTokens, contextLimit } = usage();
    return Math.max(0, (contextLimit - SAVE_ROUND_RESERVE_TOKENS - promptTokens) * CHARS_PER_TOKEN);
  };
  // Measured when a request opens; content admitted after that point is in
  // `admitted`, not yet in the estimate. Before the first request it is measured live.
  let headroom: number | undefined;
  let admitted = 0;
  // Not in the history, so no estimate holds them and no request opening clears them.
  const held = new Map<string, number>();
  const heldChars = (): number => [...held.values()].reduce((sum, chars) => sum + chars, 0);
  return {
    openRequest() {
      headroom = headroomChars();
      const available = Math.max(0, headroom - heldChars());
      const share = turnBudgetChars(usage().contextLimit);
      const reserved = available >= share ? share : Math.max(MIN_TURN_BUDGET_CHARS, available);
      admitted = reserved;
      return { chars: reserved, readsExempt: available >= share, admit: (chars) => { admitted += chars - reserved; } };
    },
    remainingChars: () => Math.max(0, (headroom ?? headroomChars()) - admitted - heldChars()),
    reserve(id, chars) { held.set(id, chars); },
    admit(chars, delivered = []) {
      for (const id of delivered) held.delete(id);
      admitted += chars;
    },
  };
}
