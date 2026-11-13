import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { ChatRunner } from "../chat/runner-types.js"
import { childSessionProjectionAttachment } from "../session-store/child-session-projection.js"
import type { SessionStore } from "../session-store/types.js"
import type { ModuleExecutionEnvironment } from "./module-service-host.js"
import type { RuntimeSupervisor } from "./runtime-supervisor-types.js"
import { attachedRunnerDelivery } from "./session-background-notifications.js"

/** The request-time execution authorities that the runtime hands every module service, read from the runtime's own
 *  owners. Building it activates no session; each member reaches its owner only when a module calls it. */
export function moduleExecutionEnvironment(owners: {
  readonly authAdmission: ModuleExecutionEnvironment["authAdmission"]
  readonly recall: (conversationId: string, input: RecallInput) => Promise<RecallResult>
  readonly sessionEvents: ModuleExecutionEnvironment["sessionEvents"]
  readonly sessionStore: SessionStore
  readonly supervisor: RuntimeSupervisor
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
  }
}
