import { describe, expect, spyOn, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/store/event-store-types"
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work/background-work"
import type { BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work/background-work-types"
import { createSessionFactWriter } from "../../../../../src/orchestration/session/persistence/session-fact-writer"
import { backgroundIndexEntries } from "../../../../../src/protocol/client/background-index"
import { workflowRunWriter } from "../../../../../src/orchestration/module-catalog"
import { publishTestWorkflow } from "../../session/_session-manager-fixtures"
import { validateWorkflowBootstrap } from "../../../../../src/workflows/vm/recovery/bootstrap-validation"
import { buildSessionMetadataAppend } from "../../../../../src/orchestration/session/metadata/catalog/session-metadata-store"
import { buildSessionChildLinkedFact, buildSessionChildUnlinkedFact } from "../../../../../src/orchestration/session/metadata/session-metadata-facts"
import { countStateRequests } from "../../../../helpers/state-requests"
import { boundedProjectStateSlice, PROJECT_STATE_MAX_BYTES, PROJECT_STATE_MAX_PAGE_ROWS } from "../../../../../src/orchestration/app-service/project-state/project-state-protocol"
import { backgroundIndexFixtures, byId } from "./_background-index-fixtures"

const { chatWithWork, closedProject, follow } = backgroundIndexFixtures()

describe("the background index of a chat", () => {
  test("lists a workflow as one row with its progress and no row for its agents or their commands", async () => {
    const fixture = closedProject()
    fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children: [] })
    const memberId = await fixture.workflow(true)
    if (!memberId) throw new Error("expected a published member")
    const bootstrap = validateWorkflowBootstrap(fixture.store.read({ aggregateId: "workflow:workflow" }))
    expect(bootstrap.executable ? true : bootstrap.reasons).toBe(true)
    await fixture.command(memberId, { toolUseId: "member-command", processId: "process", description: "agent server", startedAtMs: 300, state: "running" })
    fixture.live.set(memberId, [{ id: "process", toolUseId: "member-command", description: "agent server", startedAtMs: 300 }])
    const rows = await fixture.index.rows("chat")
    expect(rows).toEqual([expect.objectContaining({
      id: "workflow", kind: "workflow", status: "running", target: { kind: "workflow", workflowId: "workflow" },
      progress: { done: 0, total: 1, failed: 0, running: 1, active: ["Fixture step"] },
      stop: { sessionId: "chat", toolUseId: "toolu_workflow" },
    })])
    expect(await fixture.manager.read("workflow")).toBeNull()
  })
  test("lists the chat's commands and every child in start order, each child under the child that started it, landing on the card of its top-level row", async () => {
    const fixture = await chatWithWork()

    const rows = backgroundIndexEntries(await fixture.index.rows("chat"), "all").map((entry) => entry.row)

    expect(rows.map((row) => [row.id, row.kind, row.status, row.parentRowId, row.cardToolUseId])).toEqual([
      ["toolu_test", "command", "failed", undefined, "toolu_test"],
      ["workflow", "workflow", "running", undefined, "toolu_workflow"],
      ["reviewer", "subagent", "running", undefined, "toolu_reviewer"],
      ["explorer", "subagent", "running", "reviewer", "toolu_reviewer"],
      ["toolu_server", "command", "running", undefined, "toolu_server"],
      ["finished", "subagent", "completed", undefined, "toolu_finished"],
    ])
    expect(rows[0]).toMatchObject({ exitCode: 2, durationMs: 300 })
    expect(rows.find(row => row.id === "workflow")?.target).toEqual({ kind: "workflow", workflowId: "workflow" })
    expect(rows.find(row => row.id === "reviewer")?.target).toEqual({ kind: "session", sessionId: "reviewer" })
    expect(rows.every(row => !("sessionId" in row))).toBe(true)
    // A finished child states how long its runs took; a running one does not.
    expect(rows.find((row) => row.id === "finished")).toMatchObject({ durationMs: 10 })
    expect(rows.filter((row) => row.status === "running").map((row) => row.durationMs)).toEqual([undefined, undefined, undefined, undefined])
    // Stop ends the call that launched the row: the chat's for a top-level
    // row, the parent child's for a nested one.
    expect(rows.map((row) => row.stop)).toEqual([
      undefined,
      { sessionId: "chat", toolUseId: "toolu_workflow" },
      { sessionId: "chat", toolUseId: "toolu_reviewer" },
      { sessionId: "reviewer", toolUseId: "toolu_explorer" },
      { sessionId: "chat", toolUseId: "toolu_server" },
      undefined,
    ])
  })

  test("marks the row of a command recorded as a watch, and reads a record written before watches existed as an ordinary command", async () => {
    const fixture = await chatWithWork()
    await fixture.command("chat", { toolUseId: "toolu_watch", processId: "bash-3", description: "tail -f app.log", startedAtMs: 500, state: "settled", status: "completed", exitCode: 0, settledAtMs: 900, watch: true })
    // The previous shape: the store holds the record as JSON with no `watch` key.
    fixture.store.append({ aggregateId: "session:chat", sessionId: "chat", timestamp: Date.now(), type: "tool.background_command.recorded", version: 1, actor: "flywheel", payload: JSON.parse('{"toolUseId":"toolu_old","processId":"bash-4","description":"bun run build","startedAtMs":600,"state":"settled","status":"completed","exitCode":0,"settledAtMs":700}') })

    const rows = await fixture.restarted().rows("chat")

    expect(rows.find((row) => row.id === "toolu_watch")).toMatchObject({ kind: "command", status: "completed", watch: true })
    expect(rows.find((row) => row.id === "toolu_old")).toMatchObject({ kind: "command", status: "completed" })
    expect(rows.filter((row) => "watch" in row).map((row) => row.id)).toEqual(["toolu_watch"])
  })

  test("after a restart lists the finished work with its outcome, and reads a command recorded as running with no owner as ended", async () => {
    const fixture = await chatWithWork()

    const rows = await fixture.restarted().rows("chat")

    expect(rows.find((row) => row.id === "toolu_test")).toMatchObject({ status: "failed", exitCode: 2, durationMs: 300 })
    expect(rows.find((row) => row.id === "finished")).toMatchObject({ status: "completed", durationMs: 10 })
    expect(rows.find((row) => row.id === "toolu_server")).toMatchObject({ status: "ended" })
    expect(rows.find((row) => row.id === "toolu_server")?.stop).toBeUndefined()
  })

  test("reads a child that waits on its parent as waiting on the parent, an interrupted child with a wait as interrupted, and a partial run as partial", async () => {
    const fixture = await chatWithWork()
    fixture.sessions.set("chat", { ...fixture.sessions.get("chat")!, children: ["reviewer", "finished", "paused", "budget"] })
    fixture.sessions.set("paused", { kind: "subagent", createdAtMs: 500, label: "Paused", lifecycleState: "inactive", parent: { sessionId: "chat", toolUseId: "toolu_paused" } })
    fixture.sessions.set("budget", { kind: "subagent", createdAtMs: 600, label: "Budget", lifecycleState: "inactive", parent: { sessionId: "chat", toolUseId: "toolu_budget" } })
    await fixture.subagentRun("paused")
    await fixture.subagentRun("budget", "partial")
    await fixture.wait("reviewer", { sessionId: "chat", name: "Chat" })
    await fixture.wait("paused", { sessionId: "chat", name: "Chat" })

    const rows = await fixture.index.rows("chat")

    expect(rows.find((row) => row.id === "reviewer")?.status).toBe("waiting_on_parent")
    // A wait on another session than the parent is no wait on the parent.
    expect(rows.find((row) => row.id === "explorer")?.status).toBe("running")
    expect(rows.find((row) => row.id === "paused")?.status).toBe("interrupted")
    expect(rows.find((row) => row.id === "budget")?.status).toBe("partial")
  })

  test("reads a subagent whose run history it cannot read as a child with no run, and still lists every other row", async () => {
    const fixture = await chatWithWork()
    // A newer build recorded a run in a shape this build cannot read.
    fixture.store.append({ aggregateId: "session:finished", sessionId: "finished", timestamp: Date.now(), type: "child_run.created", version: 99, actor: "flywheel", payload: {} })

    const rows = backgroundIndexEntries(await fixture.index.rows("chat"), "all").map((entry) => entry.row)

    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ["toolu_test", "failed"], ["workflow", "running"], ["reviewer", "running"], ["explorer", "running"], ["toolu_server", "running"], ["finished", "interrupted"],
    ])
  })

  test("its top-level Active rows are the live background work of the status after each change, and a reply wait is in neither", async () => {
    const fixture = closedProject()
    fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children: [] })
    const writes: Promise<void>[] = []
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: () => {},
      onCommandRecorded: (record) => { writes.push(fixture.command("chat", record)) },
    })
    fixture.live.set("chat", [])
    const activeTopLevel = async (): Promise<string[]> => {
      await Promise.all(writes)
      fixture.live.set("chat", registry.activeBackgroundCommands())
      const rows = await fixture.index.rows("chat")
      return backgroundIndexEntries(rows, "active").filter((entry) => entry.depth === 0 && entry.row.stop !== undefined).map((entry) => entry.row.stop!.toolUseId)
    }
    const statusIds = () => registry.activeBackgroundCommands().map((command) => command.toolUseId)
    const server = Promise.withResolvers<BackgroundWorkResult>()
    const subagent = Promise.withResolvers<BackgroundWorkResult>()

    registry.track({ done: server.promise, meta: { id: "bash-1", type: "background_command", description: "bun run dev", toolUseId: "toolu_server" }, kill: { run: () => { server.resolve({ status: "failed", content: "stopped", exit: { code: 143 } }) } }, startedAtMs: 100 })
    expect(await activeTopLevel()).toEqual(statusIds())

    fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children: ["worker"] })
    fixture.sessions.set("worker", { kind: "subagent", createdAtMs: 200, label: "Worker", parent: { sessionId: "chat", toolUseId: "toolu_worker" } })
    await fixture.subagentRun("worker")
    registry.track({ done: subagent.promise, meta: { id: "worker", type: "subagent", description: "Worker", toolUseId: "toolu_worker", model: "model" }, kill: { run: () => {} } })
    registry.track({ done: new Promise<BackgroundWorkResult>(() => {}), meta: { id: "wait-1", type: "reply_wait", description: "Waiting on Reviewer", toolUseId: "toolu_wait" }, kill: { run: () => {} }, wait: true })
    expect(await activeTopLevel()).toEqual(statusIds())
    expect(statusIds()).toEqual(["toolu_server", "toolu_worker"])

    registry.terminate("toolu_server")
    await Bun.sleep(5)
    expect(await activeTopLevel()).toEqual(statusIds())
    expect(statusIds()).toEqual(["toolu_worker"])
    expect((await fixture.index.rows("chat")).find((row) => row.id === "toolu_server")).toMatchObject({ status: "stopped", exitCode: 143 })
  })

  test("reads in full only the children that can be subagents, and the root's launching calls of every workflow in one read", async () => {
    const fixture = closedProject()
    fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children: [] })
    const memberId = await fixture.workflow(true)
    if (!memberId) throw new Error("expected a published member")
    await publishTestWorkflow(fixture.manager, { id: "second", description: "Review", launchedFrom: { parentSessionId: "chat", conversationId: "conversation", toolUseId: "toolu_second" } })
    const counter = countStateRequests(asAsyncEventReadSurface(fixture.store))

    const rows = await fixture.indexOn(counter.reader).rows("chat")

    expect(rows.map((row) => row.id).sort()).toEqual(["second", "workflow"])
    // The workflow's agent is a child of another kind: its creation fact rules it out.
    expect(fixture.sessionReads).toEqual(["chat"])
    expect(counter.take().filter((request) => request.query?.toolUseIds !== undefined).map((request) => [...request.query?.toolUseIds ?? []].sort())).toEqual([["toolu_second", "toolu_workflow"]])
  })

  test("reads the kinds of more children than one state page holds in slices the state Worker serves", async () => {
    const fixture = closedProject()
    const children = Array.from({ length: PROJECT_STATE_MAX_PAGE_ROWS + 1 }, (_, index) => `child-${index}`)
    const [first, ...rest] = children
    await fixture.manager.createChat({ id: first, conversationId: "conversation-child", name: "Child" })
    const [created] = fixture.store.read({ aggregateId: `session:${first}`, types: ["session.created"] })
    if (!created) throw new Error("expected the creation fact of the first child")
    const { type, version, actor, payload, timestamp } = created
    fixture.store.appendBatch(rest.map((id) => ({ aggregateId: `session:${id}`, sessionId: id, type, version, actor, payload, timestamp })))
    fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children })
    const counter = countStateRequests(asAsyncEventReadSurface(fixture.store))

    expect(await fixture.indexOn(counter.reader).rows("chat")).toEqual([])

    const slices = counter.take().flatMap((request) => request.method === "readSlice" && request.query ? [request.query] : [])
    expect(slices.filter((query) => !boundedProjectStateSlice(query, PROJECT_STATE_MAX_PAGE_ROWS, PROJECT_STATE_MAX_BYTES))).toEqual([])
    // Every child's creation fact was read, so none is read in full.
    expect(fixture.sessionReads).toEqual(["chat"])
  })
})

