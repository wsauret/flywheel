import { expect, test } from "bun:test"
import { createDefinitionStalenessProjection } from "../../../../src/orchestration/modules/definition-overrides/protocol.js"
import type { DefinitionOverrideOperations, DefinitionStalenessReport } from "../../../../src/workflows/definitions/override-staleness.js"

/** Operations whose report a test sets, with the subscription the projection
 *  publishes from and a `list` that reloads the way the service does. */
function operations(initial: DefinitionStalenessReport) {
  let report = initial
  const listeners = new Set<(report: DefinitionStalenessReport) => void>()
  const notify = () => { for (const listener of listeners) listener(report) }
  const overrides: Pick<DefinitionOverrideOperations, "list" | "subscribe"> = {
    list: async () => { notify(); return report },
    subscribe: (listener: (report: DefinitionStalenessReport) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { overrides, set: (next: DefinitionStalenessReport) => { report = next; notify() }, listeners }
}

function override(status: "current" | "upstream-changed", index: number, valid = true) {
  return {
    valid,
    family: "system-prompt" as const,
    id: `prompt-${index}`,
    layer: "user" as const,
    path: `/prompt-${index}.md`,
    catalogPath: "system-prompt.md",
    currentDefaultHash: "new",
    status,
    snapshotPath: `/prompt-${index}.md.base`,
    snapshotAvailable: false,
  }
}

test("a snapshot reloads through the operations and publishes one complete latest-collapsible view per change", async () => {
  const published: unknown[] = []
  const ops = operations({ overrides: [], diagnostics: [] })
  const projection = createDefinitionStalenessProjection({ overrides: ops.overrides, publish: (patch) => published.push(patch) })
  expect((await projection.snapshot()).reviewCount).toBe(0)
  expect(published).toHaveLength(1)
  await projection.snapshot()
  expect(published).toHaveLength(1)

  ops.set({ overrides: [override("current", 0), override("upstream-changed", 1)], diagnostics: [] })
  expect(published).toHaveLength(2)
  const view = await projection.snapshot()
  expect(view.reviewCount).toBe(1)
  expect(view.overrides.map((entry) => entry.id)).toEqual(["prompt-0", "prompt-1"])
  expect(published).toHaveLength(2)

  projection.dispose()
  expect(ops.listeners.size).toBe(0)
})

test("a rejected override is a problem, not an override in effect, and waits for no review", async () => {
  const ops = operations({
    overrides: [override("upstream-changed", 0), override("upstream-changed", 1, false)],
    diagnostics: [{ path: "/prompt-1.md", layer: "user", message: "missing description" }],
  })
  const projection = createDefinitionStalenessProjection({ overrides: ops.overrides, publish: () => {} })

  const view = await projection.snapshot()

  expect(view.overrides.map((entry) => entry.id)).toEqual(["prompt-0"])
  expect(view.reviewCount).toBe(1)
  expect(view.diagnostics).toEqual([{ path: "/prompt-1.md", layer: "user", message: "missing description" }])
  projection.dispose()
})

test("a composition without override operations answers the empty view and publishes nothing", async () => {
  const published: unknown[] = []
  const projection = createDefinitionStalenessProjection({ overrides: undefined, publish: (patch) => published.push(patch) })
  expect(await projection.snapshot()).toEqual({ overrides: [], diagnostics: [], reviewCount: 0 })
  expect(published).toEqual([])
  projection.dispose()
})
