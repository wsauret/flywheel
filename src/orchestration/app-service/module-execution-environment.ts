import { isAgentInFlight, type AgentGroupBlock, type AnyBlock } from "../../infra/output-blocks.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { ChatRunner } from "../chat/runner-types.js"
import { childSessionProjectionAttachment } from "../session-store/child-session-projection.js"
import type { SessionStore } from "../session-store/types.js"
import type { ModuleExecutionEnvironment } from "./module-service-host.js"
import type { RuntimeSupervisor } from "./runtime-supervisor-types.js"
import type { TranscriptProjectionCache } from "./transcript-projection-cache.js"
import { attachedRunnerDelivery } from "./session-background-notifications.js"
import { sessionDisplayName } from "../session/schemas.js"
import { deliverSessionInput, type SessionInputDeliveryDeps } from "../session/session-input-delivery.js"

/** See `ModuleExecutionEnvironment.sendSessionMessage`. */
async function sendRuntimeSessionMessage(delivery: SessionInputDeliveryDeps, { fromSessionId, toSessionId, call, text }: Parameters<ModuleExecutionEnvironment["sendSessionMessage"]>[0]): ReturnType<ModuleExecutionEnvironment["sendSessionMessage"]> {
  const from = await delivery.manager.read(fromSessionId)
  if (from?.kind !== "chat") return { status: "refused", reason: "not_found" }
  const producer = {
    kind: "session", sessionId: fromSessionId, conversationId: from.conversationId, toolUseId: call, hop: 0,
    envelope: { name: sessionDisplayName({ id: fromSessionId, session: from }), relation: "other", waits: false },
  } as const
  // The runtime names the call, so a send again after a restart carries the same key, and the delivery finds the
  // message where the recipient holds it: as an entry, which records nothing, or as a held cell, which a runner that
  // reads now takes.
  return await deliverSessionInput(delivery, toSessionId, { text, producer })
}

/** An agent card that has not finished: it runs, waits to run, or is paused. */
const unfinishedCard = (block: AnyBlock): block is AgentGroupBlock => block.kind === "agentGroup" && (isAgentInFlight(block.status) || block.status === "paused")

/** See `ModuleExecutionEnvironment.liveAgentCards`. A subagent's card starts as its call's tool row, which the
 *  projection turns into the card, so each such row is projected too. */
async function liveAgentCards(sessionStore: SessionStore, transcriptCache: Pick<TranscriptProjectionCache, "projectBlock">, sessionId: string): Promise<readonly AgentGroupBlock[]> {
  const candidates = (sessionStore.get(sessionId)?.outputBlocks() ?? []).filter((block) => unfinishedCard(block) || (block.kind === "tool" && block.name === "subagent"))
  return (await Promise.all(candidates.map((block) => transcriptCache.projectBlock(sessionId, block)))).filter(unfinishedCard)
}

/** The request-time execution authorities that the runtime hands every module service, read from the runtime's own
 *  owners. Building it activates no session; each member reaches its owner only when a module calls it. */
export function moduleExecutionEnvironment(owners: {
  readonly authAdmission: ModuleExecutionEnvironment["authAdmission"]
  readonly recall: (conversationId: string, input: RecallInput) => Promise<RecallResult>
  readonly findChats: ModuleExecutionEnvironment["findChats"]
  readonly sessionEvents: ModuleExecutionEnvironment["sessionEvents"]
  readonly sessionStore: SessionStore
  readonly transcriptCache: Pick<TranscriptProjectionCache, "projectBlock">
  readonly supervisor: RuntimeSupervisor
  readonly delivery: SessionInputDeliveryDeps
}): ModuleExecutionEnvironment {
  const { supervisor } = owners
  return {
    authAdmission: owners.authAdmission,
    recall: owners.recall,
    findChats: owners.findChats,
    attachProjection: childSessionProjectionAttachment(owners.sessionStore),
    deliverNotification: attachedRunnerDelivery(owners.sessionStore),
    openChatRunner: async (sessionId): Promise<ChatRunner | undefined> => await supervisor.activateSession(sessionId) ? supervisor.ensureChatRunner(sessionId) : undefined,
    personEntries: (sessionId, earlierTurns) => supervisor.personEntries(sessionId, earlierTurns),
    forwardPersonEntries: (input) => supervisor.forwardPersonEntries(input),
    openChat: (chat) => supervisor.openSessionRuntime(chat),
    sessionEvents: owners.sessionEvents,
    sessionRuntime: (sessionId) => supervisor.runtimeState(sessionId),
    createOpenHold: () => supervisor.createOpenHold(),
    onChatClosed: (listener) => supervisor.onChatClosed(listener),
    onSessionReleased: (listener) => supervisor.onSessionReleased(listener),
    sessionShown: (sessionId) => supervisor.isShown(sessionId),
    sendSessionMessage: (input) => sendRuntimeSessionMessage(owners.delivery, input),
    liveAgentCards: (sessionId) => liveAgentCards(owners.sessionStore, owners.transcriptCache, sessionId),
  }
}
