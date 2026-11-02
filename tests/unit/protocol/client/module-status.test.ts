import { describe, expect, it } from "bun:test"
import { RuntimeLaneLost, RuntimeSilent } from "../../../../src/protocol/client/connection-failures.js"
import { readModuleStatusRows, sameModuleStatusScope } from "../../../../src/protocol/client/module-status.js"
import { RuntimeCallTimeout } from "../../../../src/protocol/runtime-client-deadlines.js"
import type { ModuleRow } from "../../../../src/protocol/protocol-module.js"

const scope = { sessionId: "chat", profileId: "personal", moduleIds: ["first", "broken", "last"] }
const rows = (id: string): readonly ModuleRow[] => [{ id, label: id, value: "ready" }]

describe("module status collection", () => {
  it("keeps registry order and reports a failed contribution once", async () => {
    const first = Promise.withResolvers<readonly ModuleRow[]>()
    const failures: string[] = []
    const pending = readModuleStatusRows([{ id: "first" }, { id: "broken" }, { id: "last" }, { id: "disabled" }], scope, (module) => {
      if (module.id === "first") return first.promise
      if (module.id === "broken") throw new Error("reading failed")
      return Promise.resolve(rows(module.id))
    }, (module) => { failures.push(module.id) }, () => true)
    first.resolve(rows("first"))
    expect(await pending).toEqual([...rows("first"), ...rows("last")])
    expect(failures).toEqual(["broken"])
  })

  it("reports no failure that the runtime's own state explains, so Status adds nothing to the fault notice", async () => {
    // A read that timed out while the runtime does not answer, and a read
    // its lane took down, are the connection's to report: its fault notice
    // already says why. Only a module that failed while the runtime answers
    // has a failure of its own to report.
    const failures: string[] = []
    const read = (module: { readonly id: string }) => Promise.reject(module.id === "first" ? new RuntimeLaneLost(new Error("lane ended")) : RuntimeCallTimeout.forDeadline(5_000))
    let answering = false
    const modules = [{ id: "first" }, { id: "broken" }]
    expect(await readModuleStatusRows(modules, scope, read, (module) => { failures.push(module.id) }, () => answering)).toEqual([])
    expect(failures).toEqual([])
    answering = true
    await readModuleStatusRows(modules, scope, read, (module) => { failures.push(module.id) }, () => answering)
    expect(failures).toEqual(["broken"])
    // A read that timed out while the lane heard nothing from the runtime is
    // the connection's silence, even before the lane is known dead.
    failures.length = 0
    await readModuleStatusRows(modules, scope, () => Promise.reject(new RuntimeSilent(RuntimeCallTimeout.forDeadline(5_000))), (module) => { failures.push(module.id) }, () => true)
    expect(failures).toEqual([])
  })

  it("invalidates a reading for another session, profile, or enabled selection", () => {
    expect(sameModuleStatusScope(scope, { ...scope, moduleIds: [...scope.moduleIds] })).toBe(true)
    expect(sameModuleStatusScope(scope, { ...scope, sessionId: "other" })).toBe(false)
    expect(sameModuleStatusScope(scope, { ...scope, profileId: "work" })).toBe(false)
    expect(sameModuleStatusScope(scope, { ...scope, moduleIds: [] })).toBe(false)
  })
})
