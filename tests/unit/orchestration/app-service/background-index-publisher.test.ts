import { describe, expect, test } from "bun:test"
import type { StoredFact } from "../../../../src/infra/event-store-types"
import { createBackgroundIndexPublisher } from "../../../../src/orchestration/app-service/background-index-publisher"
import type { SessionPlacement } from "../../../../src/orchestration/session/session-metadata-store"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types"
import { chatEntry } from "./app-service-doubles"

const SESSIONS = new Map<string, { readonly kind: "chat" | "subagent" | "workflow"; readonly parent?: string }>([
  ["chat", { kind: "chat" }],
  ["workflow", { kind: "workflow", parent: "chat" }],
  ["reviewer", { kind: "subagent", parent: "workflow" }],
])

/** A publisher over one chat that started a workflow, whose step started a
 *  subagent, with the stored-batch feed and the other words in the test's hand. */
function publisher() {
  const stored = new Set<(events: readonly StoredFact[]) => void>()
  const published: RuntimeUiPatchInput[] = []
  let liveChanged: ((changed: ReadonlySet<string> | undefined) => void) | undefined
  let keptChanged: ((sessionId: string) => void) | undefined
  let live = false
  // The order in which the publisher fed and read the placement owners.
  const placementCalls: string[] = []
  let workflowParent = "chat"
  const handle = createBackgroundIndexPublisher({
    workflowPlacements: {
      parent: async (workflowId) => {
        placementCalls.push("read")
        return workflowId === "workflow" ? workflowParent : undefined
      },
      observe: () => { placementCalls.push("observe workflows") },
    },
    sessionPlacements: {
      placement: async (sessionId) => {
        placementCalls.push("read")
        const session = SESSIONS.get(sessionId)
        if (!session) return null
        const placement: SessionPlacement = { kind: session.kind, ...(session.parent ? { launchedFrom: { parentSessionId: session.parent, toolUseId: `toolu_${sessionId}` } } : {}) }
        return placement
      },
      observe: () => { placementCalls.push("observe sessions") },
    },
    onStored: (listener) => { stored.add(listener); return () => { stored.delete(listener) } },
    publish: (input) => { published.push(input) },
    childRunFactTypes: ["subagent.completed"],
    sessionStore: {
      onChange: (listener) => { liveChanged = listener; return () => {} },
      get: () => chatEntry({ activeBackgroundCommands: live ? [{ id: "bash-1", description: "build", toolUseId: "toolu_bash", startedAtMs: 0 }] : [] }),
      allIds: () => ["workflow"],
    },
    onKeptChange: (listener) => { keptChanged = listener; return () => {} },
    onReplyWaitsChange: () => () => {},
  })
  return {
    published,
    placementCalls,
    moveWorkflow(parentSessionId: string): void { workflowParent = parentSessionId },
    async changeLive(running: boolean): Promise<void> {
      live = running
      liveChanged?.(new Set(["workflow"]))
      await Bun.sleep(1)
    },
    async changeKept(sessionId: string): Promise<void> {
      keptChanged?.(sessionId)
      await Bun.sleep(1)
    },
    async store(...facts: Array<Pick<StoredFact, "type" | "sessionId"> & { readonly aggregateId?: string }>): Promise<void> {
      const events = facts.map((fact, index): StoredFact => ({
        aggregateId: `session:${fact.sessionId}`, ...fact,
        id: `fact-${index}`, position: index, seq: index, version: 1, timestamp: 0, actor: "test", payload: {},
      }))
      for (const listener of stored) listener(events)
      await Bun.sleep(1)
    },
    dispose: handle.dispose,
  }
}

describe("the background index publisher", () => {
  test("a nested child's run facts update every ancestor index once", async () => {
    const fixture = publisher()

    await fixture.store({ type: "subagent.completed", sessionId: "reviewer" }, { type: "session.lifecycle.changed", sessionId: "reviewer" })

    expect(fixture.published.map((patch) => patch.cursor)).toEqual([
      { scope: "session", domain: "background", sessionId: "workflow" },
      { scope: "session", domain: "background", sessionId: "chat" },
    ])
    fixture.dispose()
  })

  test("a change of kept commands updates only the owning session index", async () => {
    const fixture = publisher()

    await fixture.changeKept("reviewer")

    expect(fixture.published.map((patch) => patch.cursor)).toEqual([{ scope: "session", domain: "background", sessionId: "reviewer" }])
    fixture.dispose()
  })

  test("a conversation append publishes nothing, and commands update their owning session's index", async () => {
    const fixture = publisher()

    await fixture.store({ type: "conversation.message.appended", sessionId: "chat" })
    expect(fixture.published).toEqual([])
    for (const sessionId of ["chat", "workflow", "reviewer"]) {
      fixture.published.length = 0
      await fixture.store({ type: "tool.background_command.recorded", sessionId })
      expect(fixture.published.map((patch) => patch.cursor)).toEqual([{ scope: "session", domain: "background", sessionId }])
    }
    fixture.dispose()
  })

  test("live workflow commands update the workflow and its ancestor index without repeating unchanged state", async () => {
    const fixture = publisher()
    await fixture.changeLive(true)
    expect(fixture.published.map((patch) => patch.cursor)).toEqual([
      { scope: "session", domain: "background", sessionId: "workflow" },
      { scope: "session", domain: "background", sessionId: "chat" },
    ])
    fixture.published.length = 0
    await fixture.changeLive(true)
    expect(fixture.published).toEqual([])
    await fixture.changeLive(false)
    expect(fixture.published.map((patch) => patch.cursor)).toEqual([
      { scope: "session", domain: "background", sessionId: "workflow" },
      { scope: "session", domain: "background", sessionId: "chat" },
    ])
    fixture.dispose()
  })

  test("each stored batch reaches the placement owners before the publisher reads a place, and an adoption publishes under the new parent", async () => {
    // The owners serve repeated commits without a durable read only when they
    // observe every batch before a read of it.
    const fixture = publisher()
    const commit = { type: "workflow.control.committed", sessionId: "workflow", aggregateId: "workflow:workflow" }
    for (let i = 0; i < 3; i += 1) await fixture.store(commit)
    expect(fixture.placementCalls.join(",")).toBe(Array.from({ length: 3 }, () => "observe sessions,observe workflows,read,read").join(","))
    expect(fixture.published.filter((patch) => "sessionId" in patch.cursor && patch.cursor.sessionId === "chat")).toHaveLength(3)

    fixture.published.length = 0
    fixture.moveWorkflow("other-chat")
    await fixture.store({ ...commit, type: "workflow.run.adopted" })
    expect(fixture.published.map((patch) => patch.cursor)).toEqual([{ scope: "session", domain: "background", sessionId: "other-chat" }])
    fixture.dispose()
  })

  test.each(["chat", "workflow"])("child links update the %s index that owns the child list", async (sessionId) => {
    const fixture = publisher()
    await fixture.store({ type: "session.child.linked", sessionId })
    expect(fixture.published.map((patch) => patch.cursor)).toContainEqual({ scope: "session", domain: "background", sessionId })
    fixture.dispose()
  })
})
