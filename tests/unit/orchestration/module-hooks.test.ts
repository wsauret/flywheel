import { describe, expect, it } from "bun:test"
import { ModuleGateRefusal, runModuleGate } from "../../../src/orchestration/module-hooks.js"

describe("runModuleGate", () => {
  it("executes core exactly once when the gate allows", async () => {
    let calls = 0
    const result = await runModuleGate(() => ({ kind: "allow" }), {}, {}, async () => ++calls)
    expect(result).toBe(1)
    expect(calls).toBe(1)
  })

  it("preserves veto, replacement, and fail-closed behavior", async () => {
    expect(await runModuleGate(() => ({ kind: "veto", reason: "no" }), {}, {}, async () => 1)).toEqual({ kind: "veto", reason: "no" })
    expect(await runModuleGate(() => ({ kind: "replace", execute: async () => 2 }), {}, {}, async () => 1)).toBe(2)
    expect(runModuleGate(() => { throw new Error("broken") }, {}, {}, async () => 1)).rejects.toBeInstanceOf(ModuleGateRefusal)
  })
})
