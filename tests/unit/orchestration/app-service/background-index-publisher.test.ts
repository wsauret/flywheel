import { describe, expect, test } from "bun:test"
import type { StoredFact } from "../../../../src/infra/event-store-types"
import type { BackgroundIndexPart, BackgroundIndexSink, BackgroundIndexTree } from "../../../../src/orchestration/app-service/background-index"
import { createBackgroundIndexOwner } from "../../../../src/orchestration/app-service/background-index-publisher"
import type { BackgroundWorkRow } from "../../../../src/protocol/background-index-protocol-types"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types"
import { chatEntry } from "./app-service-doubles"

/** The sessions each fake tree holds: a chat that started a workflow and a
 *  subagent, whose own subagent is nested under it. */
const ROLES = new Map<string, "root" | "child">([["chat", "root"], ["reviewer", "child"], ["explorer", "child"]])
const ROW: BackgroundWorkRow = { id: "toolu_test", kind: "command", title: "bun test", startedAtMs: 1, cardToolUseId: "toolu_test", status: "running" }
/** The record of a command, as a session stores it. */
const COMMAND = { type: "tool.background_command.recorded", payload: { toolUseId: "toolu_test", processId: "bash-1", description: "bun test", startedAtMs: 1, state: "running" } } as const

/** An owner over fake trees and the change feeds, all in the test's hand. */
function owner() {
  const stored = new Set<(events: readonly StoredFact[]) => void>()
  const published: RuntimeUiPatchInput[] = []
  const updates: BackgroundIndexPart[] = []
  const builds: string[] = []
  const callResults: [string, string | undefined][] = []
  const sinks = new Map<string, BackgroundIndexSink>()
  let liveChanged: ((changed: ReadonlySet<string> | undefined) => void) | undefined
  let keptChanged: ((sessionId: string) => void) | undefined
  let waitsChanged: ((sessionId: string) => void) | undefined
  let live: readonly { readonly id: string; readonly toolUseId: string; readonly model?: string }[] = []
  let workflowParent = "chat"
  let failBuild: Error | undefined
  let failUpdate: Error | undefined
  const tree = (rootId: string, sink: BackgroundIndexSink): BackgroundIndexTree => {
    sinks.set(rootId, sink)
    const rows = new Map<string, BackgroundWorkRow>()
    return {
      rows,
      role: (sessionId) => rootId === "chat" ? ROLES.get(sessionId) : sessionId === rootId ? "root" : undefined,
      hasWorkflow: (workflowId) => rootId === "chat" && workflowId === "workflow" && workflowParent === "chat",
      callResult(toolUseId, stoppedBy) {
        callResults.push([toolUseId, stoppedBy])
        return rootId === "chat" && toolUseId === "toolu_workflow" ? "workflow" : undefined
      },
      childrenLaunchedBy: (sessionId, toolUseIds) => sessionId === "chat" && toolUseIds.has("toolu_reviewer") ? ["reviewer"] : [],
      async build() {
        builds.push(rootId)
        if (failBuild) throw failBuild
        rows.set(ROW.id, ROW)
      },
      async update(part) {
        if (failUpdate) throw failUpdate
        updates.push(part)
      },
    }
  }
  const handle = createBackgroundIndexOwner({
    index: { tree },
    workflowPlacements: { parent: async (workflowId) => workflowId === "workflow" ? workflowParent : undefined, observe: () => {} },
    onStored: (listener) => { stored.add(listener); return () => { stored.delete(listener) } },
    publish: (input) => { published.push(input) },
    snapshotPosition: () => published.length,
    childRunFactTypes: ["subagent.completed"],
    sessionStore: {
      onChange: (listener) => { liveChanged = listener; return () => {} },
      get: () => chatEntry({ activeBackgroundCommands: live.map((command) => ({ ...command, description: command.id, startedAtMs: 0 })) }),
      allIds: () => ["chat"],
    },
    onKeptChange: (listener) => { keptChanged = listener; return () => {} },
    onReplyWaitsChange: (listener) => { waitsChanged = listener; return () => {} },
  })
  const settle = () => Bun.sleep(1)
  return {
    handle, published, updates, builds, callResults, sinks, settle,
    failBuild(error: Error | undefined) { failBuild = error },
    failUpdate(error: Error | undefined) { failUpdate = error },
    moveWorkflow(parentSessionId: string): void { workflowParent = parentSessionId },
    async changeLive(commands: typeof live): Promise<void> {
      live = commands
      liveChanged?.(new Set(["chat"]))
      await settle()
    },
    async changeKept(sessionId: string): Promise<void> { keptChanged?.(sessionId); await settle() },
    async changeWaits(sessionId: string): Promise<void> { waitsChanged?.(sessionId); await settle() },
    async store(...facts: Array<Pick<StoredFact, "type" | "sessionId"> & { readonly aggregateId?: string; readonly payload?: StoredFact["payload"]; readonly version?: number }>): Promise<void> {
      const events = facts.map((fact, index): StoredFact => ({
        aggregateId: `session:${fact.sessionId}`, payload: {}, version: 1, ...fact,
        id: `fact-${index}`, position: index, seq: index, timestamp: 0, actor: "flywheel",
      }))
      for (const listener of stored) listener(events)
      await settle()
    },
  }
}

