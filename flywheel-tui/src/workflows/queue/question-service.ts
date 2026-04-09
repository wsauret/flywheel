/**
 * QuestionService — Deferred + EventBus pattern for user interaction.
 *
 * Adapted from OpenCode's question/service.ts. Replaces Effect Deferred
 * with raw Promise + resolver/rejecter stored in a pending map. Replaces
 * Bus.publish with EventBus.emit.
 *
 * Decision #3: mirrors OpenCode architecture.
 * Decision #6: no timeout in V1.
 * Decision #12: questions presented all at once with tab navigation.
 */

import type { EventBus } from "../../infra/event-bus";

// ---------------------------------------------------------------------------
// Types — formerly in question-parser.ts, now canonical home
// ---------------------------------------------------------------------------

export interface QuestionOption {
  label: string;
  description: string;
}

export interface OpenQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  source?: string;
  default?: string;
}

export interface ResolvedQuestion {
  question: string;
  answers: string[];
  source: "user" | "auto";
}

// ---------------------------------------------------------------------------
// Types — QuestionInfo extends OpenQuestion with `custom` for TUI prompts
// ---------------------------------------------------------------------------

export type QuestionInfo = OpenQuestion & {
  custom?: boolean;
  /**
   * When true, the question renders as a bare text input — no options list,
   * no "Type your own answer" indirection. The user types directly and
   * presses Enter to submit. Used for free-form prompts like "What do
   * you want to build?".
   */
  textOnly?: boolean;
};

/** Per-question answer: array of selected option labels or custom text */
export type QuestionAnswer = string[];

export interface QuestionRequest {
  id: string;
  questions: QuestionInfo[];
}

// ---------------------------------------------------------------------------
// Service Options
// ---------------------------------------------------------------------------

export interface QuestionServiceOptions {
  /**
   * When true, questions are auto-resolved with defaults immediately
   * (no event emitted, no UI displayed). Used when
   * `config.interactive_consolidation` is false.
   */
  autoResolve?: boolean;
}

// ---------------------------------------------------------------------------
// Pending entry: replaces Effect Deferred with Promise resolver
// ---------------------------------------------------------------------------

interface PendingEntry {
  info: QuestionRequest;
  resolve: (answers: QuestionAnswer[]) => void;
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// QuestionService
// ---------------------------------------------------------------------------

export class QuestionService {
  private pending = new Map<string, PendingEntry>();
  private autoResolve: boolean;

  constructor(
    private eventBus: EventBus,
    options?: QuestionServiceOptions,
  ) {
    this.autoResolve = options?.autoResolve ?? false;
  }

  /**
   * Ask one or more questions. Returns a Promise that suspends until
   * `reply()` or `reject()` is called for this request.
   *
   * In auto-resolve mode, returns immediately with defaults (no event,
   * no UI).
   */
  async ask(questions: QuestionInfo[]): Promise<QuestionAnswer[]> {
    // Auto-resolve mode: return defaults immediately
    if (this.autoResolve) {
      return questions.map((q) => {
        if (q.default) return [q.default];
        if (q.options.length > 0) return [q.options[0].label];
        return [];
      });
    }

    const id = crypto.randomUUID();

    return new Promise<QuestionAnswer[]>((resolve, reject) => {
      const info: QuestionRequest = { id, questions };
      this.pending.set(id, { info, resolve, reject });

      this.eventBus.emit({
        type: "question:asked",
        requestId: id,
        questions,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Reply to a pending question request with answers.
   * Resolves the suspended Promise. No-op if request ID not found.
   */
  reply(requestId: string, answers: QuestionAnswer[]): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    this.pending.delete(requestId);
    this.eventBus.emit({
      type: "question:replied",
      requestId,
      answers,
      timestamp: Date.now(),
    });
    entry.resolve(answers);
  }

  /**
   * Reject/dismiss a pending question request.
   * Rejects the suspended Promise. No-op if request ID not found.
   */
  reject(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    this.pending.delete(requestId);
    this.eventBus.emit({
      type: "question:rejected",
      requestId,
      timestamp: Date.now(),
    });
    entry.reject(new QuestionRejectedError());
  }

  /**
   * List all pending question requests.
   */
  list(): QuestionRequest[] {
    return Array.from(this.pending.values(), (x) => x.info);
  }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class QuestionRejectedError extends Error {
  readonly _tag = "QuestionRejectedError";
  constructor() {
    super("The user dismissed this question");
  }
}
