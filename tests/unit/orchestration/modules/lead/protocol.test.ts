import { afterEach, beforeEach, expect, test } from "bun:test"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { createSessionEventNotices } from "../../../../../src/orchestration/app-service/session-event-notices.js"
import { createLeadProtocol } from "../../../../../src/orchestration/modules/lead/protocol.js"
import { createLeadService } from "../../../../../src/orchestration/modules/lead/service.js"
import { EMPTY_LEAD_VIEW, leadCursor } from "../../../../../src/protocol/modules/lead.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorWithRunner, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
let dispose: (() => Promise<void>) | undefined
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  await disposeSupervisorTestContext(ctx)
})

/** The lead's protocol runtime over its started service, with a switch for the module selection. */
function protocolHarness() {
  const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
  const sessionEvents = createSessionEventNotices({ sessionStore: ctx.sessionStore })
  let enabled = true
  const service = createLeadService({
    projectionReader: asAsyncEventReadSurface(ctx.store),
    eventWriter: ctx.store,
    onStored: ctx.store.onStored,
    publish: () => undefined,
    sessionManager: ctx.manager,
    executionEnvironment: () => ({ openChat: (options) => supervisor.openSessionRuntime(options), sessionEvents }),
    onSelectionChanged: () => () => {},
    enabled: () => enabled,
  })
  service.start?.()
  dispose = async () => { await service.dispose(); sessionEvents.dispose(); await supervisor.disposeAll() }
  const protocol = createLeadProtocol({
    modules: composeModuleServices([["lead", service]]),
    enabled: () => enabled,
    snapshotPosition: (scope) => {
      expect(scope).toEqual({ kind: "cursor", cursor: leadCursor() })
      return 7
    },
  })
  return { protocol, setEnabled: (next: boolean) => { enabled = next } }
}

const factCount = () => ctx.store.read({ aggregateId: "lead" }).length
const chatCount = async () => (await ctx.manager.listMetadata()).sessions.length

test("while the module is off, open and dismiss answer no chat, create none, and append nothing", async () => {
  const { protocol, setEnabled } = protocolHarness()
  setEnabled(false)
  expect(await protocol.mutate["lead.open"]({ type: "lead.open", reason: "launch" })).toEqual({ ok: true, sessionId: null })
  expect(await protocol.mutate["lead.dismiss"]({ type: "lead.dismiss", sessionId: "any" })).toEqual({ ok: true, sessionId: null })
  expect(await chatCount()).toBe(0)
  expect(factCount()).toBe(0)
})

test("while the module is off the snapshot is the empty view, and the stored designation reads again when it is on", async () => {
  const { protocol, setEnabled } = protocolHarness()
  const opened = await protocol.mutate["lead.open"]({ type: "lead.open", reason: "command" })
  if (!opened.ok || opened.sessionId === null) throw new Error("expected the lead to open")

  setEnabled(false)
  expect(await protocol.serve.leadSnapshot({ type: "leadSnapshot" })).toEqual({ snapshotPosition: 7, view: EMPTY_LEAD_VIEW })

  setEnabled(true)
  expect(await protocol.serve.leadSnapshot({ type: "leadSnapshot" })).toEqual({ snapshotPosition: 7, view: { leadSessionId: opened.sessionId, dismissed: false, rows: [] } })
})
