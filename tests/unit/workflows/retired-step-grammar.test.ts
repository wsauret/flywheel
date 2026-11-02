import { describe, expect, it } from "bun:test"
import { decodeWorkflowFile } from "../../../src/workflows/workflow-file.js"
import { RETIRED_FLOW_CASES, stepFile } from "../../helpers/retired-step-cases.js"

describe("a saved file of the retired step grammar, by flow entry kind", () => {
  it.each(RETIRED_FLOW_CASES)("converts a $kind", ({ steps, flow, phases }) => {
    const decoded = decodeWorkflowFile({ file: "converted.workflow.yaml", content: stepFile(steps, flow) })
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.diagnostics))
    expect(decoded.definition.phases).toMatchObject(phases)
    expect(decoded.definition.phases).toHaveLength(phases.length)
  })
})
