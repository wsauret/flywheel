import type { ChatInputLike } from "../../infra/chat-input.js"
import type { SessionChangesUndo, SessionChangesUndoResult } from "../../protocol/session-changes-protocol-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { AgentInputAnswer } from "../../protocol/question-protocol-types.js"
import type { MutationResult, FrontendMutation, SessionTitlePatch } from "../../protocol/app-service-types.js"
import type { DiscardTransientOutcome, QuestionRefusal, QuestionSettlementOutcome, ResumeChatOutcome, SendChatOutcome } from "./runtime-supervisor-types.js"
import { classifyChatMutation } from "./session-mutation-routing.js"
import { SessionForkRefusal } from "../session/manager.js"

interface QuestionAnswers {
  [questionId: string]: AgentInputAnswer
}
export interface ChatMutationDeps {
  readonly supervisor: {
    undoChanges(request: SessionChangesUndo): Promise<SessionChangesUndoResult>
    openSessionRuntime(): Promise<string>
    forkSession(sourceSessionId: string): Promise<string>
    sendChat(sessionId: string, input: ChatInputLike): Promise<SendChatOutcome>
    activateSession(sessionId: string, options?: { readonly shown?: true }): Promise<boolean>
    releaseSession(sessionId: string): Promise<void>
    closeChat(sessionId: string): Promise<boolean>
    discardTransientChat(sessionId: string): Promise<DiscardTransientOutcome>
    deleteSession(sessionId: string, inactiveBefore?: number): Promise<boolean>
    renameSession(sessionId: string, patch: SessionTitlePatch): Promise<boolean>
    reorderSession(sessionId: string, beforeSessionId: string | null): boolean
    dismissNotice(sessionId: string, scope: string): boolean
    interruptSession(sessionId: string, by: "person"): Promise<boolean>
    resumeChat(sessionId: string): Promise<ResumeChatOutcome>
    releaseForegroundBash(sessionId: string, toolUseId: string): boolean
    answerQuestion(sessionId: string, toolUseId: string, answers: QuestionAnswers): Promise<QuestionSettlementOutcome>
    terminateBackgroundWork(sessionId: string, toolUseId: string): Promise<void>
    cancelQuestion(sessionId: string, toolUseId: string): Promise<QuestionSettlementOutcome>
    compactChat(sessionId: string): Promise<boolean>
  }
}

type ChatMutation = Extract<FrontendMutation, { type: "chat.open" | "chat.compact" | "chat.interrupt" | "chat.resume" | "bash.detach" | "background.terminate" | "session.activate" | "session.release" | "session.fork" | "session.close" | "session.discard_transient" | "session.delete" | "session.rename" | "session.reorder" | "session.dismiss_notice" | "question.answer" | "question.cancel" }>

export function handleChatMutation(mutation: ChatMutation, deps: ChatMutationDeps): Promise<MutationResult>
export function handleChatMutation(mutation: SessionChangesUndo, deps: ChatMutationDeps): Promise<SessionChangesUndoResult>
export function handleChatMutation(mutation: ChatMutation | SessionChangesUndo, deps: ChatMutationDeps): Promise<MutationResult | SessionChangesUndoResult>
export async function handleChatMutation(mutation: ChatMutation | SessionChangesUndo, deps: ChatMutationDeps): Promise<MutationResult | SessionChangesUndoResult> {
  if (mutation.type === "session.changes.undo") return deps.supervisor.undoChanges(mutation)
  // Route on the exhaustive classifier's category, never the raw tag: a newly
  // added mutation tag fails to compile until it is classified, so it can never
  // silently inherit the wrong preemptive-vs-stateful path here.
  try {
    switch (classifyChatMutation(mutation.type).category) {
      case "preemptive":
        if (mutation.type === "chat.interrupt") {
          // An interrupt that finds no runner met a session whose runner was
          // lost under an open tab. The tab keeps its runner (ARCH-SESSIONS-038), so the
          // session is reattached here, idle, and the person is told nothing.
          if (!await deps.supervisor.interruptSession(mutation.sessionId, "person")) void deps.supervisor.activateSession(mutation.sessionId, { shown: true }).catch(() => {})
        } else if (mutation.type === "bash.detach") deps.supervisor.releaseForegroundBash(mutation.sessionId, mutation.toolUseId)
        else throw new Error(`${mutation.type} classified preemptive`)
        return { ok: true, sessionId: mutation.sessionId }
      case "ordered":
      case "lifecycle":
      case "supervisor":
      case "out-of-actor":
        if (mutation.type === "chat.interrupt" || mutation.type === "bash.detach") throw new Error(`${mutation.type} classified as stateful`)
        return await routeStateful(mutation, deps)
    }
  } catch (err) {
    Log.Default.error("chat mutation failed", { mutation: mutation.type, error: errorMessage(err), stack: err instanceof Error ? err.stack : undefined })
    return {
      ok: false,
      error: mutation.type === "session.fork"
        ? err instanceof SessionForkRefusal ? err.message : "Unable to fork this conversation"
        : errorMessage(err),
    }
  }
}

