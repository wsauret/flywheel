import { randomUUID } from "node:crypto"
import type { ChatInputLike } from "../../infra/chat-input.js"
import { chatInputImages, normalizeChatInput } from "../../infra/chat-input.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { createConversationTreeWriterController } from "../chat/tree-writer.js"
import { personMessageKey } from "../session/conversation/queued-user-inputs.js"
import { conversationPersonMessage, recordPersonMessageReceipt } from "../session/conversation/person-message-ledger.js"
import { unsavedMessageReason } from "./session-runtime-actor-helpers.js"
import type { SessionManager } from "../session/manager.js"
import type { SessionStore } from "../session-store/types.js"

type ChatDurabilityManager = Pick<SessionManager, "read" | "createChat">

/** The SQLite/manager durability boundary for one chat session: the actor's
 *  live state never crosses this seam, so these stay plain functions over the
 *  session id and the durable substrate rather than closures over actor state.
 *  They are the only writers/readers the actor uses to materialize a chat, commit
 *  an idle user turn before the runner exists, and ask whether a branch already
 *  holds a durable user message (the tombstone predicate). */
export interface ChatDurabilityContext {
  readonly sessionId: string
  readonly projectRoot: string
  readonly manager: ChatDurabilityManager
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  /** The auth profile a chat is born with: the one this process serves it
   *  with, including an environment selector's choice, as `chat.open` and a
   *  headless task record. Absent, the session takes its profile at its first
   *  admission instead. */
  readonly authProfileId?: () => string
}

/** Narrow one session out of the ambient runtime context the supervisor and its
 *  actors share. Both open a chat's durability seam, so the mapping from that
 *  context to this one lives here. */
export function chatDurabilityContext(
  ctx: Omit<ChatDurabilityContext, "sessionId" | "projectRoot"> & { readonly directories: { readonly projectRoot: string } },
  sessionId: string,
): ChatDurabilityContext {
  return {
    sessionId,
    projectRoot: ctx.directories.projectRoot,
    manager: ctx.manager,
    eventStore: ctx.eventStore,
    projectionReader: ctx.projectionReader,
    eventWriter: ctx.eventWriter,
    ...(ctx.authProfileId ? { authProfileId: ctx.authProfileId } : {}),
  }
}

export async function ensureDurableChatSession(ctx: ChatDurabilityContext, conversationId: string): Promise<void> {
  const existing = await ctx.manager.read(ctx.sessionId)
  if (existing) {
    if (existing.kind !== "chat") throw new Error(`Session ${ctx.sessionId} is ${existing.kind}, not chat`)
    if (existing.conversationId !== conversationId) {
      throw new Error(`Session ${ctx.sessionId} conversation mismatch: ${existing.conversationId} !== ${conversationId}`)
    }
    return
  }
  await createDurableChatSession(ctx, conversationId)
}

/** How a new chat is born. A chat a person opens is the active "New Chat";
 *  a parent chat a workflow launch creates takes the launch's name, and a
 *  headless parent that no client shows is born inactive (ARCH-SESSIONS-038). */
interface DurableChatBirth {
  readonly name?: string
  readonly initialState?: "active" | "inactive"
}

/** Materialize a chat whose id this process allocated: the durable row is
 *  written in one append with the auth profile and roles the context supplies,
 *  so the session never exists without them. A caller that cannot know the id
 *  is fresh uses `ensureDurableChatSession`, which reads first. */
export async function createDurableChatSession(ctx: ChatDurabilityContext, conversationId: string, birth: DurableChatBirth = {}): Promise<void> {
  startupTrace("runtime materialize chat start")
  const authProfileId = ctx.authProfileId?.()
  await ctx.manager.createChat({
    id: ctx.sessionId, conversationId, name: birth.name ?? "New Chat", initialState: birth.initialState ?? "active",
    initialRoles: {},
    ...(authProfileId === undefined ? {} : { authProfileId }),
  })
  startupTrace("runtime materialize chat manager created")
}

/** The submissions of a person's message that the conversation already
 *  holds under its submission, an entry or a held cell, or undefined. A
 *  client sends a message again under its submission when its connection
 *  lost the answer (ARCH-SESSIONS-030), and such a copy is a receipt that records
 *  nothing. */
export async function recordedChatMessage(ctx: ChatDurabilityContext, conversationId: string, input: ChatInputLike): Promise<readonly string[] | undefined> {
  const key = personMessageKey(input)
  const where = key === undefined ? undefined : await conversationPersonMessage(ctx.projectionReader, { sessionId: ctx.sessionId, conversationId, kind: "chat" }, key)
  return where === undefined ? undefined : recordPersonMessageReceipt(ctx.sessionId, input, where)
}

/** Commits a cold send's user turn, under its submission key when it has
 *  one, so a copy that a client sends again converges on this entry. */
export async function writePreReadinessTurn(ctx: ChatDurabilityContext, conversationId: string, input: ChatInputLike): Promise<string> {
  const writer = createConversationTreeWriterController({ conversationId, sessionId: ctx.sessionId, projectRoot: ctx.projectRoot, store: ctx.eventStore, projectionReader: ctx.projectionReader, writer: ctx.eventWriter })
  try {
    const entryId = await writer.commitUserTurn(input, personMessageKey(input))
    if (!entryId) throw new Error("pre-readiness commit did not produce a durable entry id")
    return entryId
  } finally {
    await writer.dispose()
  }
}

/** Render the pre-runner transcript for an idle send: for an inline step/skill
 *  invocation, the divider plus the raw user arguments (the
 *  expanded prompt body is model-facing only); otherwise the user message.
 *  Rendered before the durable commit so the send is visible immediately, and
 *  always in the same synchronous frame as the caller's runner-null check --
 *  attachChatRunner's display seed hands whatever is in the store to the
 *  runner, so a block rendered here can never straddle the attach. */
export function renderPreRunnerTurn(store: SessionStore, sessionId: string, input: ChatInputLike): void {
  const normalized = normalizeChatInput(input)
  if (normalized.invocation) {
    store.appendPreRunnerOutput(sessionId, { kind: "divider", id: randomUUID(), label: normalized.invocation.label, timestamp: Date.now() })
    if (normalized.invocation.args) {
      store.appendPreRunnerOutput(sessionId, { kind: "userMessage", id: randomUUID(), content: normalized.invocation.args, timestamp: Date.now(), pending: false, injected: false, ...(normalized.submissionIds?.length ? { submissionIds: normalized.submissionIds } : {}) })
    }
    return
  }
  const images = chatInputImages(normalized)
  store.appendPreRunnerOutput(sessionId, { kind: "userMessage", id: randomUUID(), content: normalized.text, timestamp: Date.now(), pending: false, injected: false, ...(normalized.submissionIds?.length ? { submissionIds: normalized.submissionIds } : {}), ...(images.length ? { images } : {}) })
}

/** Shows in the pre-runner transcript why an idle send's user turn was not
 *  saved, and answers that reason for the sender. */
export function renderUnsavedPreRunnerTurn(store: SessionStore, sessionId: string, cause: string): string {
  const reason = unsavedMessageReason(cause)
  store.appendPreRunnerOutput(sessionId, { kind: "system", id: randomUUID(), message: reason, level: "error", timestamp: Date.now() })
  return reason
}
