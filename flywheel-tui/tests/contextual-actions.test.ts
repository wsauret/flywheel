import { describe, it, expect, beforeEach } from "bun:test"
import { createActionDispatcher } from "../src/tui/shell/action-dispatcher"
import { getPlaceholderForState } from "../src/tui/components/prompt-placeholders"
import type { SessionLifecycleState } from "../src/session/state-machine"

// ---------------------------------------------------------------------------
// Helpers — fake deps for ActionDispatcher
// ---------------------------------------------------------------------------

interface Call {
  name: string
  args: unknown[]
}

function createFakeDeps(opts?: { fileExists?: boolean }) {
  const calls: Call[] = []
  return {
    calls,
    deps: {
      fileExists: (path: string) => {
        calls.push({ name: "fileExists", args: [path] })
        return opts?.fileExists ?? true
      },
      notify: (message: string, variant: string) => {
        calls.push({ name: "notify", args: [message, variant] })
      },
      launchWorkWorkflow: (planPath: string) => {
        calls.push({ name: "launchWorkWorkflow", args: [planPath] })
      },
      launchGenericWorkflow: (name: string, args: Record<string, string>) => {
        calls.push({ name: "launchGenericWorkflow", args: [name, args] })
      },
      exit: () => {
        calls.push({ name: "exit", args: [] })
      },
    },
  }
}

// ===========================================================================
// ActionDispatcher — pure dispatch logic with DI
// ===========================================================================

