import { asAsyncEventReadSurface, type AsyncEventStateReadSurface } from "../../../../../src/infra/event-store-types.js"
import { createSessionEventNotices } from "../../../../../src/orchestration/app-service/session-event-notices.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { createLeadService } from "../../../../../src/orchestration/modules/lead/service.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { mockRunner, supervisorWithRunner, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"

/** A started lead service over the real store, session manager, supervisor, and session event notices, with a switch
 *  for the module selection. Each notice that a chat's runner receives is recorded by the chat's id, and `trace` records
 *  each watch and each forward in order. A runner starts once `runnerStartup` resolves, so every message that lands
 *  before then commits as the chat's entry. `dispose` ends the service, the notices, and the supervisor. */
export function leadHarness(ctx: SupervisorTestContext, setup: { readonly projectionReader?: AsyncEventStateReadSurface; readonly runnerStartup?: Promise<void> } = {}) {
  const projectionReader = setup.projectionReader ?? asAsyncEventReadSurface(ctx.store)
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
  const service = createLeadService({
    projectionReader,
    eventWriter: ctx.store,
    onStored: ctx.store.onStored,
    publish: (patch) => { patches.push(patch); return undefined },
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
    }),
    onSelectionChanged: (listener) => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } },
    enabled: () => enabled,
  })
  service.start?.()
  return {
    service, supervisor, sessionEvents, notices, patches, trace,
    async setEnabled(next: boolean) {
      enabled = next
      for (const listener of selectionListeners) await listener()
    },
    async dispose() {
      await service.dispose()
      sessionEvents.dispose()
      await supervisor.disposeAll()
    },
  }
}
