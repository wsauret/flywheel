import { describe, expect, it } from "bun:test"
import {
  LEGACY_HANDOFF_CONTRACTS,
  LEGACY_WORKFLOW_BINDINGS,
} from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-step-content-pins.js"
import { legacyCaptureOf } from "../../../../src/orchestration/modules/workflows/migrations/legacy-identity-view.js"
import { retiredBindingSha256 } from "../../../../src/workflows/retired-bindings.js"
import { CHANGED_SINCE_CUTOVER } from "./_legacy-workflow-aggregate.js"
import { retiredBuiltInDefinition } from "../../../../src/workflows/vm/retired-built-in-definitions.js"

const SHA256 = /^[0-9a-f]{64}$/

/** These checks read only the frozen literals, so they stay after the cutover. */
describe("frozen pre-cutover identity pins", () => {
  it("names each handoff type once, with a positive revision and well-formed hashes", () => {
    const names = LEGACY_HANDOFF_CONTRACTS.map(({ name }) => name)
    expect(new Set(names).size).toBe(names.length)
    for (const pin of LEGACY_HANDOFF_CONTRACTS) {
      expect(pin.contractRevision).toBeGreaterThan(0)
      expect([pin.fieldsSha256, pin.rulesSha256, pin.artifactPathFieldsSha256].every((hash) => SHA256.test(hash))).toBe(true)
    }
  })

  it("binds each workflow position to a pinned handoff type with a well-formed hash", () => {
    const pinned = new Set(LEGACY_HANDOFF_CONTRACTS.map(({ name }) => name))
    for (const bindings of Object.values(LEGACY_WORKFLOW_BINDINGS)) {
      const ids = bindings.map(({ bindingId }) => bindingId)
      expect(ids).toEqual([...ids].sort())
      for (const binding of bindings) {
        expect(pinned.has(binding.handoff)).toBe(true)
        expect(SHA256.test(binding.sha256)).toBe(true)
      }
    }
  })
})

/** Retired workflows keep their frozen binding evidence even without a live
 * definition or its briefs. */
describe("binding pins equal the pre-cutover view", () => {
  it("the installed or frozen pre-cutover view reproduces every pinned binding", () => {
    for (const [workflowId, pins] of Object.entries(LEGACY_WORKFLOW_BINDINGS)) {
      const view = retiredBuiltInDefinition(workflowId)
      const capture = view && legacyCaptureOf(view)
      if (!capture) throw new Error(`shipped workflow ${workflowId} has no pre-cutover view`)
      const changed = CHANGED_SINCE_CUTOVER.get(workflowId) ?? []
      const bindings = [...capture.bindings].filter(([bindingId]) => !changed.includes(bindingId)).sort(([left], [right]) => left.localeCompare(right))
      expect(bindings.map(([bindingId, binding]) => ({
        bindingId,
        skillId: binding.skill,
        handoff: binding.handoff,
        toolScoping: binding.toolScoping,
        sha256: retiredBindingSha256(bindingId, binding),
      }))).toEqual(pins.filter(({ bindingId }) => !changed.includes(bindingId)))
    }
  })
})
