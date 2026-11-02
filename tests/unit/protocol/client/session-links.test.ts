import { describe, expect, it } from "bun:test"
import { parseSessionLink, sessionLink, parseWorkflowLink, workflowLink } from "../../../../src/protocol/client/session-links.js"

describe("session links", () => {
  it("distinguishes a workflow and its agent fragment from an actual session", () => {
    expect(parseSessionLink(sessionLink("member-1"))).toEqual({ sessionId: "member-1" })
    expect(parseWorkflowLink(workflowLink("workflow-1"))).toEqual({ workflowId: "workflow-1" })
    expect(parseWorkflowLink(workflowLink("workflow-1", "a#b c"))).toEqual({ workflowId: "workflow-1", agent: "a#b c" })
    expect(parseSessionLink(workflowLink("workflow-1"))).toBeUndefined()
    expect(parseWorkflowLink(sessionLink("member-1"))).toBeUndefined()
  })

  it("reads the session before any fragment, and nothing from another link", () => {
    expect(parseSessionLink("flywheel://session/child#other")).toEqual({ sessionId: "child" })
    expect(parseSessionLink("flywheel://session/")).toBeUndefined()
    expect(parseSessionLink("file:///scratch/a.ts")).toBeUndefined()
    expect(parseSessionLink(undefined)).toBeUndefined()
  })
})
