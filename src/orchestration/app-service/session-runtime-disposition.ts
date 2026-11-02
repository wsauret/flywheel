import { isEmptyChat } from "../session/empty-chat.js"
import type { ClosingDisposition, SessionRuntimeActorContext } from "./session-runtime-actor-types.js"

type DispositionContext = Pick<SessionRuntimeActorContext, "sessionStore" | "manager" | "projectionReader">

/** What a closing session's durable record becomes, decided before its store
 *  entry leaves, because the decision reads that entry. */
export type PreparedDisposition =
  | { readonly kind: "none" }
  | { readonly kind: "delete" }
  | { readonly kind: "deactivate"; readonly chatMetadata?: { readonly providerConversationId?: string; readonly seedContext?: string } }

/** Whether this chat is an empty chat (`isEmptyChat`), the one rule that
 *  a stop's removal of paused chats also applies. A message that the open
 *  display shows counts as well: it reaches the display at once and the
 *  conversation only when its turn commits it. */
export async function shouldTombstone(ctx: DispositionContext, sessionId: string): Promise<boolean> {
  const entry = ctx.sessionStore.get(sessionId)
  if (entry?.kind === "chat" && entry.outputBlocks().some((block) => block.kind === "userMessage")) return false
  return isEmptyChat(await ctx.manager.read(sessionId), ctx.projectionReader)
}

function chatMetadata(ctx: DispositionContext, sessionId: string): { readonly providerConversationId?: string; readonly seedContext?: string } | undefined {
  const entry = ctx.sessionStore.get(sessionId)
  if (entry?.kind !== "chat") return undefined
  return {
    ...(entry.providerConversationId ? { providerConversationId: entry.providerConversationId } : {}),
    ...(entry.seedContext ? { seedContext: entry.seedContext } : {}),
  }
}

/** A finished runner keeps its session, inactive. */
export async function prepareDeactivation(ctx: DispositionContext, sessionId: string): Promise<PreparedDisposition> {
  return await ctx.manager.read(sessionId) === null ? { kind: "none" } : { kind: "deactivate", chatMetadata: chatMetadata(ctx, sessionId) }
}

export async function prepareDisposition(ctx: DispositionContext, sessionId: string, disposition: ClosingDisposition): Promise<PreparedDisposition> {
  if (await ctx.manager.read(sessionId) === null) return { kind: "none" }
  // The durable session decides, so a chat whose runner already finished
  // and left the store is decided as the stop's removal decides it.
  const tombstone = disposition === "delete" || (disposition === "close" && await shouldTombstone(ctx, sessionId))
  return tombstone ? { kind: "delete" } : { kind: "deactivate", chatMetadata: chatMetadata(ctx, sessionId) }
}

export async function finalizeDisposition(ctx: DispositionContext, sessionId: string, prepared: PreparedDisposition): Promise<void> {
  if (prepared.kind === "none") return
  if (prepared.kind === "delete") throw new Error("Session deletion must run through the actor deletion tail")
  if (prepared.chatMetadata) await ctx.manager.updateChatMetadata(sessionId, prepared.chatMetadata)
  await ctx.manager.updateLifecycleState(sessionId, "inactive")
}
