import assert from "node:assert/strict"
import { test } from "node:test"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { ModuleProtocolRow } from "../../../src/protocol/module-protocol-types.js"
import { readWorkspaceSettings } from "./session-settings.js"
import { createSeatReading } from "./session-seat.js"
import { backgroundReads } from "../../../src/protocol/client/background-reads.js"
import type { RoleAssignmentView } from "../../../src/protocol/role-protocol-types.js"
import type { RuntimeQuery } from "../../../src/protocol/app-service-types.js"
import type { EffortOptionRow, ModelSelectionEffort } from "../../../src/protocol/model-assignment-protocol-types.js"
import { configView, modulesView } from "../../../tests/helpers/runtime-views.js"
import { authView } from "./session-connection-fixture.js"
import { runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

const binary = { control: "binary", label: "Switch", description: "A switch" } as const

function connection(modules: readonly ModuleProtocolRow[], idleCompaction = true, autoDeleteSessionDays = 0): Pick<RuntimeConnection, "query"> {
  const capabilities = { ...modulesView(), modules }
  const config = configView({ idleCompaction, autoDeleteSessionDays, proactiveCompactionThreshold: 80 })
  // The three reads readWorkspaceSettings makes.
  return { query: runtimeQuery({
    moduleSnapshot: async () => ({ snapshotPosition: 0, capabilities }),
    configSnapshot: async () => ({ snapshotPosition: 0, config }),
    authStatusSnapshot: async () => ({ snapshotPosition: 0, auth: authView([]) }),
  }) }
}

test("the capability count reads only the installed modules that have a switch", async () => {
  const settings = await readWorkspaceSettings(connection([
    { id: "bash", installed: true, effective: true, dependencies: [], setting: binary },
    { id: "skills", installed: true, effective: false, dependencies: [], setting: binary },
    { id: "workflows", installed: true, effective: true, dependencies: [], setting: { control: "workflow-mode", label: "Workflows", description: "Workflows" } },
    { id: "development", installed: false, effective: false, dependencies: [] },
  ]))
  assert.equal(settings.capabilitiesOn, 2)
  assert.equal(settings.capabilitiesTotal, 3)
})

test("idle compaction reads the runtime's enabled value and opt-out", async () => {
  for (const enabled of [true, false]) {
    const settings = await readWorkspaceSettings(connection([], enabled))
    assert.equal(settings.idleCompaction, enabled)
  }
})

test("automatic deletion reads the runtime's off and whole-day settings", async () => {
  for (const days of [0, 14]) {
    const settings = await readWorkspaceSettings(connection([], true, days))
    assert.equal(settings.autoDeleteSessionDays, days)
  }
})

test("a seat hidden before its read fails stays stale without a background notice", async () => {
  const request = Promise.withResolvers<never>()
  const link: Pick<RuntimeConnection, "query"> = { query: () => request.promise }
  const seat = createSeatReading({ connection: link, sessionId: "chat", slot: () => ({ kind: "role", roleId: "chat" }), changed() {} })
  try {
    seat.show(true)
    seat.show(false)
    request.reject(new Error("late failure"))
    for (let index = 0; index < 8; index++) await Promise.resolve()
    assert.equal(backgroundReads(link).failing, false)
  } finally { seat.dispose() }
})

test("the shown agent seat follows published selection, keeps its model's effort stops through a re-read, and keeps its session-local picker target", async () => {
  let view: RoleAssignmentView = {
    assignments: { chat: { model: "wrong-chat", effort: "low" } },
    serving: { slot: { kind: "role", roleId: "brief.build.at.worker" }, selection: { model: "worker-model", effort: "high" } },
  }
  let notify: ((next: RoleAssignmentView | undefined) => void) | undefined
  const reads: { readonly request: RuntimeQuery; readonly answer: PromiseWithResolvers<readonly EffortOptionRow[]> }[] = []
  const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
  const efforts: readonly ModelSelectionEffort[] = ["medium", "high"]
  const stops = (current: ModelSelectionEffort): EffortOptionRow[] => efforts.map((effort) => ({ slot: { kind: "role", roleId: "brief.build.at.worker" }, effort, label: effort, current: effort === current, selectable: true }))
  // This owner reads only effort options after receiving a serving publication.
  const link: Pick<RuntimeConnection, "query"> = { query: runtimeQuery({ effortOptions: (request) => {
    const answer = Promise.withResolvers<readonly EffortOptionRow[]>()
    reads.push({ request, answer })
    return answer.promise
  } }) }
  let changes = 0
  const seat = createSeatReading({
    connection: link, sessionId: "worker", slot: () => ({ kind: "role", roleId: "chat" }), changed() { changes++ },
    roles: { get: () => view, subscribe: (_id, listener) => { notify = listener; listener(view); return () => { notify = undefined } } },
  })
  try {
    seat.show(true)
    assert.deepEqual(seat.activeModel, view.serving?.selection)
    assert.equal(seat.seat.seatSlot.roleId, "brief.build.at.worker")
    assert.equal(seat.seat.seatSessionId, "worker")
    view = { ...view, serving: { ...view.serving!, selection: { model: "edited-model", effort: "medium" } } }
    notify?.(view)
    assert.deepEqual(seat.activeModel, view.serving?.selection)
    assert.deepEqual(reads.at(-1)?.request, { type: "effortOptions", scope: { kind: "session", sessionId: "worker" }, slot: view.serving?.slot, model: "edited-model" })
    reads.at(-1)?.answer.resolve(stops("medium"))
    await settle()
    assert.equal(seat.seat.seatModel, "edited-model")
    const options = seat.seat.seatEfforts
    assert.equal(options.length, 2)

    view = { ...view, serving: { ...view.serving!, selection: { model: "edited-model", effort: "high" } } }
    const before = changes
    notify?.(view)
    assert.equal(changes, before + 1, "the new selection publishes before its read returns")
    assert.equal(seat.seat.seatEffort, "high")
    assert.equal(seat.seat.seatEfforts, options, "the same model keeps its stops while the read runs")
    reads.at(-1)?.answer.resolve(stops("high"))
    await settle()
    assert.deepEqual(seat.seat.seatEfforts.map((entry) => entry.current), [false, true])

    seat.show(false)
    const count = reads.length
    view = { ...view, serving: { ...view.serving!, selection: { model: "hidden-edit", effort: "low" } } }
    notify?.(view)
    assert.equal(reads.length, count)
    seat.show(true)
    assert.deepEqual(seat.activeModel, view.serving?.selection)
    assert.deepEqual(seat.seat.seatEfforts, [], "another model's stops are not shown for it")
  } finally { seat.dispose() }
  assert.equal(notify, undefined)
})
