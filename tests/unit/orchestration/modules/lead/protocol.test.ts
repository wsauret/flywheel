import { afterEach, beforeEach, expect, test } from "bun:test"
import { composeModuleServices, moduleServiceKey } from "../../../../../src/infra/module-service.js"
import { createLeadChatsProtocol, createLeadControlProtocol } from "../../../../../src/orchestration/modules/lead/protocol.js"
import { EMPTY_LEAD_CHATS, EMPTY_LEAD_VIEW, leadChatsCursor, leadCursor } from "../../../../../src/protocol/modules/lead.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { leadHarness } from "./_lead-harness.js"

let ctx: SupervisorTestContext
let dispose: (() => Promise<void>) | undefined
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  await disposeSupervisorTestContext(ctx)
})

/** The lead's two protocol runtimes over its started service and control part, with a switch for the module selection. */
function protocolHarness() {
  const lead = leadHarness(ctx)
  dispose = lead.dispose
  let enabled = true
  const services = {
    modules: composeModuleServices([["lead", lead.service], [moduleServiceKey("lead", "control"), lead.control]]),
    enabled: () => enabled,
    publish: () => undefined,
    snapshotPosition: () => 7,
  }
  return {
    control: createLeadControlProtocol(services),
    chats: createLeadChatsProtocol(services),
    setEnabled: async (next: boolean) => { enabled = next; await lead.setEnabled(next) },
  }
}

const factCount = () => ctx.store.read({ aggregateId: "lead" }).length
const chatCount = async () => (await ctx.manager.listMetadata()).sessions.length

test("while the module is off, open and dismiss answer no chat, create none, and append nothing", async () => {
  const { control, setEnabled } = protocolHarness()
  await setEnabled(false)
  expect(await control.mutate["lead.open"]({ type: "lead.open", reason: "launch" })).toEqual({ ok: true, sessionId: null })
  expect(await control.mutate["lead.dismiss"]({ type: "lead.dismiss", sessionId: "any" })).toEqual({ ok: true, sessionId: null })
  expect(await chatCount()).toBe(0)
  expect(factCount()).toBe(0)
})

test("lead.open answers the lead chat with its catalog row and whether this open created it", async () => {
  const { control } = protocolHarness()
  const first = await control.mutate["lead.open"]({ type: "lead.open", reason: "launch" })
  if (!first.ok || first.sessionId === null) throw new Error("expected the lead to open")
  expect(first).toMatchObject({ created: true, row: { id: first.sessionId, kind: "chat" } })
  expect(await control.mutate["lead.open"]({ type: "lead.open", reason: "launch" })).toMatchObject({ ok: true, sessionId: first.sessionId, created: false })
})

test("while the module is off both snapshots are empty, and the stored designation reads again when it is on", async () => {
  const { control, chats, setEnabled } = protocolHarness()
  const opened = await control.mutate["lead.open"]({ type: "lead.open", reason: "command" })
  if (!opened.ok || opened.sessionId === null) throw new Error("expected the lead to open")

  await setEnabled(false)
  expect(await control.serve.leadSnapshot({ type: "leadSnapshot" })).toEqual({ snapshotPosition: 7, view: EMPTY_LEAD_VIEW })
  expect(await chats.serve.leadChatsSnapshot({ type: "leadChatsSnapshot" })).toEqual({ snapshotPosition: 7, view: EMPTY_LEAD_CHATS })

  await setEnabled(true)
  expect(await control.serve.leadSnapshot({ type: "leadSnapshot" })).toEqual({ snapshotPosition: 7, view: { leadSessionId: opened.sessionId, dismissed: false } })
  expect(await chats.serve.leadChatsSnapshot({ type: "leadChatsSnapshot" })).toEqual({ snapshotPosition: 7, view: { rows: [] } })
})

test("each snapshot states the position of its own domain", async () => {
  const positions: unknown[] = []
  const services = { modules: composeModuleServices([]), enabled: () => true, publish: () => undefined, snapshotPosition: (scope: unknown) => { positions.push(scope); return 0 } }
  await createLeadControlProtocol(services).serve.leadSnapshot({ type: "leadSnapshot" })
  await createLeadChatsProtocol(services).serve.leadChatsSnapshot({ type: "leadChatsSnapshot" })
  expect(positions).toEqual([{ kind: "cursor", cursor: leadCursor() }, { kind: "cursor", cursor: leadChatsCursor() }])
})
