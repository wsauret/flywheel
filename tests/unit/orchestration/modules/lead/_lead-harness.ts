import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type AsyncEventWriter, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import { NO_MODULE_SERVICES } from "../../../../../src/infra/module-service.js"
import { EventReaderService } from "../../../../../src/infra/event-store-effect.js"
import { createSessionEventNotices } from "../../../../../src/orchestration/app-service/session-event-notices.js"
import { moduleExecutionEnvironment } from "../../../../../src/orchestration/app-service/module-execution-environment.js"
import type { ControlSessionPorts } from "../../../../../src/orchestration/app-service/module-service-host.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { createTranscriptProjectionCache } from "../../../../../src/orchestration/app-service/transcript-projection-cache.js"
import { createRuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor.js"
import { tryOpenConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { loadSessionView } from "../../../../../src/orchestration/session-store/view.js"
import { createConversationTreeWriterController } from "../../../../../src/orchestration/chat/tree-writer.js"
import { createLeadControl } from "../../../../../src/orchestration/modules/lead/control.js"
import { createLeadService } from "../../../../../src/orchestration/modules/lead/service.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { mockRunner, supervisorBaseDeps, supervisorConversationFixture, testSessionAuthAdmission, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
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
 *  entry. `eventWriter`, by default the store, is the service's own writer. `answered`, when set, holds the answer of each
 *  message that the service posts between sessions until it resolves. `schedule`, when set, is the service's clock for its
 *  batches of updates. `dispose` ends the service, the control part, the notices, and the supervisor. */
export function leadHarness(ctx: SupervisorTestContext, setup: { readonly projectionReader?: AsyncEventStateReadSurface; readonly onStored?: ControlConnection["onStored"]; readonly runnerStartup?: Promise<void>; readonly eventWriter?: AsyncEventWriter; readonly answered?: () => Promise<void>; readonly schedule?: (run: () => void, ms: number) => () => void; readonly control?: ControlConnection & { readonly openChat?: ControlSessionPorts["openChat"] } } = {}) {
  const projectionReader = setup.projectionReader ?? asAsyncEventReadSurface(ctx.store)
  const onStored = setup.onStored ?? ctx.store.onStored
  const notices: string[] = []
  // Each input that a chat's runner took while attached, as its turn starts on it.
  const inputs: { readonly sessionId: string; readonly message: unknown }[] = []
  const trace: string[] = []
  // The target of each forward with the lead role that the service held for it as the forward began.
  const forwardRoles: string[] = []
  // Each message that the service posted between sessions, with how the runtime's delivery answered it.
  const reports: { readonly fromSessionId: string; readonly toSessionId: string; readonly call: string; readonly text: string; readonly status: string }[] = []
  const patches: RuntimeUiPatchInput[] = []
  // Each chat whose profile the service reported changed, with the lead role that the service held for it then.
  const profileChanges: string[] = []
  const storeReader = asAsyncEventReadSurface(ctx.store)
  const transcriptCache = createTranscriptProjectionCache({ sessionStore: ctx.sessionStore, reader: storeReader, projectionReader: storeReader, projectRoot: ctx.baseDir })
  // It opens a closed chat again, as the executor does.
  const supervisor: RuntimeSupervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => {
      await setup.runnerStartup
      return mockRunner(deps.sessionId, {
        deliverSilentNotice: async () => { notices.push(deps.sessionId); return "delivered" },
        send: async (message) => { inputs.push({ sessionId: deps.sessionId, message }); return "accepted" },
        // An idle runner commits a message from another session through its conversation's writer, under the key of
        // its held cell, as a live runner does; it starts no turn here.
        deliverHeldMessage: async (message, decide) => {
          const outcome = decide("idle")
          const session = await ctx.manager.read(deps.sessionId)
          if (outcome.status === "refused" || session?.kind !== "chat") return outcome
          const writer = createConversationTreeWriterController({ sessionId: deps.sessionId, conversationId: session.conversationId, projectRoot: ctx.baseDir, store: storeReader, projectionReader: storeReader, writer: ctx.store })
          try {
            await writer.commitHeldMessage(message)
          } finally {
            await writer.dispose()
          }
          return outcome
        },
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
    // The reader with which the supervisor registers each attached runner's live control, as production delivers with one reader.
    delivery: { manager: ctx.manager, projectionReader: ctx.runtime.runSync(EventReaderService), eventWriter: ctx.store },
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
    chatProfileChanged: (sessionId) => { profileChanges.push(`${sessionId} ${service.role(sessionId) ?? "none"}`) },
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
      forwardPersonEntries: (input) => {
        trace.push(`forward ${input.targetSessionId}`)
        forwardRoles.push(`${input.targetSessionId} ${service.role(input.targetSessionId) ?? "none"}`)
        return supervisor.forwardPersonEntries(input)
      },
      sessionRuntime: (sessionId) => supervisor.runtimeState(sessionId),
      createOpenHold: () => supervisor.createOpenHold(),
      onChatClosed: (listener) => supervisor.onChatClosed(listener),
      onSessionReleased: (listener) => supervisor.onSessionReleased(listener),
      sessionShown: (sessionId) => supervisor.isShown(sessionId),
      liveAgentCards: (sessionId) => runtime.liveAgentCards(sessionId),
      sendSessionMessage: async (input) => {
        trace.push(`report ${input.fromSessionId} ${input.call}`)
        const outcome = await runtime.sendSessionMessage(input)
        reports.push({ ...input, status: outcome.status })
        await setup.answered?.()
        return outcome
      },
    }),
    onSelectionChanged,
    enabled: () => enabled,
    ...(setup.schedule ? { schedule: setup.schedule } : {}),
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
    service, control, openLead, supervisor, sessionEvents, notices, inputs, patches, trace, forwardRoles, reports, profileChanges,
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

/** The append of one final assistant message of `sessionId`, which the store broadcasts at once. */
export async function finalMessage(ctx: SupervisorTestContext, sessionId: string, id: string, text: string) {
  const conversationId = await supervisorConversationFixture(() => ctx).chatConversationId(sessionId)
  return () => ctx.store.append({
    aggregateId: `conversation:${conversationId}`, type: "chat.entries.appended", version: 7, timestamp: Date.now(), actor: "flywheel", sessionId,
    payload: { conversationId, entries: [{ kind: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { kind: "assistant", content: [{ type: "text", text }] } }] },
  })
}

/** The append of one assistant message of `sessionId` that writes `text` and calls a tool, as a turn does between its
 *  calls, which the store broadcasts at once. */
export async function interimMessage(ctx: SupervisorTestContext, sessionId: string, id: string, text: string) {
  const conversationId = await supervisorConversationFixture(() => ctx).chatConversationId(sessionId)
  return await ctx.store.append({
    aggregateId: `conversation:${conversationId}`, type: "chat.entries.appended", version: 7, timestamp: Date.now(), actor: "flywheel", sessionId,
    payload: { conversationId, entries: [{ kind: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { kind: "assistant", content: [{ type: "text", text }, { type: "tool_use", id: `call-${id}`, name: "read", input: { path: "a.ts" } }] } }] },
  })
}

/** A clock for the service's batches that runs each scheduled task only when the test fires it. */
export function manualSchedule() {
  const tasks: { readonly run: () => void; readonly ms: number; cancelled: boolean }[] = []
  return {
    schedule: (run: () => void, ms: number) => {
      const task = { run, ms, cancelled: false }
      tasks.push(task)
      return () => { task.cancelled = true }
    },
    /** The delay of each task that waits now. */
    due: () => tasks.filter((task) => !task.cancelled).map((task) => task.ms),
    /** Runs every task that waits now. */
    fire: () => { for (const task of tasks.splice(0)) if (!task.cancelled) task.run() },
  }
}

/** Waits until `until` holds, for one second at most. */
export async function settle(until: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200 && !await until(); attempt += 1) await Bun.sleep(5)
}

/** The entries of a chat's conversation under `key`, as its branch holds them. */
export async function committedEntries(ctx: SupervisorTestContext, sessionId: string, key: string): Promise<readonly unknown[]> {
  const conversationId = await supervisorConversationFixture(() => ctx).chatConversationId(sessionId)
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
  if (!tree) return []
  try {
    return (await tree.getBranch()).filter((entry) => entry.id === key)
  } finally {
    await tree.getStorage().dispose()
  }
}
