import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type AsyncEventWriter, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import { NO_MODULE_SERVICES } from "../../../../../src/infra/module-service.js"
import { createSessionEventNotices } from "../../../../../src/orchestration/app-service/session-event-notices.js"
import type { ControlSessionPorts } from "../../../../../src/orchestration/app-service/module-service-host.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { createLeadControl } from "../../../../../src/orchestration/modules/lead/control.js"
import { createLeadService } from "../../../../../src/orchestration/modules/lead/service.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { mockRunner, supervisorWithRunner, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { catalogRow } from "../../../../helpers/session-catalog.js"

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
 *  entry. `dispose` ends the service, the control part, the notices, and the supervisor. */
export function leadHarness(ctx: SupervisorTestContext, setup: { readonly projectionReader?: AsyncEventStateReadSurface; readonly onStored?: ControlConnection["onStored"]; readonly runnerStartup?: Promise<void>; readonly control?: ControlConnection & { readonly openChat?: ControlSessionPorts["openChat"] } } = {}) {
  const projectionReader = setup.projectionReader ?? asAsyncEventReadSurface(ctx.store)
  const onStored = setup.onStored ?? ctx.store.onStored
  const notices: string[] = []
  const trace: string[] = []
  const patches: RuntimeUiPatchInput[] = []
  const supervisor: RuntimeSupervisor = supervisorWithRunner(ctx, async (deps) => {
    await setup.runnerStartup
    return mockRunner(deps.sessionId, { deliverSilentNotice: async () => { notices.push(deps.sessionId); return "delivered" } })
  })
  const sessionEvents = createSessionEventNotices({ sessionStore: ctx.sessionStore })
  let enabled = true
  const selectionListeners = new Set<() => void | Promise<void>>()
  const onSelectionChanged = (listener: () => void | Promise<void>) => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } }
  const publish = (patch: RuntimeUiPatchInput) => { patches.push(patch); return undefined }
  const chatRow = async (sessionId: string) => (await ctx.manager.read(sessionId))?.kind === "chat" ? catalogRow(sessionId, sessionId) : undefined
  const service = createLeadService({
    projectionReader,
    eventWriter: ctx.store,
    onStored,
    publish,
    sessionManager: ctx.manager,
    sessionStore: ctx.sessionStore,
    executionEnvironment: () => ({
      openChat: (options) => supervisor.openSessionRuntime(options),
      sessionEvents: {
        watch: (watcher, watched) => { trace.push(`watch ${watched}`); sessionEvents.watch(watcher, watched) },
        unwatch: (watcher, watched) => { sessionEvents.unwatch(watcher, watched) },
      },
      personEntries: (sessionId, earlierTurns) => supervisor.personEntries(sessionId, earlierTurns),
      forwardPersonEntries: (input) => { trace.push(`forward ${input.targetSessionId}`); return supervisor.forwardPersonEntries(input) },
      sessionRuntime: (sessionId) => supervisor.runtimeState(sessionId),
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
  })
  service.start?.()
  control.start?.()
  /** Opens the lead chat through the control part and answers its id, or null while it opens none. */
  const openLead = async (reason: "launch" | "command" = "launch"): Promise<string | null> => (await control.open(reason))?.sessionId ?? null
  return {
    service, control, openLead, supervisor, sessionEvents, notices, patches, trace,
    async setEnabled(next: boolean) {
      enabled = next
      for (const listener of selectionListeners) await listener()
    },
    async dispose() {
      await control.dispose()
      await service.dispose()
      sessionEvents.dispose()
      await supervisor.disposeAll()
    },
  }
}
