import type { EmitFn } from "../../infra/event-bus.js";
import type { QuestionEntry } from "../../infra/output-blocks.js";
import { formatAgentInputAnswers, type AgentInputAnswers } from "../../protocol/question-protocol-types.js";

export type AskUserResult =
  | { kind: "answered"; answers: AgentInputAnswers }
  | { kind: "cancelled" }
  | { kind: "suspended" };

export interface AskUserController {
  ask(toolUseId: string, questions: QuestionEntry[], signal?: AbortSignal): Promise<AskUserResult>;
  answerQuestion(toolUseId: string, answers: AgentInputAnswers): void;
  cancelQuestion(toolUseId: string): void;
  suspendAll(): boolean;
}

/** The controller as its owning session holds it: the tools read only the
 *  controller, and the session also reads whether a question still waits,
 *  so a planned replacement leaves that turn for the person. */
interface OwnedAskUserController extends AskUserController {
  /** Whether any question still waits for a person. */
  hasPendingQuestions(): boolean;
}

interface AskUserAnswerText { readonly [question: string]: string }

/** The output surface the controller drives: the narrow slice of
 *  OutputSession (chat) or the workflow adapter that question settlement
 *  needs. */
interface AskUserHost {
  pushQuestion(toolUseId: string, questions: QuestionEntry[], timestamp: number): void;
  answerQuestion(toolUseId: string, answers: AskUserAnswerText): void;
  cancelQuestion(toolUseId: string): void;
  flush(): void;
}

interface AskUserControllerOptions {
  host: AskUserHost;
  emit: EmitFn;
  sessionId: string;
}

interface PendingQuestion {
  resolve(result: AskUserResult): void;
  abort(): void;
}

export function createAskUserController(options: AskUserControllerOptions): OwnedAskUserController {
  const { host, emit, sessionId } = options;
  const pending = new Map<string, PendingQuestion>();
  const early = new Map<string, AskUserResult>();

  function settle(toolUseId: string, result: AskUserResult): void {
    const current = pending.get(toolUseId);
    if (!current) {
      early.set(toolUseId, result);
      return;
    }
    pending.delete(toolUseId);
    if (pending.size === 0) emit("agent.user_input.resumed", { sessionId, data: {} });
    current.abort();
    current.resolve(result);
  }

  return {
    ask(toolUseId: string, questions: QuestionEntry[], signal?: AbortSignal): Promise<AskUserResult> {
      // The transcript block carries the same composed questions the durable
      // request recorded, so a decision-bound question (whose model input has
      // no question text) renders exactly what the dock shows, and a call
      // rejected before recording renders nothing at all.
      host.pushQuestion(toolUseId, questions, Date.now());
      const prior = early.get(toolUseId);
      if (prior) {
        early.delete(toolUseId);
        if (prior.kind === "answered") host.answerQuestion(toolUseId, formatAgentInputAnswers(prior.answers));
        else host.cancelQuestion(toolUseId);
        host.flush();
        return Promise.resolve(prior);
      }
      if (signal?.aborted) return Promise.resolve({ kind: "suspended" });
      host.flush();

      return new Promise<AskUserResult>((resolve) => {
        const abort = () => {
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          settle(toolUseId, { kind: "suspended" });
        };
        const wasEmpty = pending.size === 0;
        pending.set(toolUseId, { resolve, abort });
        if (wasEmpty) emit("agent.user_input.awaiting", { sessionId, data: {} });
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    // The session's settlement already shows on the question's block, which
    // follows the committed fact; these only end the wait.
    answerQuestion(toolUseId: string, answers: AgentInputAnswers): void {
      settle(toolUseId, { kind: "answered", answers });
    },

    cancelQuestion(toolUseId: string): void {
      settle(toolUseId, { kind: "cancelled" });
    },

    hasPendingQuestions(): boolean {
      return pending.size > 0;
    },

    suspendAll(): boolean {
      const suspended = pending.size > 0;
      for (const [toolUseId, question] of pending) {
        pending.delete(toolUseId);
        question.abort();
        question.resolve({ kind: "suspended" });
      }
      return suspended;
    },
  };
}
