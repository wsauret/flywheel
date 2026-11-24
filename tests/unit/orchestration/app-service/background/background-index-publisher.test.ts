import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type StoredFact } from "../../../../../src/infra/event-store-types"
import type { ActiveBackgroundCommandDescriptor } from "../../../../../src/orchestration/agent-runtime/background-work/background-work"
import type { SessionStore } from "../../../../../src/orchestration/session-store/types"
import { markCommandKept, writeCommandHandover } from "../../../../../src/orchestration/session/command-handover"
import { buildSessionMetadataAppend } from "../../../../../src/orchestration/session/metadata/catalog/session-metadata-store"
import { buildSessionChildLinkedFact, buildSessionChildUnlinkedFact } from "../../../../../src/orchestration/session/metadata/session-metadata-facts"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime/runtime-ui-protocol-types"
import { countStateRequests } from "../../../../helpers/state-requests"
import { adoptTestWorkflow } from "../../session/_session-manager-fixtures"
import { backgroundIndexFixtures, byId } from "./_background-index-fixtures"
import { chatEntry } from "../app-service-doubles"

const { chatWithWork, follow, ownedIndex } = backgroundIndexFixtures()

/** A command the chat starts after the fixture's work. */
const LINT = { toolUseId: "toolu_lint", processId: "bash-3", description: "bun run lint", startedAtMs: 500, state: "running" } as const

const payloads = (patches: readonly RuntimeUiPatchInput[], sessionId: string) =>
  patches.flatMap((patch) => "sessionId" in patch.cursor && patch.cursor.sessionId === sessionId ? [patch.payload] : [])

/** A batch the owner hears of that the store never wrote. */
function batch(...facts: Array<Pick<StoredFact, "type" | "sessionId" | "aggregateId" | "payload">>): StoredFact[] {
  return facts.map((fact, index) => ({ version: 1, ...fact, id: `delivered-${index}`, position: index, seq: index, timestamp: 0, actor: "flywheel" }))
}

