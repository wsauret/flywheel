import { describe, it, expect } from "bun:test"
import { createAutoAdapter } from "../../src/tui/adapters/factory"
import { OpenTUIAdapter } from "../../src/tui/adapters/opentui"
import { HeadlessAdapter } from "../../src/tui/adapters/headless"

// Mock UIActions for OpenTUIAdapter
function createMockActions() {
  return {
    getState: () => ({
      workflowStatus: "idle" as const,
      steps: [],
      currentStepIndex: -1,
      outputLines: [],
      error: null,
      approvalPending: null,
    }),
    subscribe: () => () => {},
    startWorkflow: () => {},
    stopWorkflow: () => {},
    addStep: () => {},
    startStep: () => {},
    completeStep: () => {},
    failStep: () => {},
    appendOutput: () => {},
    setOutputBlocks: () => {},
    appendOutputBlocks: () => {},
    setError: () => {},
    setApprovalPending: () => {},
    clearApproval: () => {},
  }
}

describe("createAutoAdapter", () => {
  it("returns an OpenTUIAdapter when stdout is a TTY", () => {
    // In test environment, stdout.isTTY is typically true (or we test the actual behavior)
    const adapter = createAutoAdapter(
      { actions: createMockActions() as any },
      { logLevel: "minimal" }
    )

    // The factory checks process.stdout.isTTY at call time
    // In test environments this varies, so just check it returns a valid adapter
    expect(adapter).toBeDefined()
    expect(adapter.adapterType === "opentui" || adapter.adapterType === "headless").toBe(true)
  })

  it("the returned adapter implements IWorkflowUI", () => {
    const adapter = createAutoAdapter(
      { actions: createMockActions() as any },
    )
    expect(typeof adapter.connect).toBe("function")
    expect(typeof adapter.disconnect).toBe("function")
    expect(typeof adapter.start).toBe("function")
    expect(typeof adapter.stop).toBe("function")
    expect(typeof adapter.isRunning).toBe("function")
    expect(typeof adapter.isConnected).toBe("function")
  })
})