/** Delegate every mutation whose category mutates per-session runtime or list
 *  state. Preemptive commands are handled by the caller, so they are excluded
 *  from the parameter type rather than left as unreachable runtime arms. */
async function routeStateful(mutation: Exclude<ChatMutation, { type: "chat.interrupt" | "bash.detach" }>, deps: ChatMutationDeps): Promise<MutationResult> {
  switch (mutation.type) {
    case "chat.resume": {
      const resumed = await deps.supervisor.resumeChat(mutation.sessionId)
      return resumed.ok ? { ok: true, sessionId: mutation.sessionId } : { ok: false, error: resumed.reason }
    }
    case "chat.open": {
      const sessionId = await deps.supervisor.openSessionRuntime()
      if (mutation.initialMessage !== undefined) {
        const sent = await deps.supervisor.sendChat(sessionId, mutation.initialMessage)
        if (!sent.ok) return { ok: false, error: sent.reason }
      }
      return { ok: true, sessionId }
    }
    case "session.fork": {
      const sessionId = await deps.supervisor.forkSession(mutation.sessionId)
      return { ok: true, sessionId }
    }
    case "session.activate":
      return commandResult(mutation.sessionId, await deps.supervisor.activateSession(mutation.sessionId, { shown: true }), "activate chat session")
    case "session.release":
      // The answer carries no row: a release changes no catalog field, and
      // the runner's end reaches clients through the session's status.
      await deps.supervisor.releaseSession(mutation.sessionId)
      return { ok: true }
    case "session.close":
      return commandResult(mutation.sessionId, await deps.supervisor.closeChat(mutation.sessionId), "close chat session")
    case "session.discard_transient": {
      const outcome = await deps.supervisor.discardTransientChat(mutation.sessionId)
      return { ok: true, sessionId: mutation.sessionId, sessionRemoved: outcome.removed }
    }
    case "session.delete":
      if (mutation.inactiveBefore !== undefined) {
        return { ok: true, sessionId: mutation.sessionId, sessionRemoved: await deps.supervisor.deleteSession(mutation.sessionId, mutation.inactiveBefore) }
      }
      return commandResult(mutation.sessionId, await deps.supervisor.deleteSession(mutation.sessionId, mutation.inactiveBefore), "delete session")
    case "session.rename":
      return commandResult(mutation.sessionId, await deps.supervisor.renameSession(mutation.sessionId, mutation), "rename session")
    case "chat.compact":
      return commandResult(mutation.sessionId, await deps.supervisor.compactChat(mutation.sessionId), "compact active context", "No active context to compact yet")
    case "question.answer":
      return questionResult(mutation.sessionId, await deps.supervisor.answerQuestion(mutation.sessionId, mutation.toolUseId, mutation.answers))
    case "background.terminate":
      // Stop is idempotent: a task that already settled is exactly what the
      // caller asked for, so this mutation cannot fail.
      await deps.supervisor.terminateBackgroundWork(mutation.sessionId, mutation.toolUseId)
      return { ok: true, sessionId: mutation.sessionId }
    case "question.cancel":
      return questionResult(mutation.sessionId, await deps.supervisor.cancelQuestion(mutation.sessionId, mutation.toolUseId))
    case "session.reorder":
      return commandResult(mutation.sessionId, deps.supervisor.reorderSession(mutation.sessionId, mutation.beforeSessionId), "reorder session")
    case "session.dismiss_notice":
      return commandResult(mutation.sessionId, deps.supervisor.dismissNotice(mutation.sessionId, mutation.scope), "dismiss notice for session")
  }
}

function commandResult(sessionId: string, ok: boolean, action: string, failure?: string): MutationResult {
  return ok ? { ok: true, sessionId } : { ok: false, error: failure ?? `Unable to ${action} ${sessionId}` }
}

/** A refused answer or skip, in the words every client shows. The question
 *  leaves each dock on its own once the runtime records its settlement. */
function questionRefusalMessage(refusal: QuestionRefusal): string {
  switch (refusal) {
    case "already_answered": return "This question was already answered."
    case "already_skipped": return "This question was already skipped."
    case "not_pending": return "This question no longer waits for an answer."
    case "invalid_answer": return "This answer does not match the question's choices."
    case "not_chat": return "Only a chat takes answers to its questions."
  }
}

function questionResult(sessionId: string, outcome: QuestionSettlementOutcome): MutationResult {
  return outcome.ok ? { ok: true, sessionId } : { ok: false, error: questionRefusalMessage(outcome.refusal) }
}
