import { expect, test } from "bun:test"
import { workflowSurfaceReads } from "../../../../src/protocol/client/workflow-surface.js"

test("each workflow surface reads only the domains it needs", () => {
  expect(workflowSurfaceReads({ kind: "page" })).toEqual({ view: true, detail: true, live: true })
  expect(workflowSurfaceReads({ kind: "card", status: "active", hasChoices: false })).toEqual({ view: true, detail: true, live: true })
  expect(workflowSurfaceReads({ kind: "card", status: "paused", hasChoices: false })).toEqual({ view: false, detail: true, live: false })
  expect(workflowSurfaceReads({ kind: "card", status: "completed", hasChoices: true })).toEqual({ view: true, detail: false, live: true })
  expect(workflowSurfaceReads({ kind: "card", status: "error", hasChoices: false })).toEqual({ view: false, detail: true, live: false })
  for (const status of ["completed", "stopped", "cancelled"] as const) {
    expect(workflowSurfaceReads({ kind: "card", status, hasChoices: false })).toEqual({ view: false, detail: false, live: false })
    expect(workflowSurfaceReads({ kind: "card", status, hasChoices: false, agentModels: true })).toEqual({ view: true, detail: false, live: false })
  }
})
