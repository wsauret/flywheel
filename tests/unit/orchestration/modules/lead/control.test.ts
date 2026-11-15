import { afterEach, beforeEach, expect, test } from "bun:test"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { leadCursor } from "../../../../../src/protocol/modules/lead.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { leadHarness } from "./_lead-harness.js"

let ctx: SupervisorTestContext
let supervisor: RuntimeSupervisor
let disposeAll: (() => Promise<void>)[] = []
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => {
  for (const dispose of disposeAll) await dispose()
  disposeAll = []
  await disposeSupervisorTestContext(ctx)
})

function harness() {
  const lead = leadHarness(ctx)
  supervisor = lead.supervisor
  disposeAll.push(lead.dispose)
  return lead
}

/** The designation facts. The list's joins, such as the lead chat's own join at its creation, are the service's. */
function leadFacts() {
  return ctx.store.read({ aggregateId: "lead" })
    .filter((fact) => fact.type === "lead.chat.designated" || fact.type === "lead.chat.dismissed")
    .map((fact) => ({ type: fact.type, sessionId: fact.sessionId, payload: fact.payload }))
}

async function chatsNamedLead(): Promise<readonly { readonly id: string; readonly userNamed?: true }[]> {
  return (await ctx.manager.listMetadata()).sessions.filter((row) => row.kind === "chat" && row.name === "Lead")
}

test("a launch on an empty store opens one chat named Lead, answers its row, and designates it once", async () => {
  const { control, patches } = harness()
  const opening = await control.open("launch")
  if (opening === null) throw new Error("expected the lead to open")
  expect(opening).toMatchObject({ created: true, row: { id: opening.sessionId } })
  expect(await chatsNamedLead()).toEqual([expect.objectContaining({ id: opening.sessionId })])
  expect(leadFacts()).toEqual([{ type: "lead.chat.designated", sessionId: "lead", payload: { sessionId: opening.sessionId } }])
  expect(patches.filter((patch) => patch.cursor.domain === leadCursor().domain).at(-1)?.payload).toEqual({ kind: "lead.changed", leadSessionId: opening.sessionId, dismissed: false })

  expect(await control.open("launch")).toMatchObject({ sessionId: opening.sessionId, created: false })
  expect(leadFacts()).toHaveLength(1)
})

test("two launches at the same time leave one chat named Lead, and both answer it", async () => {
  const { openLead } = harness()
  const [first, second] = await Promise.all([openLead("launch"), openLead("launch")])
  expect(first).not.toBeNull()
  expect(second).toBe(first)
  expect(await chatsNamedLead()).toHaveLength(1)
  expect(leadFacts()).toHaveLength(1)
})

test("a launch and the lead command at the same time on a dismissed lead: the command ends the dismissal", async () => {
  const { control, openLead } = harness()
  const sessionId = await openLead("launch")
  if (sessionId === null) throw new Error("expected the lead to open")
  await control.dismiss(sessionId)

  expect(await Promise.all([openLead("launch"), openLead("command")])).toEqual([null, sessionId])
  expect(leadFacts().map((fact) => fact.type)).toEqual(["lead.chat.designated", "lead.chat.dismissed", "lead.chat.designated"])
  expect(await control.view()).toEqual({ leadSessionId: sessionId, dismissed: false })
})

test("a dismissed lead does not open on launch, and the lead command designates it again", async () => {
  const { control, openLead } = harness()
  const sessionId = await openLead("launch")
  if (sessionId === null) throw new Error("expected the lead to open")
  expect(await control.dismiss(sessionId)).toBe(sessionId)
  expect((await control.view()).dismissed).toBe(true)

  expect(await openLead("launch")).toBeNull()
  expect(await openLead("command")).toBe(sessionId)
  expect(leadFacts().map((fact) => fact.type)).toEqual(["lead.chat.designated", "lead.chat.dismissed", "lead.chat.designated"])
  expect(await control.view()).toEqual({ leadSessionId: sessionId, dismissed: false })
})

test("a launch after the person deleted the lead chat opens and designates a new chat", async () => {
  const { openLead } = harness()
  const removed = await openLead("launch")
  if (removed === null) throw new Error("expected the lead to open")
  await supervisor.deleteSession(removed)
  expect(await ctx.manager.read(removed)).toBeNull()

  const opened = await openLead("launch")
  expect(opened).not.toBeNull()
  expect(opened).not.toBe(removed)
  expect(leadFacts()).toEqual([
    { type: "lead.chat.designated", sessionId: "lead", payload: { sessionId: removed } },
    { type: "lead.chat.designated", sessionId: "lead", payload: { sessionId: opened } },
  ])
})

test("while the module is off the control part opens no chat and serves the empty designation", async () => {
  const { control, setEnabled } = harness()
  await setEnabled(false)
  expect(await control.open("launch")).toBeNull()
  expect(await control.view()).toEqual({ leadSessionId: null, dismissed: false })
  expect(leadFacts()).toEqual([])
  expect(await chatsNamedLead()).toEqual([])
})

test("a person's close that the control placement carries out while execution is paused removes the chat from the list, and a paused tab close does so only while no lead shows", async () => {
  const { control, openLead, pausedClose, service } = harness()
  const leadId = await openLead("launch")
  if (leadId === null) throw new Error("expected the lead to open")
  const closed = await supervisor.openSessionRuntime()
  const tab = await supervisor.openSessionRuntime()
  await settle(() => service.journal.state().members.has(closed) && service.journal.state().members.has(tab))
  const closes = () => ctx.store.read({ aggregateId: "lead" }).flatMap((fact) => fact.type === "lead.chat.closed" ? [fact.payload] : [])

  // The lead holds every listed chat, so a tab close while it shows returns the chat to the list.
  await pausedClose(tab, true)
  await pausedClose(closed, false)
  await settle(() => !service.journal.state().members.has(closed))
  expect(closes()).toEqual([{ sessionId: closed }])
  expect(service.journal.state().members.has(tab)).toBe(true)

  await control.dismiss(leadId)
  await pausedClose(tab, true)
  await settle(() => !service.journal.state().members.has(tab))
  expect(closes()).toEqual([{ sessionId: closed }, { sessionId: tab }])
})

async function settle(until: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !until(); attempt += 1) await Bun.sleep(5)
}