describe("ActionDispatcher", () => {
  describe("exit command", () => {
    it("calls exit()", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("exit", {})
      expect(calls).toEqual([{ name: "exit", args: [] }])
    })
  })

  describe("help command", () => {
    it("shows info notification with command list", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("help", {})
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe("notify")
      expect(calls[0].args[1]).toBe("info")
      expect((calls[0].args[0] as string)).toContain("/work")
    })
  })

  describe("config command", () => {
    it("shows not-yet-implemented warning", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("config", {})
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe("notify")
      expect(calls[0].args[1]).toBe("warning")
    })
  })

  describe("work command", () => {
    it("launches work workflow with resolved path", () => {
      const { calls, deps } = createFakeDeps({ fileExists: true })
      const dispatch = createActionDispatcher(deps)
      dispatch("work", { planPath: "/tmp/plan.md" })
      expect(calls.some((c) => c.name === "launchWorkWorkflow")).toBe(true)
      expect(calls.find((c) => c.name === "launchWorkWorkflow")!.args[0]).toBe(
        "/tmp/plan.md",
      )
    })

    it("shows error when no planPath provided", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("work", {})
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe("notify")
      expect(calls[0].args[1]).toBe("error")
      expect((calls[0].args[0] as string)).toContain("Usage")
    })

    it("shows error when file does not exist", () => {
      const { calls, deps } = createFakeDeps({ fileExists: false })
      const dispatch = createActionDispatcher(deps)
      dispatch("work", { planPath: "missing.md" })
      expect(calls.some((c) => c.name === "notify")).toBe(true)
      const notifyCall = calls.find((c) => c.name === "notify")!
      expect(notifyCall.args[1]).toBe("error")
      expect((notifyCall.args[0] as string)).toContain("not found")
    })

    it("expands tilde in plan path", () => {
      const { calls, deps } = createFakeDeps({ fileExists: true })
      const dispatch = createActionDispatcher(deps)
      dispatch("work", { planPath: "~/plans/plan.md" })
      const fxCall = calls.find((c) => c.name === "fileExists")!
      // Should NOT start with ~
      expect((fxCall.args[0] as string).startsWith("~")).toBe(false)
    })
  })

  describe("generic workflows (plan, review, ship, debug, research)", () => {
    it("launches plan workflow with description", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("plan", { description: "build a CLI" })
      expect(calls.find((c) => c.name === "launchGenericWorkflow")).toEqual({
        name: "launchGenericWorkflow",
        args: ["plan", { description: "build a CLI" }],
      })
    })

    it("shows error when plan has no description", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("plan", {})
      expect(calls[0].name).toBe("notify")
      expect(calls[0].args[1]).toBe("error")
    })

    it("launches review workflow with no args required", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("review", {})
      expect(calls.find((c) => c.name === "launchGenericWorkflow")).toEqual({
        name: "launchGenericWorkflow",
        args: ["review", { description: "Review current changes" }],
      })
    })

    it("launches ship workflow with no args required", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("ship", {})
      expect(calls.find((c) => c.name === "launchGenericWorkflow")).toEqual({
        name: "launchGenericWorkflow",
        args: ["ship", {}],
      })
    })

    it("shows error when debug has no description", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("debug", {})
      expect(calls[0].name).toBe("notify")
      expect(calls[0].args[1]).toBe("error")
    })

    it("shows error when research has no topic", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("research", {})
      expect(calls[0].name).toBe("notify")
      expect(calls[0].args[1]).toBe("error")
    })

    it("launches debug workflow with description", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("debug", { description: "fix OOM" })
      expect(calls.find((c) => c.name === "launchGenericWorkflow")).toEqual({
        name: "launchGenericWorkflow",
        args: ["debug", { description: "fix OOM" }],
      })
    })

    it("launches research workflow with topic", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("research", { topic: "auth flow" })
      expect(calls.find((c) => c.name === "launchGenericWorkflow")).toEqual({
        name: "launchGenericWorkflow",
        args: ["research", { topic: "auth flow" }],
      })
    })
  })

  describe("unknown workflow", () => {
    it("shows error notification for unrecognized workflow", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("bogus", {})
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe("notify")
      expect(calls[0].args[1]).toBe("error")
      expect((calls[0].args[0] as string)).toContain("Unknown")
    })
  })

  describe("contextual actions route through same dispatcher", () => {
    it("right-panel 'start work' action uses same dispatcher as /work command", () => {
      const { calls, deps } = createFakeDeps({ fileExists: true })
      const dispatch = createActionDispatcher(deps)
      // Both slash command and contextual action call the same dispatch
      dispatch("work", { planPath: "/tmp/plan.md" })
      expect(calls.find((c) => c.name === "launchWorkWorkflow")).toBeTruthy()
    })

    it("contextual 'review' action uses same dispatcher as /review command", () => {
      const { calls, deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      dispatch("review", {})
      expect(calls.find((c) => c.name === "launchGenericWorkflow")).toBeTruthy()
    })
  })

  describe("returns WorkflowMeta for valid workflows", () => {
    it("returns meta for work workflow", () => {
      const { deps } = createFakeDeps({ fileExists: true })
      const dispatch = createActionDispatcher(deps)
      const meta = dispatch("work", { planPath: "/tmp/plan.md" })
      expect(meta).toEqual({ stepLabel: "Step", workflowName: "work" })
    })

    it("returns meta for plan workflow", () => {
      const { deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      const meta = dispatch("plan", { description: "new feature" })
      expect(meta).toEqual({ stepLabel: "Step", workflowName: "plan" })
    })

    it("returns null for non-workflow commands (exit, help, config)", () => {
      const { deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      expect(dispatch("exit", {})).toBeNull()
      expect(dispatch("help", {})).toBeNull()
      expect(dispatch("config", {})).toBeNull()
    })

    it("returns null for unknown workflows", () => {
      const { deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      expect(dispatch("bogus", {})).toBeNull()
    })

    it("returns null when validation fails (missing args)", () => {
      const { deps } = createFakeDeps()
      const dispatch = createActionDispatcher(deps)
      expect(dispatch("work", {})).toBeNull()
      expect(dispatch("plan", {})).toBeNull()
      expect(dispatch("debug", {})).toBeNull()
      expect(dispatch("research", {})).toBeNull()
    })
  })
})

// ===========================================================================
// Prompt placeholders — state → placeholder mapping
// ===========================================================================

describe("getPlaceholderForState", () => {
  it('returns draft placeholder for "plan:draft"', () => {
    const text = getPlaceholderForState("plan:draft")
    expect(text).toContain("Describe")
  })

  it('returns import placeholder for "plan:imported"', () => {
    const text = getPlaceholderForState("plan:imported")
    expect(text.toLowerCase()).toContain("plan")
  })

  it('returns needs-fix placeholder for "plan:needs-fix"', () => {
    const text = getPlaceholderForState("plan:needs-fix")
    expect(text.toLowerCase()).toContain("refine")
  })

  it('returns active placeholder for "work:active"', () => {
    const text = getPlaceholderForState("work:active")
    expect(text.toLowerCase()).toContain("enter")
  })

  it('returns paused placeholder for "work:paused"', () => {
    const text = getPlaceholderForState("work:paused")
    expect(text).toBeTruthy()
  })

  it('returns review placeholder for "work:review"', () => {
    const text = getPlaceholderForState("work:review")
    expect(text).toBeTruthy()
  })

  it('returns completed placeholder for "completed"', () => {
    const text = getPlaceholderForState("completed")
    expect(text).toBeTruthy()
  })

  it("returns default placeholder for null state", () => {
    const text = getPlaceholderForState(null)
    expect(text).toBeTruthy()
  })

  it("returns default placeholder for new state", () => {
    const text = getPlaceholderForState("new")
    expect(text).toBeTruthy()
  })

  it("returns a non-empty string for every lifecycle state", () => {
    const states: (SessionLifecycleState | null)[] = [
      null,
      "new",
      "plan:draft",
      "plan:imported",
      "plan:approved",
      "plan:needs-fix",
      "work:active",
      "work:paused",
      "work:review",
      "completed",
      "archived",
      "trashed",
    ]
    for (const state of states) {
      expect(getPlaceholderForState(state).length).toBeGreaterThan(0)
    }
  })
})
