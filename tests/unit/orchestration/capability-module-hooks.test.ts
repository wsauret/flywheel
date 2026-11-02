import { describe, expect, test } from "bun:test"

import { runModuleObserverHooks, runModuleTransformerChain } from "../../../src/orchestration/module-hooks.js"

describe("runModuleObserverHooks", () => {
  test("fans raw events in order, isolates failures, and ignores returns", () => {
    const calls: string[] = []
    const event = { type: "turn.completed" as const }

    expect(runModuleObserverHooks([
      { id: "first", observe: (received) => { calls.push(`first:${received.type}`); return false } },
      { id: "middle", observe: () => { calls.push("middle"); throw new Error("observer failed") } },
      { id: "last", observe: (received) => { calls.push(`last:${received.type}`); return "control" } },
    ], event)).toBeUndefined()

    expect(calls).toEqual(["first:turn.completed", "middle", "last:turn.completed"])
  })
})

describe("runModuleTransformerChain", () => {
  test("uses seam, numeric order, and contribution identity while preserving the last successful value", () => {
    const result = runModuleTransformerChain({
      seam: "modelContext",
      value: "base",
      applicationIdentity: "request-7",
      transformers: [
        { seam: "other", id: "ignored", order: 0, transformer: (value: string) => `${value}:ignored` },
        { seam: "modelContext", id: "zeta", order: 10, transformer: (value: string) => `${value}:zeta` },
        { seam: "modelContext", id: "failed", order: 5, transformer: () => { throw new Error("no replacement") } },
        { seam: "modelContext", id: "alpha", order: 10, transformer: (value: string) => `${value}:alpha` },
      ],
    })

    expect(result.value).toBe("base:alpha:zeta")
    expect(result.applications.map(({ transformerId, outcome }) => [transformerId, outcome])).toEqual([
      ["failed", "error"],
      ["alpha", "applied"],
      ["zeta", "applied"],
    ])
    expect(result.applications[0]?.inputHash).toBe(result.applications[0]?.outputHash)
    expect(result.applications[1]?.inputHash).toBe(result.applications[0]?.outputHash)
    expect(result.applications[2]?.inputHash).toBe(result.applications[1]?.outputHash)
    expect(result.applications.every((application) => !JSON.stringify(application).includes("base"))).toBe(true)
    expect(result.applications.map(({ applicationId }) => applicationId)).toEqual(
      runModuleTransformerChain({
        seam: "modelContext",
        value: "base",
        applicationIdentity: "request-7",
        transformers: [
          { seam: "modelContext", id: "zeta", order: 10, transformer: (value: string) => `${value}:zeta` },
          { seam: "modelContext", id: "failed", order: 5, transformer: () => { throw new Error("no replacement") } },
          { seam: "modelContext", id: "alpha", order: 10, transformer: (value: string) => `${value}:alpha` },
        ],
      }).applications.map(({ applicationId }) => applicationId),
    )
  })
})