describe("the background index owner", () => {
  test("builds an index at its first read, answers later reads from memory, and builds it again only after a release", async () => {
    const fixture = owner()

    expect(await fixture.handle.snapshot("chat")).toEqual({ snapshotPosition: 0, rows: [ROW] })
    expect(await fixture.handle.snapshot("chat")).toEqual({ snapshotPosition: 0, rows: [ROW] })
    expect(fixture.builds).toEqual(["chat"])

    fixture.handle.release("chat")
    await fixture.store({ ...COMMAND, sessionId: "chat" })
    expect(fixture.updates).toEqual([])
    await fixture.handle.snapshot("chat")
    expect(fixture.builds).toEqual(["chat", "chat"])
    fixture.handle.dispose()
  })

  test("a failed build answers the read with the failure, never an empty index, and the next read builds again", async () => {
    const fixture = owner()
    fixture.failBuild(new Error("the store refused the read"))

    await expect(fixture.handle.snapshot("chat")).rejects.toThrow("the store refused the read")
    fixture.failBuild(undefined)
    expect(await fixture.handle.snapshot("chat")).toEqual({ snapshotPosition: 0, rows: [ROW] })
    expect(fixture.builds).toEqual(["chat", "chat"])
    fixture.handle.dispose()
  })

  test("a failed update lets the index go and tells clients to read it again, which builds it again", async () => {
    const fixture = owner()
    await fixture.handle.snapshot("chat")
    fixture.failUpdate(new Error("the store refused the read"))

    await fixture.store({ ...COMMAND, sessionId: "chat" })

    expect(fixture.published).toEqual([{ cursor: { scope: "session", domain: "background", sessionId: "chat" }, payload: { kind: "runtime.invalidate", reason: "overflow" } }])
    fixture.failUpdate(undefined)
    await fixture.handle.snapshot("chat")
    expect(fixture.builds).toEqual(["chat", "chat"])
    fixture.handle.dispose()
  })

  test("publishes each changed row whole, or its removal, on the cursor of the index's session, and nothing for an index let go", async () => {
    const fixture = owner()
    await fixture.handle.snapshot("chat")
    const sink = fixture.sinks.get("chat")!

    sink.updated({ ...ROW, status: "completed" })
    sink.removed("toolu_test")
    fixture.handle.release("chat")
    sink.updated(ROW)

    expect(fixture.published.map((patch) => patch.payload)).toEqual([
      { kind: "background.row.updated", row: { ...ROW, status: "completed" } },
      { kind: "background.row.removed", rowId: "toolu_test" },
    ])
    expect(fixture.published.every((patch) => "sessionId" in patch.cursor && patch.cursor.sessionId === "chat")).toBe(true)
    fixture.handle.dispose()
  })

  test("routes each change to the part of each held index it touches, and a conversation append to none", async () => {
    const fixture = owner()
    await fixture.handle.snapshot("chat")
    await fixture.handle.snapshot("explorer")
    const routed = async (change: () => Promise<void>): Promise<BackgroundIndexPart[]> => {
      fixture.updates.length = 0
      await change()
      return [...fixture.updates]
    }

    expect(await routed(() => fixture.store({ type: "conversation.message.appended", sessionId: "chat" }))).toEqual([])
    // A nested subagent's run fact changes its row in the chat's index; in its own index it is the root.
    expect(await routed(() => fixture.store({ type: "subagent.completed", sessionId: "explorer" }, { type: "session.lifecycle.changed", sessionId: "explorer" }))).toEqual([{ kind: "child", sessionId: "explorer" }])
    // A command record names the one command row it changes.
    const command: BackgroundIndexPart = { kind: "commands", sessionId: "explorer", toolUseIds: new Set(["toolu_test"]) }
    expect(await routed(() => fixture.store({ ...COMMAND, sessionId: "explorer" }))).toEqual([command, command])
    expect(await routed(() => fixture.store({ type: "session.child.linked", sessionId: "reviewer" }))).toEqual([{ kind: "children", sessionId: "reviewer" }])
    // The keeper's word names no command: only rows it took up or let go are read.
    expect(await routed(() => fixture.changeKept("reviewer"))).toEqual([{ kind: "commands", sessionId: "reviewer", toolUseIds: new Set() }])
    // A root's own reply wait is no row of its index.
    expect(await routed(() => fixture.changeWaits("explorer"))).toEqual([{ kind: "child", sessionId: "explorer" }])
    expect(await routed(() => fixture.store({ type: "tool.result.recorded", sessionId: "chat", payload: { toolUseId: "toolu_workflow", outcome: "stopped" } }))).toEqual([{ kind: "workflow", workflowId: "workflow" }])
    expect(fixture.callResults).toEqual([["toolu_workflow", "person"]])
    fixture.handle.dispose()
  })

  test("decodes a root's result in its stored shape, and a fact it cannot read holds back no other change of its batch", async () => {
    const fixture = owner()
    await fixture.handle.snapshot("chat")

    await fixture.store(
      // A large result is stored as version 4, whose display text is a content reference.
      { type: "tool.result.recorded", sessionId: "chat", version: 4, payload: { toolUseId: "toolu_read", outcome: "ok", details: { displayContent: { sha256: "a".repeat(64), bytes: 4096, preview: "src/" } } } },
      { type: "tool.result.recorded", sessionId: "chat", version: 99, payload: {} },
      { ...COMMAND, sessionId: "chat" },
    )

    expect(fixture.callResults).toEqual([["toolu_read", undefined]])
    expect(fixture.updates).toEqual([{ kind: "commands", sessionId: "chat", toolUseIds: new Set(["toolu_test"]) }])
    fixture.handle.dispose()
  })

  test("live commands update the session's commands and the child each changed call launched, once per change", async () => {
    const fixture = owner()
    await fixture.handle.snapshot("chat")

    const changed: BackgroundIndexPart[] = [{ kind: "commands", sessionId: "chat", toolUseIds: new Set(["toolu_reviewer"]) }, { kind: "child", sessionId: "reviewer" }]
    await fixture.changeLive([{ id: "reviewer", toolUseId: "toolu_reviewer", model: "model" }])
    expect(fixture.updates).toEqual(changed)
    fixture.updates.length = 0
    await fixture.changeLive([{ id: "reviewer", toolUseId: "toolu_reviewer", model: "model" }])
    expect(fixture.updates).toEqual([])
    await fixture.changeLive([])
    expect(fixture.updates).toEqual(changed)
    fixture.handle.dispose()
  })

  test("a burst of a workflow's commits reads its row once, and an adoption reads which workflows each root launched", async () => {
    const fixture = owner()
    await fixture.handle.snapshot("chat")
    await fixture.handle.snapshot("other-chat")
    const commit = { type: "workflow.control.committed", sessionId: "workflow", aggregateId: "workflow:workflow" }

    await fixture.store(commit, commit, commit)
    expect(fixture.updates).toEqual([{ kind: "workflow", workflowId: "workflow" }])

    fixture.updates.length = 0
    fixture.moveWorkflow("other-chat")
    await fixture.store({ ...commit, type: "workflow.run.adopted" })
    // The workflow left the chat's index and reached the other chat's.
    expect(fixture.updates).toEqual([{ kind: "launches" }])
    fixture.handle.dispose()
  })

  test("a change that arrives while an index is built reaches it once the build ends, after the build's read", async () => {
    const fixture = owner()
    const read = fixture.handle.snapshot("chat")
    await fixture.store({ type: "session.child.linked", sessionId: "chat" })

    expect(await read).toEqual({ snapshotPosition: 0, rows: [ROW] })
    await fixture.settle()
    expect(fixture.updates).toEqual([{ kind: "children", sessionId: "chat" }])
    fixture.handle.dispose()
  })
})
