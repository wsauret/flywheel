import { recordBackgroundFailure } from "../../infra/operation-log.js"
import { Log } from "../../infra/log.js"
import { childSessionProjectionAttachment } from "../session-store/child-session-projection.js"
import { recordGeneratedSessionName } from "../session/manager.js"
import { modelWorkflowLaunchOrigin } from "../workflow-host/launch-origin.js"
import type { ChatRunnerDeps } from "../chat/runner.js"
import type { RuntimeRunnerCapabilities } from "./runtime-supervisor-types.js"
import type { SessionRuntimeActorContext } from "./session-runtime-actor-types.js"

const log = Log.create({ service: "session-runtime-actor" })

/** The deps of one chat runner of the session that `ctx` serves: its directories, the runtime capabilities that it
 *  takes, and the callbacks through which it reports names, metadata, and its end to the session's actor. */
export function chatRunnerDeps(input: {
  readonly ctx: SessionRuntimeActorContext
  readonly sessionId: string
  readonly conversationId: string
  readonly executionCwd: string
  readonly shell: Extract<NonNullable<ReturnType<SessionRuntimeActorContext["sessionStore"]["get"]>>, { readonly kind: "chat" }>
  readonly durableSession: Awaited<ReturnType<SessionRuntimeActorContext["manager"]["read"]>>
  readonly capabilities: RuntimeRunnerCapabilities
  readonly generateTitleForNextMessage: boolean
  /** The runner ended, with `message` when it failed. */
  readonly onFinish: (message?: string) => void
}): ChatRunnerDeps {
  const { ctx, sessionId, conversationId, executionCwd, shell, durableSession, capabilities } = input
  return {
    sessionId,
    ...ctx.directories,
    executionCwd,
    definitions: capabilities.definitions,
    runtime: ctx.runtime,
    projectionReader: ctx.projectionReader,
    manager: ctx.manager,
    updateEntry: (patch) => ctx.sessionStore.updateChatEntry(sessionId, patch),
    attachChildProjection: childSessionProjectionAttachment(ctx.sessionStore),
    // The durable label is the single gate: updateLabel refuses generated
    // titles once the session is user-named, and only an accepted write
    // updates the live entry - so a rename is never clobbered in either copy.
    onSessionName: (labels) => {
      void recordGeneratedSessionName(ctx.manager, sessionId, labels).then((applied) => {
        if (applied) ctx.sessionStore.updateChatEntry(sessionId, { description: labels.label, shortDescription: labels.shortLabel })
      })
    },
    onChatMetadata: (patch) => {
      void ctx.manager.updateChatMetadata(sessionId, patch)
        .catch((error: unknown) => { recordBackgroundFailure(log, "record chat metadata", { sessionId }, error) })
    },
    onError: (message) => input.onFinish(message),
    onEnded: () => input.onFinish(),
    hasPriorBlocks: shell.outputBlocks().length > 0,
    // The display blocks themselves are handed to the runner by
    // attachChatRunner, synchronously with the authority flip, so a send
    // landing during this startup is never lost from the seed.
    generateTitleForNextMessage: input.generateTitleForNextMessage,
    suppressTitleGeneration: durableSession?.userNamed === true,
    providerConversationId: shell.providerConversationId,
    seedContext: shell.seedContext,
    conversationId,
    recall: capabilities.recall,
    rootChatCompletion: capabilities.rootChatCompletion?.(sessionId),
    authAdmission: capabilities.authAdmission,
    subscribeProfiles: capabilities.subscribeProfiles,
    proactiveCompactionThreshold: capabilities.proactiveCompactionThreshold,
    idleCompaction: capabilities.idleCompaction,
    workflowMode: capabilities.workflowMode,
    capabilities: capabilities.capabilities,
    moduleSelection: capabilities.moduleSelection,
    moduleServices: capabilities.moduleServices,
    launcher: capabilities.launcher,
    commandHandover: capabilities.commandHandover,
    childSessions: capabilities.childSessions,
    persistentProcesses: capabilities.persistentProcesses,
    allowPersistentProcesses: capabilities.allowPersistentProcesses,
    resolveKey: capabilities.resolveKey,
    // The trusted parent chat session is stamped here, not read out of model
    // input: the tool attests only its own call context, so a model call can
    // never present itself as explicit user intent. The rest of the intent
    // passes through whole, so no launch field can be dropped here.
    startWorkflow: capabilities.startWorkflow
      ? ({ model, ...intent }) => capabilities.startWorkflow?.({
          ...intent,
          origin: modelWorkflowLaunchOrigin(sessionId, model),
        }) ?? Promise.resolve({ error: "No workflow controller available" })
      : async () => ({ error: "No workflow controller available" }),
  }
}
