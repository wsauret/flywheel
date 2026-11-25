import { describe, it, expect } from "bun:test"
import { executedRunLabel, exploreRunLabel } from "../../../../../../src/tui/transcript/output-blocks/tools/group-summary.js"

describe("exploreRunLabel", () => {
  it("paused", () => {
    expect(exploreRunLabel("paused")).toBe("Interrupted")
  })

})

describe("executedRunLabel", () => {
  it("uses Executed except when interrupted", () => {
    expect(executedRunLabel("active")).toBe("Executed")
    expect(executedRunLabel("completed")).toBe("Executed")
    expect(executedRunLabel("paused")).toBe("Interrupted")
  })
})
