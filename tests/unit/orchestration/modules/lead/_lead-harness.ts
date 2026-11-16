import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type AsyncEventWriter, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import { NO_MODULE_SERVICES } from "../../../../../src/infra/module-service.js"
import { createSessionEventNotices } from "../../../../../src/orchestration/app-service/session-event-notices.js"
import { moduleExecutionEnvironment } from "../../../../../src/orchestration/app-service/module-execution-environment.js"
import type { ControlSessionPorts } from "../../../../../src/orchestration/app-service/module-service-host.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { createTranscriptProjectionCache } from "../../../../../src/orchestration/app-service/transcript-projection-cache.js"
import { createRuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor.js"
import { loadSessionView } from "../../../../../src/orchestration/session-store/view.js"
import { createLeadControl } from "../../../../../src/orchestration/modules/lead/control.js"
import { createLeadService } from "../../../../../src/orchestration/modules/lead/service.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { mockRunner, supervisorBaseDeps, testSessionAuthAdmission, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { catalogRow } from "../../../../helpers/session-catalog.js"
import { join } from "node:path"
import { acquireConversationSearchIndex } from "../../../../../src/infra/conversation-fts.js"
import { createSessionMetadataProjection, sessionsFromProjection } from "../../../../../src/orchestration/session/session-metadata-projection.js"
import { createTranscriptSearch, searchableSessions } from "../../../../../src/orchestration/session/transcript-search.js"

/** The store surfaces that the lead's control part reads and writes through. */
interface ControlConnection {
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
}

/** The account's open of a chat: a durable chat with no shell and no runner. The client's activation opens both. */
export function accountOpenChat(ctx: SupervisorTestContext): ControlSessionPorts["openChat"] {
  return async ({ name }) => {
    const sessionId = await ctx.manager.createChat({ conversationId: ctx.manager.allocateId(), name, userNamed: true, executionCwd: ctx.baseDir, initialState: "active" })
    return { sessionId, row: catalogRow(sessionId, name) }
  }
}

/** A started lead service and control part over the real store, session manager, supervisor, and session event
 *  notices, with a switch for the module selection. The control part writes through `control`, by default the same
 *  connection as the service and the standalone open of a chat, as in a standalone composition. `onStored`, by default
 *  the store's broadcast, delivers stored batches to the service and to the default control connection. Each notice
 *  that a chat's runner receives is recorded by the chat's id, and `trace` records each watch and each forward in
 *  order. A runner starts once `runnerStartup` resolves, so every message that lands before then commits as the chat's
 *  entry. `eventWriter`, by default the store, is the service's own writer. `dispose` ends the service, the control part, the notices, and the supervisor. */
export function leadHarness(ctx: SupervisorTestContext, setup: { readonly projectionReader?: AsyncEventStateReadSurface; readonly onStored?: ControlConnection["onStored"]; readonly runnerStartup?: Promise<void>; readonly eventWriter?: AsyncEventWriter; readonly control?: ControlConnection & { readonly openChat?: ControlSessionPorts["openChat"] } } = {}) {
  const projectionReader = setup.projectionReader ?? asAsyncEventReadSurface(ctx.store)
  const onStored = setup.onStored ?? ctx.store.onStored
  const notices: string[] = []
  // Each input that a chat's runner took while attached, as its turn starts on it.
  const inputs: { readonly sessionId: string; readonly message: unknown }[] = []
  const trace: string[] = []
  // Each message that the service posted between sessions, with how the runtime's delivery answered it.
  const reports: { readonly fromSessionId: string; readonly toSessionId: string; readonly call: string; readonly text: string; readonly status: string }[] = []
  const patches: RuntimeUiPatchInput[] = []
  const storeReader = asAsyncEventReadSurface(ctx.store)
  const transcriptCache = createTranscriptProjectionCache({ sessionStore: ctx.sessionStore, reader: storeReader, projectionReader: storeReader, projectRoot: ctx.baseDir })
  // It opens a closed chat again, as the executor does.
  const supervisor: RuntimeSupervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => {
      await setup.runnerStartup
      return mockRunner(deps.sessionId, {
        deliverSilentNotice: async () => { notices.push(deps.sessionId); return "delivered" },
        send: async (message) => { inputs.push({ sessionId: deps.sessionId, message }); return "accepted" },
      })
    } }),
    sessionViewLoader: { load: (id) => loadSessionView(id, storeReader, storeReader) },
    transcriptCache,
  })
  // The background lane's search over the project's own conversation index.
  const searchIndex = acquireConversationSearchIndex(join(ctx.baseDir, "conversation-search.sqlite"), storeReader)
  const sessionMetadata = createSessionMetadataProjection(storeReader)
  const chatSearch = createTranscriptSearch({ index: searchIndex, source: storeReader, sessions: async () => searchableSessions(sessionsFromProjection(await sessionMetadata.replay())) })
  const sessionEvents = createSessionEventNotices({ sessionStore: ctx.sessionStore, isShown: (sessionId) => supervisor.isShown(sessionId) })
  // The runtime's own environment, so a message between sessions takes the production delivery.
  const runtime = moduleExecutionEnvironment({
    authAdmission: testSessionAuthAdmission(),
    recall: async () => { throw new Error("the lead service does not recall") },
    findChats: (request) => chatSearch.findChats(request),
    sessionEvents, sessionStore: ctx.sessionStore, transcriptCache, supervisor,
    delivery: { manager: ctx.manager, projectionReader, eventWriter: ctx.store },
  })
  let enabled = true
  const selectionListeners = new Set<() => void | Promise<void>>()
  const onSelectionChanged = (listener: () => void | Promise<void>) => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } }
  const publish = (patch: RuntimeUiPatchInput) => { patches.push(patch); return undefined }
  // The closes that the control placement carries out itself while execution is paused.
  const pausedCloseListeners = new Set<Parameters<ControlSessionPorts["onChatClosed"]>[0]>()
  const chatRow = async (sessionId: string) => (await ctx.manager.read(sessionId))?.kind === "chat" ? catalogRow(sessionId, sessionId) : undefined
  const service = createLeadService({
    projectionReader,
    eventWriter: setup.eventWriter ?? ctx.store,
    onStored,
    publish,
    sessionManager: ctx.manager,
    sessionStore: ctx.sessionStore,
    executionEnvironment: () => ({
      openChat: (options) => supervisor.openSessionRuntime(options),
      findChats: (request) => runtime.findChats(request),
      sessionEvents: {
        watch: (watcher, watched, kinds) => { trace.push(`watch ${watched}`); sessionEvents.watch(watcher, watched, kinds) },
        unwatch: (watcher, watched) => { sessionEvents.unwatch(watcher, watched) },
      },
      personEntries: (sessionId, earlierTurns) => supervisor.personEntries(sessionId, earlierTurns),
      forwardPersonEntries: (input) => { trace.push(`forward ${input.targetSessionId}`); return supervisor.forwardPersonEntries(input) },
      sessionRuntime: (sessionId) => supervisor.runtimeState(sessionId),
      createOpenHold: () => supervisor.createOpenHold(),
      onChatClosed: (listener) => supervisor.onChatClosed(listener),
      sessionShown: (sessionId) => supervisor.isShown(sessionId),
      liveAgentCards: (sessionId) => runtime.liveAgentCards(sessionId),
      sendSessionMessage: async (input) => {
        trace.push(`report ${input.fromSessionId} ${input.call}`)
        const outcome = await runtime.sendSessionMessage(input)
        reports.push({ ...input, status: outcome.status })
        return outcome
      },
    }),
    onSelectionChanged,
    enabled: () => enabled,
  })
  const control = createLeadControl({
    ...(setup.control ?? { projectionReader: asAsyncEventReadSurface(ctx.store), eventWriter: ctx.store, onStored }),
    publish,
    onSelectionChanged,
    modules: NO_MODULE_SERVICES,
    enabled: () => enabled,
    // By default the standalone open, which opens the chat's shell in this process as the executor composition does.
    openChat: setup.control?.openChat ?? (async ({ name }) => {
      const sessionId = await supervisor.openSessionRuntime({ name })
      return { sessionId, row: catalogRow(sessionId, name) }
    }),
    chatRow,
    onChatClosed: (listener) => { pausedCloseListeners.add(listener); return () => { pausedCloseListeners.delete(listener) } },
  })
  service.start?.()
  control.start?.()
  /** Opens the lead chat through the control part and answers its id, or null while it opens none. */
  const openLead = async (reason: "launch" | "command" = "launch"): Promise<string | null> => (await control.open(reason))?.sessionId ?? null
  return {
    service, control, openLead, supervisor, sessionEvents, notices, inputs, patches, trace, reports,
    /** A person's close that the control placement carries out while execution is paused: the chat turns inactive
     *  and the control placement tells its listeners. */
    async pausedClose(sessionId: string, tabClose: boolean) {
      await ctx.manager.updateLifecycleState(sessionId, "inactive")
      for (const listener of pausedCloseListeners) listener({ sessionId, tabClose })
    },
    async setEnabled(next: boolean) {
      enabled = next
      for (const listener of selectionListeners) await listener()
    },
    async dispose() {
      await control.dispose()
      await service.dispose()
      sessionEvents.dispose()
      await supervisor.disposeAll()
      await transcriptCache.dispose()
      await searchIndex.dispose()
    },
  }
}
