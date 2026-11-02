import { test } from "node:test"
import { strict as assert } from "node:assert"

import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import { rolesCursor, type RoleAssignmentView, type RuntimeRoleSnapshotResult } from "../../../src/protocol/role-protocol-types.js"
import { createHeldRoles } from "./session-roles.js"
import { backgroundReads } from "../../../src/protocol/client/background-reads.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"
import { runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"
import { spyOn } from "bun:test"

const roles = (effort: string): RoleAssignmentView => ({
  assignments: { chat: { model: "wrong-chat", effort: "low" } },
  serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "gpt-6-astra", effort } },
})

function fakeConnection() {
  const snapshots = new Map<string, RoleAssignmentView>([
    ["child-1", roles("high")],
    ["child-2", roles("medium")],
  ])
  const reads: string[][] = []
  let position = 0
  const connection = fakeRuntimeConnection({ queries: {
    roleSnapshot: async (request) => {
      reads.push([...request.sessionIds])
      return {
        views: request.sessionIds.map((sessionId) => ({ sessionId, view: snapshots.get(sessionId) ?? null })),
        snapshotPosition: position,
      }
    },
  } })
  const patch = (sessionId: string, view: RoleAssignmentView): Extract<FrontendEvent, { type: "patch" }>["patch"] => {
    const prevPosition = position
    position += 1
    return { cursor: rolesCursor(sessionId), position, prevPosition, payload: { kind: "roles.updated", roles: view } }
  }
  return { connection, reads, snapshots, patch }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

test("held child roles follow live patches and reconnect snapshots", async () => {
  const fake = fakeConnection()
  let changes = 0
  let childOne: RoleAssignmentView | undefined
  let childTwo: RoleAssignmentView | undefined
  const held = createHeldRoles({ connection: fake.connection })

  const releaseOne = held.subscribe("child-1", (view) => { childOne = view; changes += 1 })
  const releaseTwo = held.subscribe("child-2", (view) => { childTwo = view; changes += 1 })
  await settle()
  assert.equal(childOne?.serving?.selection?.effort, "high")
  assert.equal(childTwo?.serving?.selection?.effort, "medium")
  assert.deepEqual(fake.reads, [["child-1", "child-2"]])

  held.accept(fake.patch("child-1", roles("medium")))
  assert.equal(childOne?.serving?.selection?.effort, "medium")
  assert.equal(childTwo?.serving?.selection?.effort, "medium")

  fake.snapshots.set("child-1", roles("low"))
  held.refresh()
  await settle()
  assert.equal(childOne?.serving?.selection?.effort, "low")
  assert.deepEqual(fake.reads, [["child-1", "child-2"], ["child-1", "child-2"]])
  assert.equal(changes, 7)

  releaseOne()
  releaseTwo()
  held.dispose()
})

test("obsolete role answers cannot clear a newer failure and released readings ignore late failures", async () => {
  const timers: (() => void)[] = []
  // A real handle, already cleared, stands in for each manually delivered timer.
  const inert = setTimeout(() => {}, 0)
  clearTimeout(inert)
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(globalThis.setTimeout, {
    apply(_target, _receiver, [callback]: Parameters<typeof setTimeout>) { timers.push(() => callback()); return inert },
  }))
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {})
  const fake = fakeConnection()
  const pending: PromiseWithResolvers<RuntimeRoleSnapshotResult>[] = []
  fake.connection.query = runtimeQuery({ roleSnapshot: () => {
    const request = Promise.withResolvers<RuntimeRoleSnapshotResult>()
    pending.push(request)
    return request.promise
  } })
  const held = createHeldRoles({ connection: fake.connection })
  try {
    const release = held.subscribe("child-1", () => {})
    await settle()
    held.refresh()
    pending[1]!.reject(new Error("unavailable"))
    await settle()
    pending[0]!.resolve({ views: [{ sessionId: "child-1", view: roles("old") }], snapshotPosition: 0 })
    await settle()
    assert.equal(held.get("child-1"), undefined)
    assert.equal(backgroundReads(fake.connection).failing, true)
    timers.shift()?.()
    pending[2]!.resolve({ views: [{ sessionId: "child-1", view: roles("recovered") }], snapshotPosition: 1 })
    await settle()
    assert.equal(held.get("child-1")?.serving?.selection?.effort, "recovered")
    assert.equal(backgroundReads(fake.connection).failing, false)
    held.refresh()
    release()
    pending[3]!.reject(new Error("late failure"))
    await settle()
    assert.equal(backgroundReads(fake.connection).failing, false)
  } finally { held.dispose(); clock.mockRestore(); clear.mockRestore() }
})
