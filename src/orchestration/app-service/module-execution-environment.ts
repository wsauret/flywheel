import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { ChatRunner } from "../chat/runner-types.js"
import { childSessionProjectionAttachment } from "../session-store/child-session-projection.js"
import type { SessionStore } from "../session-store/types.js"
import type { ModuleExecutionEnvironment } from "./module-service-host.js"
import type { RuntimeSupervisor } from "./runtime-supervisor-types.js"
import { attachedRunnerDelivery } from "./session-background-notifications.js"
import { sessionDisplayName } from "../session/schemas.js"
import { deliverSessionInput, type SessionInputDeliveryDeps } from "../session/session-input-delivery.js"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND, queuedUserInputKey } from "../session/conversation/queued-user-inputs.js"
import { conversationHoldsEntries } from "../session/conversation/session-message-entries.js"

/** See `ModuleExecutionEnvironment.sendSessionMessage`. */
async function sendRuntimeSessionMessage(delivery: SessionInputDeliveryDeps, { fromSessionId, toSessionId, call, text }: Parameters<ModuleExecutionEnvironment["sendSessionMessage"]>[0]): ReturnType<ModuleExecutionEnvironment["sendSessionMessage"]> {
  const from = await delivery.manager.read(fromSessionId)
  if (from?.kind !== "chat") return { status: "refused", reason: "not_found" }
  const producer = {
    kind: "session", sessionId: fromSessionId, conversationId: from.conversationId, toolUseId: call, hop: 0,
    envelope: { name: sessionDisplayName({ id: fromSessionId, session: from }), relation: "other", waits: false },
  } as const
  // The runtime names the call, so a send again after a restart carries the same key: a recipient that holds it as an
  // entry or as a held cell already has the message, and the send is a receipt that records nothing.
  const key = queuedUserInputKey(producer, undefined)
  const to = await delivery.manager.read(toSessionId)
  if (to?.kind === "chat" && ((await conversationHoldsEntries(delivery.projectionReader, to.conversationId, [key])).has(key)
    || (await delivery.projectionReader.readInFlight(toSessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, key)).some((row) => row.key === key))) {
    return { status: "delivered", startsTurn: false }
  }
  return await deliverSessionInput(delivery, toSessionId, { text, producer })
}

/** The request-time execution authorities that the runtime hands every module service, read from the runtime's own
 *  owners. Building it activates no session; each member reaches its owner only when a module calls it. */
export function moduleExecutionEnvironment(owners: {
  readonly authAdmission: ModuleExecutionEnvironment["authAdmission"]
  readonly recall: (conversationId: string, input: RecallInput) => Promise<RecallResult>
  readonly sessionEvents: ModuleExecutionEnvironment["sessionEvents"]
  readonly sessionStore: SessionStore
  readonly supervisor: RuntimeSupervisor
  readonly delivery: SessionInputDeliveryDeps
}): ModuleExecutionEnvironment {
  const { supervisor } = owners
  return {
    authAdmission: owners.authAdmission,
    recall: owners.recall,
    attachProjection: childSessionProjectionAttachment(owners.sessionStore),
    deliverNotification: attachedRunnerDelivery(owners.sessionStore),
    openChatRunner: async (sessionId): Promise<ChatRunner | undefined> => await supervisor.activateSession(sessionId) ? supervisor.ensureChatRunner(sessionId) : undefined,
    personEntries: (sessionId, earlierTurns) => supervisor.personEntries(sessionId, earlierTurns),
    forwardPersonEntries: (input) => supervisor.forwardPersonEntries(input),
    openChat: (chat) => supervisor.openSessionRuntime(chat),
    sessionEvents: owners.sessionEvents,
    sessionRuntime: (sessionId) => supervisor.runtimeState(sessionId),
    sendSessionMessage: (input) => sendRuntimeSessionMessage(owners.delivery, input),
  }
}