describe("the background index a client follows", () => {
  test("after each kind of change, the snapshot with every patch equals a fresh build", async () => {
    const fixture = await chatWithWork()
    const client = await follow(fixture)
    const fresh = async () => byId(await fixture.index.rows("chat"))
    const metadata = (sessionId: string, fact: Parameters<typeof buildSessionMetadataAppend>[1]) => { fixture.store.append(buildSessionMetadataAppend(sessionId, fact)) }
    expect(await client.rows()).toEqual(await fresh())

    // A new command of the chat, and a finished command of a nested child.
    fixture.live.set("chat", [...fixture.live.get("chat")!, { id: "bash-3", description: "bun run lint", toolUseId: "toolu_lint", startedAtMs: 500 }])
    await fixture.command("chat", { toolUseId: "toolu_lint", processId: "bash-3", description: "bun run lint", startedAtMs: 500, state: "running" })
    client.liveChanged("chat")
    await fixture.command("reviewer", { toolUseId: "toolu_build", processId: "bash-4", description: "bun run build", startedAtMs: 510, state: "settled", status: "completed", exitCode: 0, settledAtMs: 600 })
    expect(await client.rows()).toEqual(await fresh())
    expect((await client.rows()).find((row) => row.id === "toolu_build")).toMatchObject({ parentRowId: "reviewer", cardToolUseId: "toolu_reviewer" })

    // No host holds the dev server any more, and the explorer waits on its parent.
    fixture.live.set("chat", fixture.live.get("chat")!.filter((command) => command.toolUseId !== "toolu_server"))
    client.liveChanged("chat")
    await client.wait("explorer", { sessionId: "reviewer", name: "Reviewer" })
    expect(await client.rows()).toEqual(await fresh())
    expect((await client.rows()).filter((row) => row.id === "toolu_server" || row.id === "explorer").map((row) => row.status)).toEqual(["waiting_on_parent", "ended"])

    // The explorer starts a child that finishes, and the chat unlinks a finished child.
    fixture.sessions.set("late", { kind: "subagent", createdAtMs: 700, label: "Late", parent: { sessionId: "explorer", toolUseId: "toolu_late" } })
    fixture.sessions.set("explorer", { ...fixture.sessions.get("explorer")!, children: ["late"] })
    metadata("explorer", buildSessionChildLinkedFact("late", new Date(700).toISOString()))
    await fixture.subagentRun("late", "completed")
    fixture.sessions.set("chat", { ...fixture.sessions.get("chat")!, children: ["reviewer"] })
    metadata("chat", buildSessionChildUnlinkedFact("finished", new Date(800).toISOString()))
    expect(await client.rows()).toEqual(await fresh())
    expect((await client.rows()).map((row) => row.id)).toContain("late")
    expect((await client.rows()).map((row) => row.id)).not.toContain("finished")

    // The chat starts a child that links a child of its own while the
    // index still reads the first child to admit it.
    fixture.sessions.set("admitted", { kind: "subagent", createdAtMs: 900, label: "Admitted", parent: { sessionId: "chat", toolUseId: "toolu_admitted" } })
    fixture.sessions.set("chat", { ...fixture.sessions.get("chat")!, children: ["reviewer", "admitted"] })
    const gate = Promise.withResolvers<void>()
    fixture.gates.set("admitted", gate.promise)
    metadata("chat", buildSessionChildLinkedFact("admitted", new Date(900).toISOString()))
    while (!fixture.sessionReads.includes("admitted")) await Bun.sleep(1)
    fixture.sessions.set("grand", { kind: "subagent", createdAtMs: 910, label: "Grand", parent: { sessionId: "admitted", toolUseId: "toolu_grand" } })
    fixture.sessions.set("admitted", { ...fixture.sessions.get("admitted")!, children: ["grand"] })
    metadata("admitted", buildSessionChildLinkedFact("grand", new Date(910).toISOString()))
    await Bun.sleep(5)
    gate.resolve()
    expect(await client.rows()).toEqual(await fresh())
    expect((await client.rows()).find((row) => row.id === "grand")).toMatchObject({ parentRowId: "admitted" })

    // A person stops the workflow's launching call.
    const writer = createSessionFactWriter({ sessionId: "chat", writer: asAsyncEventWriter(fixture.store) })
    await writer.record({ type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "toolu_workflow", outcome: "stopped", contentPreview: "stopped" } })
    writer.dispose()
    expect(await client.rows()).toEqual(await fresh())
    expect((await client.rows()).find((row) => row.id === "workflow")?.status).toBe("stopped")
  })

  test("a workflow's own change reads its row and never the history of the chat that launched it", async () => {
    const fixture = closedProject()
    fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children: [] })
    await fixture.workflow()
    const counter = countStateRequests(asAsyncEventReadSurface(fixture.store))
    const client = await follow(fixture, counter.reader)
    counter.take()

    await workflowRunWriter(asAsyncEventReadSurface(fixture.store), fixture.manager.commitWorkflow).update("workflow", (current) => ({ ...current, shortLabel: "Renamed" }))

    expect((await client.rows()).find((row) => row.id === "workflow")?.title).toBe("Renamed")
    expect(counter.take().filter((request) => request.aggregateId === "session:chat")).toEqual([])
  })

  test.each([2, 12])("the reads of one change do not grow with %i children and their commands", async (members) => {
    const reads = async (count: number) => {
      const fixture = closedProject()
      const children = Array.from({ length: count }, (_, index) => `child-${index}`)
      fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children })
      for (const [index, childId] of children.entries()) {
        fixture.sessions.set(childId, { kind: "subagent", createdAtMs: index, label: childId, parent: { sessionId: "chat", toolUseId: `toolu_${childId}` } })
        await fixture.subagentRun(childId)
        await fixture.command("chat", { toolUseId: `toolu_command_${index}`, processId: `bash-${index}`, description: "bun test", startedAtMs: index, state: "settled", status: "completed", exitCode: 0, settledAtMs: index + 1 })
      }
      const counter = countStateRequests(asAsyncEventReadSurface(fixture.store))
      const client = await follow(fixture, counter.reader)
      counter.take()
      // Each row an update reads again is compared with the row held.
      const comparisons = spyOn(Bun, "deepEquals")
      try {
        await fixture.command("chat", { toolUseId: "toolu_next", processId: "bash-next", description: "bun run dev", startedAtMs: 100, state: "running" })
        await client.settled()
        const command = { reads: counter.take().length, rows: comparisons.mock.calls.length }
        comparisons.mockClear()
        await client.wait("child-0", { sessionId: "chat", name: "Chat" })
        await client.settled()
        return { command, child: { reads: counter.take().length, rows: comparisons.mock.calls.length } }
      } finally {
        comparisons.mockRestore()
      }
    }
    const few = await reads(1)
    const many = await reads(members)
    expect(few.command.reads).toBeGreaterThan(0)
    expect(few.child.reads).toBeGreaterThan(0)
    expect(many).toEqual(few)
  })
})
