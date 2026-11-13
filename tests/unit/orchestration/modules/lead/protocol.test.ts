import { afterEach, beforeEach, expect, test } from "bun:test"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { createLeadProtocol } from "../../../../../src/orchestration/modules/lead/protocol.js"
import { EMPTY_LEAD_VIEW, leadCursor } from "../../../../../src/protocol/modules/lead.js"
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

/** The lead's protocol runtime over its started service, with a switch for the module selection. */
function protocolHarness() {
  const lead = leadHarness(ctx)
  dispose = lead.dispose
  let enabled = true
  const protocol = createLeadProtocol({
    modules: composeModuleServices([["lead", lead.service]]),
    enabled: () => enabled,
    snapshotPosition: (scope) => {
      expect(scope).toEqual({ kind: "cursor", cursor: leadCursor() })
      return 7
    },
  })
  return { protocol, setEnabled: async (next: boolean) => { enabled = next; await lead.setEnabled(next) } }
}

const factCount = () => ctx.store.read({ aggregateId: "lead" }).length
const chatCount = async () => (await ctx.manager.listMetadata()).sessions.length

test("while the module is off, open and dismiss answer no chat, create none, and append nothing", async () => {
  const { protocol, setEnabled } = protocolHarness()
  await setEnabled(false)
  expect(await protocol.mutate["lead.open"]({ type: "lead.open", reason: "launch" })).toEqual({ ok: true, sessionId: null })
  expect(await protocol.mutate["lead.dismiss"]({ type: "lead.dismiss", sessionId: "any" })).toEqual({ ok: true, sessionId: null })
  expect(await chatCount()).toBe(0)
  expect(factCount()).toBe(0)
})

test("while the module is off the snapshot is the empty view, and the stored designation reads again when it is on", async () => {
  const { protocol, setEnabled } = protocolHarness()
  const opened = await protocol.mutate["lead.open"]({ type: "lead.open", reason: "command" })
  if (!opened.ok || opened.sessionId === null) throw new Error("expected the lead to open")

  await setEnabled(false)
  expect(await protocol.serve.leadSnapshot({ type: "leadSnapshot" })).toEqual({ snapshotPosition: 7, view: EMPTY_LEAD_VIEW })

  await setEnabled(true)
  expect(await protocol.serve.leadSnapshot({ type: "leadSnapshot" })).toEqual({ snapshotPosition: 7, view: { leadSessionId: opened.sessionId, dismissed: false, rows: [] } })
})