describe("the background index owner", () => {
  test("builds an index at its first read, answers later reads from memory, and builds it again only after a release", async () => {
    const fixture = await chatWithWork()
    const counter = countStateRequests(asAsyncEventReadSurface(fixture.store))
    const { owner, patches } = ownedIndex(fixture, { reader: counter.reader })

    const built = await owner.snapshot("chat")
    expect(byId(built.rows)).toEqual(byId(await fixture.index.rows("chat")))
    expect(counter.take().length).toBeGreaterThan(0)
    expect(await owner.snapshot("chat")).toEqual(built)
    expect(counter.take()).toEqual([])

    owner.release("chat")
    await fixture.command("chat", LINT)
    await Bun.sleep(5)
    expect(counter.take()).toEqual([])
    expect(patches).toEqual([])
    expect((await owner.snapshot("chat")).rows.map((row) => row.id)).toContain("toolu_lint")
  })

  test("a failed build answers the read with the failure, never an empty index, and the next read builds again", async () => {
    const fixture = await chatWithWork()
    const { owner } = ownedIndex(fixture)
    fixture.refusals.add("chat")

    await expect(owner.snapshot("chat")).rejects.toThrow("the store refused the read of chat")
    fixture.refusals.delete("chat")
    expect(byId((await owner.snapshot("chat")).rows)).toEqual(byId(await fixture.index.rows("chat")))
  })

  test("a failed update lets the index go and tells clients to read it again, which builds it again", async () => {
    const fixture = await chatWithWork()
    const { owner, patches } = ownedIndex(fixture)
    await owner.snapshot("chat")
    fixture.refusals.add("chat")

    fixture.store.append(buildSessionMetadataAppend("chat", buildSessionChildLinkedFact("late", new Date(700).toISOString())))
    await Bun.sleep(5)

    expect(patches).toEqual([{ cursor: { scope: "session", domain: "background", sessionId: "chat" }, payload: { kind: "runtime.invalidate", reason: "overflow" } }])
    fixture.refusals.delete("chat")
    const reads = fixture.sessionReads.length
    await owner.snapshot("chat")
    expect(fixture.sessionReads.slice(reads)).toContain("chat")
  })

  test("publishes each changed row whole, or its removal, on the cursor of the index's session, and nothing for an index let go", async () => {
    const fixture = await chatWithWork()
    const { owner, patches } = ownedIndex(fixture)
    await owner.snapshot("chat")

    await fixture.command("chat", LINT)
    await Bun.sleep(5)
    fixture.sessions.set("chat", { ...fixture.sessions.get("chat")!, children: ["reviewer"] })
    fixture.store.append(buildSessionMetadataAppend("chat", buildSessionChildUnlinkedFact("finished", new Date(800).toISOString())))
    await Bun.sleep(5)
    owner.release("chat")
    await fixture.command("chat", { ...LINT, toolUseId: "toolu_build", processId: "bash-4", description: "bun run build" })
    await Bun.sleep(5)

    const lint = (await fixture.index.rows("chat")).find((row) => row.id === "toolu_lint")
    if (!lint) throw new Error("expected the lint command's row")
    expect(patches.map((patch) => patch.payload)).toEqual([
      { kind: "background.row.updated", row: lint },
      { kind: "background.row.removed", rowId: "finished" },
    ])
    expect(payloads(patches, "chat")).toHaveLength(patches.length)
  })

  test("a conversation append reads and publishes nothing, and a nested subagent's run changes its row in the chat's index but not in its own, where it is the root", async () => {
    const fixture = await chatWithWork()
    const counter = countStateRequests(asAsyncEventReadSurface(fixture.store))
    const owned = ownedIndex(fixture, { reader: counter.reader })
    await owned.owner.snapshot("chat")
    await owned.owner.snapshot("explorer")
    counter.take()

    owned.deliver(batch({ type: "conversation.message.appended", sessionId: "chat", aggregateId: "session:chat", payload: {} }))
    await owned.settled()
    expect(counter.take()).toEqual([])
    expect(owned.patches).toEqual([])

    await fixture.endRun("explorer", "completed")
    await owned.settled()
    expect(payloads(owned.patches, "chat")).toEqual([{ kind: "background.row.updated", row: expect.objectContaining({ id: "explorer", status: "completed" }) }])
    expect(payloads(owned.patches, "explorer")).toEqual([])
  })

  test("decodes a root's result in its stored shape, and a fact it cannot read holds back no other change of its batch", async () => {
    const fixture = await chatWithWork()
    const { owner, patches, settled } = ownedIndex(fixture)
    await owner.snapshot("chat")

    fixture.store.appendBatch([
      // A large result is stored as version 4, whose display text is a content reference.
      { aggregateId: "session:chat", sessionId: "chat", timestamp: Date.now(), type: "tool.result.recorded", version: 4, actor: "flywheel", payload: { toolUseId: "toolu_workflow", outcome: "stopped", details: { displayContent: { sha256: "a".repeat(64), bytes: 4096, preview: "stopped" } } } },
      { aggregateId: "session:chat", sessionId: "chat", timestamp: Date.now(), type: "tool.result.recorded", version: 99, actor: "flywheel", payload: {} },
      { aggregateId: "session:chat", sessionId: "chat", timestamp: Date.now(), type: "tool.background_command.recorded", version: 1, actor: "flywheel", payload: LINT },
    ])
    await settled()

    const rows = patches.flatMap(({ payload }) => payload.kind === "background.row.updated" ? [payload.row] : [])
    expect(rows.find((row) => row.id === "workflow")?.status).toBe("stopped")
    expect(rows.map((row) => row.id)).toContain("toolu_lint")
  })

  test("a canceled workflow reads canceled until an explicit Resume passes its Cancel, and its own changes read nothing of its parent's results", async () => {
    const fixture = await chatWithWork()
    const counter = countStateRequests(asAsyncEventReadSurface(fixture.store))
    const { owner, patches, settled } = ownedIndex(fixture, { reader: counter.reader })
    await owner.snapshot("chat")
    const workflowRow = () => patches.flatMap(({ payload }) => payload.kind === "background.row.updated" && payload.row.id === "workflow" ? [payload.row] : []).at(-1)

    const cancel = fixture.store.append({ aggregateId: "session:chat", sessionId: "chat", timestamp: Date.now(), type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "toolu_workflow", outcome: "stopped", contentPreview: "stopped" } })
    await settled()
    expect(workflowRow()?.status).toBe("stopped")

    // The canceled run's own changes, such as its teardown, keep it canceled
    // and read no result history of its parent.
    counter.take()
    fixture.store.append({ aggregateId: "workflow:workflow", sessionId: "workflow", timestamp: Date.now(), type: "workflow.resumed", version: 1, actor: "flywheel", payload: {} })
    await settled()
    expect(workflowRow()?.status).toBe("stopped")
    expect(counter.take().filter((request) => request.aggregateId === "session:chat")).toEqual([])

    fixture.store.append({ aggregateId: "session:chat", sessionId: "chat", timestamp: Date.now(), type: "workflow.tool_result.resumed", version: 1, actor: "flywheel", payload: { toolUseId: "toolu_workflow", childSessionId: "workflow", resultEventId: cancel.id, by: "person" } })
    await settled()
    expect(workflowRow()?.status).not.toBe("stopped")
  })

  test("a change of the live commands is read once: the same commands again read nothing", async () => {
    const fixture = await chatWithWork()
    const counter = countStateRequests(asAsyncEventReadSurface(fixture.store))
    const client = await follow(fixture, counter.reader)
    const server = fixture.live.get("chat")!
    counter.take()

    fixture.live.set("chat", [...server, { id: "reviewer", description: "Reviewer", toolUseId: "toolu_reviewer", startedAtMs: 250, model: "model" }])
    client.liveChanged("chat")
    await client.settled()
    expect(counter.take().length).toBeGreaterThan(0)
    const rows = await client.rows()

    fixture.live.set("chat", [...server, { id: "reviewer", description: "Reviewer", toolUseId: "toolu_reviewer", startedAtMs: 250, model: "model" }])
    client.liveChanged("chat")
    await client.settled()
    expect(counter.take()).toEqual([])
    expect(await client.rows()).toEqual(rows)
    expect(rows).toEqual(byId(await fixture.index.rows("chat")))
  })

  test("a command that starts while no index is held and ends after a hold is reported as ended", async () => {
    const fixture = await chatWithWork()
    const owned = ownedIndex(fixture)
    // The owner learns the dev server while no index is held.
    owned.liveChanged("chat")
    expect((await owned.owner.snapshot("chat")).rows.find((row) => row.id === "toolu_server")?.status).toBe("running")

    fixture.live.set("chat", [])
    owned.liveChanged("chat")
    await owned.settled()

    expect(owned.patches.map((patch) => patch.payload)).toContainEqual({ kind: "background.row.updated", row: expect.objectContaining({ id: "toolu_server", status: "ended" }) })
  })

  test("the keeper's word reads again the rows whose command it took up, so a command the keeper holds runs again", async () => {
    const fixture = await chatWithWork()
    const owned = ownedIndex(fixture)
    owned.liveChanged("chat")
    await owned.owner.snapshot("chat")
    fixture.live.set("chat", [])
    owned.liveChanged("chat")
    await owned.settled()
    owned.patches.length = 0

    const reader = asAsyncEventReadSurface(fixture.store)
    const writer = asAsyncEventWriter(fixture.store)
    const stored = await writeCommandHandover({ reader, writer, row: {
      handoffId: "handoff", sessionId: "chat", conversationId: "conversation-chat", processId: "bash-2", toolUseId: "toolu_server",
      description: "bun run dev", logPath: "log", recordPath: "record", channel: "channel", token: "token", pid: 1, startedAtMs: 300,
    } })
    expect(await markCommandKept(reader, writer, stored)).toBeDefined()
    await owned.settled()
    expect(owned.patches).toEqual([])

    owned.keptChanged("chat")
    await owned.settled()
    expect(owned.patches.map((patch) => patch.payload)).toEqual([{ kind: "background.row.updated", row: expect.objectContaining({ id: "toolu_server", status: "running" }) }])
  })

  test.each([2, 200])("store changes over %d sessions whose commands stay the same read one entry per change and none of its commands", async (members) => {
    const fixture = await chatWithWork()
    const sessionIds = Array.from({ length: members }, (_, index) => `session-${index}`)
    const live = new Map<string, readonly ActiveBackgroundCommandDescriptor[]>()
    let liveChanged: ((changed: ReadonlySet<string> | undefined) => void) | undefined
    const sessionStore = countStateRequests<Pick<SessionStore, "onChange" | "get" | "allIds">>({
      onChange: (listener) => { liveChanged = listener; return () => {} },
      get: (sessionId) => chatEntry({ activeBackgroundCommands: live.get(sessionId) ?? [] }),
      allIds: () => [...sessionIds],
    })
    const { owner, patches } = ownedIndex(fixture, { sessionStore: sessionStore.reader })
    const touch = async (changed: ReadonlySet<string> | undefined): Promise<void> => { liveChanged?.(changed); await Bun.sleep(1) }
    await owner.snapshot("chat")
    let commandReads = 0
    const countedCommands = (sessionId: string): ActiveBackgroundCommandDescriptor[] => new Proxy([{ id: `bash-${sessionId}`, toolUseId: `toolu_${sessionId}`, description: "bun test", startedAtMs: 0 }], {
      get(target, key, receiver) {
        commandReads += 1
        // oxlint-disable-next-line anti-slop/no-reflect-get -- boundary: a Proxy trap forwards an arbitrary property key to its target
        return Reflect.get(target, key, receiver)
      },
    })
    for (const sessionId of sessionIds) live.set(sessionId, countedCommands(sessionId))
    // The owner learns each session's commands once.
    await touch(undefined)
    sessionStore.take()
    commandReads = 0

    const changes = 10
    for (let change = 0; change < changes; change += 1) await touch(new Set([sessionIds[change % members]!]))
    expect(sessionStore.take().map((request) => request.method)).toEqual(Array.from({ length: changes }, () => "get"))
    await touch(undefined)

    expect(commandReads).toBe(0)
    expect(patches).toEqual([])
  })

  test("a burst of a workflow's commits reads its row once, and an adoption moves the workflow's row from the root that launched it to the root that adopted it", async () => {
    const fixture = await chatWithWork()
    fixture.sessions.set("other-chat", { kind: "chat", createdAtMs: 0, label: "Other chat", children: [] })
    const counter = countStateRequests(asAsyncEventReadSurface(fixture.store))
    const owned = ownedIndex(fixture, { reader: counter.reader })
    await owned.owner.snapshot("chat")
    await owned.owner.snapshot("other-chat")
    const commit = fixture.store.read({ aggregateId: "workflow:workflow" }).at(-1)!
    const reads = async (delivered: readonly StoredFact[]): Promise<number> => {
      counter.take()
      owned.deliver(delivered)
      await owned.settled()
      return counter.take().length
    }

    // The first commit also builds the held fold of where workflows sit.
    await reads([commit])
    const once = await reads([commit])
    expect(once).toBeGreaterThan(0)
    expect(await reads([commit, commit, commit])).toBe(once)

    owned.patches.length = 0
    adoptTestWorkflow(fixture.store, { workflowSessionId: "workflow", previousParentId: "chat", parentSessionId: "other-chat", parentConversationId: "conversation-other-chat", toolUseId: "toolu_adopt" })
    await owned.settled()
    await owned.settled("other-chat")
    expect(payloads(owned.patches, "chat")).toEqual([{ kind: "background.row.removed", rowId: "workflow" }])
    expect(payloads(owned.patches, "other-chat")).toEqual([{ kind: "background.row.updated", row: expect.objectContaining({ id: "workflow" }) }])
  })

  test("a change that arrives while an index is built reaches it once the build ends, after the build's read", async () => {
    const fixture = await chatWithWork()
    const owned = ownedIndex(fixture)
    const gate = Promise.withResolvers<void>()
    fixture.gates.set("chat", gate.promise)
    const read = owned.owner.snapshot("chat")
    while (!fixture.sessionReads.includes("chat")) await Bun.sleep(1)

    fixture.sessions.set("late", { kind: "subagent", createdAtMs: 700, label: "Late", parent: { sessionId: "chat", toolUseId: "toolu_late" } })
    fixture.sessions.set("chat", { ...fixture.sessions.get("chat")!, children: ["reviewer", "finished", "late"] })
    await fixture.subagentRun("late")
    fixture.store.append(buildSessionMetadataAppend("chat", buildSessionChildLinkedFact("late", new Date(700).toISOString())))
    await Bun.sleep(5)
    fixture.gates.delete("chat")
    gate.resolve()

    expect((await read).rows.map((row) => row.id)).not.toContain("late")
    await owned.settled()
    expect(owned.patches.map((patch) => patch.payload)).toContainEqual({ kind: "background.row.updated", row: expect.objectContaining({ id: "late" }) })
  })
})
