import { expect, test } from "bun:test"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createDefinitionOverridesProtocol } from "../../../../src/orchestration/modules/definition-overrides/protocol.js"
import type { DefinitionOverrideOperations, DefinitionStalenessReport } from "../../../../src/workflows/definitions/override-staleness.js"
import { fixedDefinitions } from "../../../helpers/project-definitions.js"

/** Operations whose report a test sets, with the subscription the projection
 *  publishes from and a `list` that reloads the way the service does. */
function operations(initial: DefinitionStalenessReport) {
  let report = initial
  const listeners = new Set<(report: DefinitionStalenessReport) => void>()
  const notify = () => { for (const listener of listeners) listener(report) }
  const unused = () => { throw new Error("the protocol only lists and subscribes") }
  const overrides: DefinitionOverrideOperations = {
    list: async () => { notify(); return report },
    subscribe: (listener: (report: DefinitionStalenessReport) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    available: unused, diff: unused, prepare: unused, apply: unused, refresh: unused, proposal: unused, finalizeSkillPublication: unused,
  }
  return { overrides, set: (next: DefinitionStalenessReport) => { report = next; notify() }, listeners }
}

const SNAPSHOT_POSITION = 41

/** The module's protocol runtime over `overrides`, publishing into `published`. */
function protocol(overrides: DefinitionOverrideOperations | undefined, published: RuntimeUiPatchInput[] = []) {
  const runtime = createDefinitionOverridesProtocol({
    definitions: { ...fixedDefinitions(), ...(overrides ? { definitionOverrides: overrides } : {}) },
    publish: (patch) => { published.push(patch); return undefined },
    snapshotPosition: () => SNAPSHOT_POSITION,
  })
  return {
    async snapshot() {
      const result = await runtime.serve.definitionStalenessSnapshot({ type: "definitionStalenessSnapshot" })
      expect(result.snapshotPosition).toBe(SNAPSHOT_POSITION)
      return result.definitionStaleness
    },
    dispose: runtime.dispose,
  }
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
  const published: RuntimeUiPatchInput[] = []
  const ops = operations({ overrides: [], diagnostics: [] })
  const projection = protocol(ops.overrides, published)
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
  const projection = protocol(ops.overrides)

  const view = await projection.snapshot()

  expect(view.overrides.map((entry) => entry.id)).toEqual(["prompt-0"])
  expect(view.reviewCount).toBe(1)
  expect(view.diagnostics).toEqual([{ path: "/prompt-1.md", layer: "user", message: "missing description" }])
  projection.dispose()
})

test("a composition without override operations answers the empty view and publishes nothing", async () => {
  const published: RuntimeUiPatchInput[] = []
  const projection = protocol(undefined, published)
  expect(await projection.snapshot()).toEqual({ overrides: [], diagnostics: [], reviewCount: 0 })
  expect(published).toEqual([])
  projection.dispose()
})
