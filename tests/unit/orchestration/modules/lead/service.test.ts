import { afterEach, beforeEach, expect, test } from "bun:test"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { createSessionEventNotices } from "../../../../../src/orchestration/app-service/session-event-notices.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { leadModule } from "../../../../../src/orchestration/modules/lead/module.js"
import { createLeadService, type LeadService } from "../../../../../src/orchestration/modules/lead/service.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorWithRunner, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { testDirectories } from "../../../../helpers/directories.js"

let ctx: SupervisorTestContext
let supervisor: RuntimeSupervisor
let disposeAll: (() => Promise<void>)[] = []
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => {
  for (const dispose of disposeAll) await dispose()
  disposeAll = []
  await disposeSupervisorTestContext(ctx)
})

/** A started lead service over the real store, session manager, and session event notices, with a switch for the
 *  module selection. Each notice that a chat's runner receives is recorded by the chat's id. */
function harness(projectionReader = asAsyncEventReadSurface(ctx.store)) {
  const notices: string[] = []
  const patches: RuntimeUiPatchInput[] = []
  supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId, {
    deliverSilentNotice: async () => { notices.push(deps.sessionId); return "delivered" },
  }))
  const sessionEvents = createSessionEventNotices({ sessionStore: ctx.sessionStore })
  let enabled = true
  const selectionListeners = new Set<() => void | Promise<void>>()
  const service = createLeadService({
    projectionReader,
    eventWriter: ctx.store,
    onStored: ctx.store.onStored,
    publish: (patch) => { patches.push(patch); return undefined },
    sessionManager: ctx.manager,
    executionEnvironment: () => ({ openChat: (options) => supervisor.openSessionRuntime(options), sessionEvents }),
    onSelectionChanged: (listener) => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } },
    enabled: () => enabled,
  })
  service.start?.()
  disposeAll.push(async () => { await service.dispose(); sessionEvents.dispose(); await supervisor.disposeAll() })
  return {
    service, sessionEvents, notices, patches,
    async setEnabled(next: boolean) {
      enabled = next
      for (const listener of selectionListeners) await listener()
    },
  }
}

function leadFacts() {
  return ctx.store.read({ aggregateId: "lead" }).map((fact) => ({ type: fact.type, sessionId: fact.sessionId, payload: fact.payload }))
}

async function chatsNamedLead(): Promise<number> {
  return (await ctx.manager.listMetadata()).sessions.filter((row) => row.kind === "chat" && row.name === "Lead").length
}

test("a launch on an empty store opens one chat named Lead and designates it once", async () => {
  const { service } = harness()
  const sessionId = await service.open("launch")
  expect(sessionId).not.toBeNull()
  expect(await chatsNamedLead()).toBe(1)
  expect(leadFacts()).toEqual([{ type: "lead.chat.designated", sessionId: "lead", payload: { sessionId } }])

  expect(await service.open("launch")).toBe(sessionId)
  expect(leadFacts()).toHaveLength(1)
})

test("two launches at the same time leave one chat named Lead, and both answer it", async () => {
  const { service } = harness()
  const [first, second] = await Promise.all([service.open("launch"), service.open("launch")])
  expect(first).not.toBeNull()
  expect(second).toBe(first)
  expect(await chatsNamedLead()).toBe(1)
  expect(leadFacts()).toHaveLength(1)
})

test("a launch and the lead command at the same time on a dismissed lead: the command ends the dismissal", async () => {
  const { service } = harness()
  const sessionId = await service.open("launch")
  if (sessionId === null) throw new Error("expected the lead to open")
  await service.dismiss(sessionId)

  expect(await Promise.all([service.open("launch"), service.open("command")])).toEqual([null, sessionId])
  expect(leadFacts().map((fact) => fact.type)).toEqual(["lead.chat.designated", "lead.chat.dismissed", "lead.chat.designated"])
  expect(await service.view()).toEqual({ leadSessionId: sessionId, dismissed: false, rows: [] })
})

test("dispose settles the startup replay, and nothing is published after it resolves", async () => {
  const reader = asAsyncEventReadSurface(ctx.store)
  const gate = Promise.withResolvers<void>()
  const { service, patches } = harness({ ...reader, capturePosition: async () => { await gate.promise; return reader.capturePosition() } })
  let disposed = false
  const disposing = (async () => { await service.dispose(); disposed = true })()
  await Bun.sleep(1)
  expect(disposed).toBe(false)
  gate.resolve()
  await disposing
  await Bun.sleep(1)
  expect(patches).toEqual([])
})

test("a dismissed lead does not open on launch, and the lead command designates it again", async () => {
  const { service } = harness()
  const sessionId = await service.open("launch")
  expect(sessionId).not.toBeNull()
  expect(await service.dismiss(sessionId!)).toBe(sessionId)
  expect((await service.view()).dismissed).toBe(true)

  expect(await service.open("launch")).toBeNull()
  expect(await service.open("command")).toBe(sessionId)
  expect(leadFacts().map((fact) => fact.type)).toEqual(["lead.chat.designated", "lead.chat.dismissed", "lead.chat.designated"])
  expect(await service.view()).toEqual({ leadSessionId: sessionId, dismissed: false, rows: [] })
})

test("a launch after the lead chat was removed as an empty chat opens and designates a new chat", async () => {
  const { service } = harness()
  const removed = await service.open("launch")
  expect(removed).not.toBeNull()
  await supervisor.closeChat(removed!)
  expect(await ctx.manager.read(removed!)).toBeNull()

  const opened = await service.open("launch")
  expect(opened).not.toBeNull()
  expect(opened).not.toBe(removed)
  expect(leadFacts()).toEqual([
    { type: "lead.chat.designated", sessionId: "lead", payload: { sessionId: removed } },
    { type: "lead.chat.designated", sessionId: "lead", payload: { sessionId: opened } },
  ])
})

test("while the module is off a started chat's report gives no notice, and after it turns on a report gives one", async () => {
  const { service, sessionEvents, notices, setEnabled } = harness()
  const lead = await service.open("launch")
  expect(lead).not.toBeNull()
  await service.journal.append({ type: "lead.chat.started", payload: { sessionId: "c", sourceEntryIds: ["entry-1"] } })
  await supervisor.ensureChatRunner(lead!)

  await setEnabled(false)
  sessionEvents.report("c", "turn_ended")
  await Bun.sleep(1)
  expect(notices).toEqual([])

  await setEnabled(true)
  sessionEvents.report("c", "turn_ended")
  await Bun.sleep(1)
  expect(notices).toEqual([lead!])
})

test("the lead command focuses the lead chat", async () => {
  const { service } = harness()
  const command = leadModule.contributions.find((contribution) => contribution.domain === "commands")
  if (command?.domain !== "commands" || !("execute" in command.value)) throw new Error("expected the lead command")
  const outcome = await command.value.execute({
    session: undefined,
    directories: testDirectories(ctx.baseDir),
    authDirectory: () => ctx.baseDir,
    projectionReader: asAsyncEventReadSurface(ctx.store),
    runOwnedCommand: undefined,
    modules: composeModuleServices([[leadModule.id, service satisfies LeadService]]),
  })
  const { leadSessionId } = await service.view()
  if (leadSessionId === null) throw new Error("expected the command to designate the lead")
  expect(outcome).toEqual({ kind: "focus-session", sessionId: leadSessionId })
})
