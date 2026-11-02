import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStoreReadSurface, type FactQuery } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile, resolveOwnerPidPath } from "../../../../src/infra/paths.js"
import { createRuntimeEventStore, createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { SESSION_RECOVERY_OWED_IN_FLIGHT_KIND } from "../../../../src/orchestration/app-service/project-state-recovery.js"
import { openProjectState, recoverProject } from "../../../helpers/project-recovery.js"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { createSessionFactWriter, prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer.js"
import { buildDurableSubagentCreated, buildSubagentCompleted, buildSubagentPrompted } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { countStateRequests, type StateRequest } from "../../../helpers/state-requests.js"
import { USAGE_SETTLEMENT_IN_FLIGHT_KIND } from "../../../../src/orchestration/agent-runtime/usage-settlement.js"
import { chatSessionActions, readChatTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { removeOwnerPid } from "../../../../src/orchestration/session/pid-lock.js"
import { readSessionDurationFromReader } from "../../../../src/orchestration/session/session-duration-projection.js"
import { testDirectories } from "../../../helpers/directories.js"
import { POSIX_FAILURE_STAGING } from "../../../helpers/posix-failure-staging.js"
import { CHILD_SESSION_DELETION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/child-session-deletion.js"
import { publishTestWorkflow } from "../session/_session-manager-fixtures.js"
import { Log } from "../../../../src/infra/log.js"
import { prepareFileMutationOperation } from "../../../../src/orchestration/session/file-mutation-fact-writers.js"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose() })

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "project-state-recovery-"))
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  const writer = asAsyncEventWriter(store)
  const localReader: EventStoreReadSurface = {
    ...store,
    read(query: FactQuery = {}) {
      if (!query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("recovery must not fold the full session metadata family")
      }
      return store.read(query)
    },
    readTolerant(query: FactQuery = {}) {
      if (!query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("recovery must not fold the full session metadata family")
      }
      return store.readTolerant(query)
    },
  }
  const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store: localReader, writer })
  const reader = asAsyncEventReadSurface(localReader)
  cleanup.push(() => { store.close(); rmSync(projectRoot, { recursive: true, force: true }) })
  return { projectRoot, store, reader, writer, manager, directories: testDirectories(projectRoot) }
}

describe("project execution recovery after a generation closes", () => {
  test("recovers the sessions the generation left live and leaves every other session to its own load", async () => {
    const { reader, writer, manager, directories } = fixture()
    const live = await manager.createChat({ name: "live", initialState: "active" })
    const dormant = await manager.createChat({ name: "dormant", initialState: "inactive" })
    const state = openProjectState({ directories, reader, writer })
    const targetedReads = spyOn(state.manager, "listForIds")

    const { owed, degraded } = await state.claim("closed-generation")
    for (const entry of owed) expect(await state.recover(entry)).toBeNull()

    expect(owed.map(({ sessionId }) => sessionId)).toEqual([live])
    // Each recovery reads its own session's row once, and no other row.
    expect(targetedReads.mock.calls.flatMap(([ids]) => ids)).toEqual([live])
    expect(degraded).toEqual([])
    expect(await manager.read(live)).toMatchObject({ lifecycleState: "inactive" })
    expect(await manager.read(dormant)).toMatchObject({ lifecycleState: "inactive" })
  })

  test("discovers an inactive session from its in-flight cells", async () => {
    const { reader, writer, manager, directories } = fixture()
    const sessionId = await manager.createChat({ name: "unsettled", initialState: "inactive" })
    await writer.putInFlight?.(sessionId, USAGE_SETTLEMENT_IN_FLIGHT_KIND, "attempt-1", {
      state: "pending",
      attemptId: "attempt-1",
      requestId: "request-1",
      profileId: "profile-1",
      budgetStreamId: sessionId,
      identity: { providerSessionKey: "provider", conversationId: "conversation" },
      turn: 1,
    })

    const recovery = await recoverProject({ directories, reader, writer }, "closed-generation")

    expect(recovery.sessionIds).toEqual([sessionId])
    expect(await reader.readInFlight(sessionId, USAGE_SETTLEMENT_IN_FLIGHT_KIND)).toEqual([])
  })

  test.each(["session", "workflow"] as const)("settles an indeterminate %s file cell once and leaves no later recovery owed", async (kind) => {
    const { projectRoot, store, reader, writer, manager, directories } = fixture()
    const sessionId = kind === "workflow"
      ? await publishTestWorkflow(manager)
      : await manager.createChat({ name: "retained file cells", initialState: "inactive" })
    const owner = kind === "workflow" ? { kind, workflowId: sessionId } : { kind, sessionId }
    const facts = createSessionFactWriter({ owner, writer })
    const log = Log.create({ service: "file-mutation-recovery" })
    const warn = spyOn(log, "warn").mockImplementation(() => {})
    cleanup.push(() => { facts.dispose(); warn.mockRestore() })
    const firstPath = join(realpathSync(projectRoot), "first.txt")
    const secondPath = join(realpathSync(projectRoot), "second.txt")
    const [first, second] = await prepareFileMutationOperation({
      sessionEventWriter: facts,
      origin: { kind: "tool_call", toolUseId: "batch", modelRequestId: "request" },
    }, [firstPath, secondPath].map((path) => ({
      change: { path, displayPath: path, changeKind: "created", beforeContent: null, afterContent: "after" },
      evidence: { beforeSnapshot: null },
    })))
    if (!first || !second) throw new Error("expected a two-file operation")
    writeFileSync(firstPath, "after")
    const initial = await recoverProject({ directories, reader, writer }, "ownerless")
    expect(initial.sessionIds).toEqual([sessionId])
    expect(initial.degraded).toEqual([])
    expect(store.readInFlight(sessionId, "file.mutation")).toEqual([])
    expect(store.readInFlight(sessionId, SESSION_RECOVERY_OWED_IN_FLIGHT_KIND)).toEqual([])
    expect(store.read({ aggregateId: `session:${sessionId}`, types: ["file.mutation.settled"] }).map((fact) => fact.payload)).toEqual([
      { mutationId: first.mutationId, outcome: "indeterminate" },
    ])
    expect(store.read({ aggregateId: `session:${sessionId}`, types: ["file.changed", "file.artifact.recorded"] })).toEqual([])
    expect(store.read({ aggregateId: `session:${sessionId}`, types: ["file.mutation.recovery_warned"] })).toEqual([])
    expect(readFileSync(firstPath, "utf8")).toBe("after")
    expect(existsSync(secondPath)).toBe(false)
    expect(warn.mock.calls).toEqual([[
      "file mutation recovery settled an indeterminate outcome; no change was attributed",
      { sessionId, mutationId: first.mutationId },
    ]])
    warn.mockClear()

    const repeated = await recoverProject({ directories, reader: asAsyncEventReadSurface(store), writer }, "ownerless")
    expect(repeated.sessionIds).toEqual([])
    expect(repeated.degraded).toEqual([])
    expect(warn.mock.calls).toEqual([])
  })

  test("startup sweeps historical finalized cells once per session and does not claim them again", async () => {
    const { store, reader, writer, manager, directories } = fixture()
    const id = await manager.createChat({ name: "recorded historical result", initialState: "inactive" })
    const session = await manager.read(id)
    if (session?.kind !== "chat") throw new Error("expected chat")
    const tree = await tryOpenConversationTree({ sessionId: id, conversationId: session.conversationId, store: reader, writer })
    if (!tree) throw new Error("missing tree")
    try {
      const saved = await tree.appendMessages([
        { kind: "assistant", content: [{ type: "tool_use", id: "done", name: "read", input: {} }] },
        { kind: "toolResult", toolUseId: "done", content: [{ type: "text", text: "output" }] },
      ])
      if (saved.kind !== "committed") throw saved.cause
      store.append({ aggregateId: `session:${id}`, sessionId: id, type: "tool.result.recorded",
        version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "done", outcome: "ok" } })
      store.putInFlight(id, "finalized-tool-result", "done", {
        toolUseId: "done", content: [{ type: "text", text: "output" }], outcome: "ok",
      })
      const prefixes: (string | undefined)[] = []
      const counted = { ...reader, async readInFlight(sessionId: string, kind: string | readonly string[], keyPrefix?: string) {
        if (kind === "finalized-tool-result") prefixes.push(keyPrefix)
        return reader.readInFlight(sessionId, kind, keyPrefix)
      } }
      const recovered = await recoverProject({ directories, reader: counted, writer }, "ownerless")
      expect(recovered.sessionIds).toEqual([id])
      expect(recovered.degraded).toEqual([])
      expect(prefixes).toEqual([undefined, `${session.conversationId}:`])
      expect(store.readInFlight(id, "finalized-tool-result")).toEqual([])
      expect((await recoverProject({ directories, reader, writer }, "ownerless")).sessionIds).toEqual([])
    } finally { tree.getStorage().dispose() }
  })

  test("a session whose history this release cannot read is reported and never holds the project", async () => {
    const { store, reader, writer, manager, directories } = fixture()
    const healthy = await manager.createChat({ name: "healthy", initialState: "active" })
    const broken = await manager.createChat({ name: "broken", initialState: "active" })
    // A tree-creation fact in a shape no registered schema states.
    store.append({
      aggregateId: `session:${broken}`,
      sessionId: broken,
      type: "chat.tree.created",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      payload: { unexpected: true },
    })

    const recovery = await recoverProject({ directories, reader, writer }, "closed-generation")

    expect([...recovery.sessionIds].sort()).toEqual([broken, healthy].sort())
    expect(recovery.degraded.map((entry) => entry.sessionId)).toEqual([broken])
    expect(recovery.degraded[0]?.error).toContain("chat.tree.created")
    // The unreadable bytes are exactly where they were.
    expect(store.read({ aggregateId: `session:${broken}`, types: ["chat.tree.created"] }).map((fact) => fact.payload)).toEqual([{ unexpected: true }])
    for (const id of [healthy, broken]) {
      expect(await manager.read(id)).toMatchObject({ lifecycleState: "inactive" })
    }
  })

  test("folds the active time of the episode the exit cut into each live session's recorded duration", async () => {
    const { store, reader, writer, manager, directories } = fixture()
    const cut = await manager.createChat({ name: "cut while it ran", initialState: "active" })
    const idle = await manager.createChat({ name: "idle at the exit", initialState: "active" })
    const fact = (sessionId: string, type: string, timestamp: number, payload: { readonly [key: string]: unknown } = {}) => {
      store.append({ aggregateId: `session:${sessionId}`, sessionId, type, version: 1, timestamp, actor: "flywheel", payload })
    }
    for (const sessionId of [cut, idle]) {
      // An earlier episode, folded and recorded when it ended.
      fact(sessionId, "model.requested", 1_000)
      fact(sessionId, "session.duration.recorded", 9_000, { accumulatedActiveMs: 8_000 })
    }
    // The cut episode: its first request, a response, and its last request.
    fact(cut, "model.requested", 20_000)
    fact(cut, "model.response_received", 23_000)
    fact(cut, "model.requested", 27_000)
    // A fact of the idle session that no running loop wrote.
    fact(idle, "session.label.updated", 30_000)

    const recovery = await recoverProject({ directories, reader, writer }, "closed-generation")

    expect(recovery.degraded).toEqual([])
    const recorded = async (sessionId: string) => (await readSessionDurationFromReader(reader, sessionId)).accumulatedActiveMs
    expect(await recorded(cut)).toBe(15_000)
    expect(await recorded(idle)).toBe(8_000)

    // A second pass finds no episode after the fold and records nothing more.
    await manager.updateLifecycleState(cut, "active")
    await recoverProject({ directories, reader, writer }, "closed-generation")
    expect(await recorded(cut)).toBe(15_000)
  })

  test("a process start claims only the active sessions whose owner process is gone", async () => {
    const { reader, writer, manager, directories } = fixture()
    // Both were left active; this process still owns the held one, and the
    // abandoned one's owner record is gone the way a killed service leaves it.
    const held = await manager.createChat({ name: "held", initialState: "active" })
    const abandoned = await manager.createChat({ name: "abandoned", initialState: "active" })
    removeOwnerPid(abandoned, directories.projectRoot)

    const recovery = await recoverProject({ directories, reader, writer }, "ownerless")

    expect(recovery.sessionIds).toEqual([abandoned])
    expect(recovery.degraded).toEqual([])
    expect(await manager.read(held)).toMatchObject({ lifecycleState: "active" })
    expect(await manager.read(abandoned)).toMatchObject({ lifecycleState: "inactive" })
  })

  test("a successor recovers an active turn owned by its still-live predecessor", async () => {
    const { reader, writer, manager, directories } = fixture()
    const id = await manager.createChat({ name: "predecessor", initialState: "active" })
    const session = await manager.read(id)
    if (session?.kind !== "chat") throw new Error("expected chat")
    const tree = await tryOpenConversationTree({ sessionId: id, conversationId: session.conversationId, store: reader, writer })
    if (!tree) throw new Error("missing tree")
    try {
      const asked = await tree.appendMessages([{ kind: "user", content: "unfinished", origin: "human" }])
      if (asked.kind !== "committed") throw asked.cause
      const deferred = await recoverProject({ directories, reader, writer }, "ownerless")
      expect(deferred.sessionIds).toEqual([])
      expect(await manager.read(id)).toMatchObject({ lifecycleState: "active" })
      expect(await readChatTurnEnd(reader, session.conversationId)).toMatchObject({ recorded: false })
      const result = await recoverProject({ directories, reader, writer, predecessorPids: [process.pid] }, "ownerless")
      expect(result.sessionIds).toEqual([id])
      expect(await manager.read(id)).toMatchObject({ lifecycleState: "inactive" })
      expect(await readChatTurnEnd(reader, session.conversationId)).toMatchObject({ end: { reason: "crash" }, recorded: true })
    } finally { tree.getStorage().dispose() }
  })

  test.skipIf(!POSIX_FAILURE_STAGING)("a process start leaves an active session whose owner record it cannot read active and untouched", async () => {
    const { reader, writer, manager, directories } = fixture()
    const unreadable = await manager.createChat({ name: "unreadable owner", initialState: "active" })
    const ownerRecord = resolveOwnerPidPath(unreadable, directories.projectRoot)
    const recorded = readFileSync(ownerRecord)
    chmodSync(ownerRecord, 0o000)

    const recovery = await recoverProject({ directories, reader, writer }, "ownerless")

    expect(recovery.sessionIds).toEqual([])
    expect(await manager.read(unreadable)).toMatchObject({ lifecycleState: "active" })
    chmodSync(ownerRecord, 0o600)
    expect(readFileSync(ownerRecord)).toEqual(recorded)
  })

  test("a turn a person was interrupting when the account ended the generation records the person's interrupt, and the rest record the exit, whether it waited for its first answer or for a tool call", async () => {
    const { store, reader, writer, manager, directories } = fixture()
    const unfinished = async (name: string, cutDuringToolCall: boolean): Promise<{ readonly sessionId: string; readonly conversationId: string }> => {
      const sessionId = await manager.createChat({ name, initialState: "active" })
      const session = await manager.read(sessionId)
      if (session?.kind !== "chat") throw new Error("expected chat session")
      const tree = await tryOpenConversationTree({
        conversationId: session.conversationId,
        sessionId,
        store: asAsyncEventReadSurface(store),
        writer,
      })
      if (!tree) throw new Error("expected conversation tree")
      try {
        const asked = await tree.appendMessages([{ kind: "user", content: "Work on it", origin: "human" }])
        if (asked.kind !== "committed") throw asked.cause
        if (!cutDuringToolCall) return { sessionId, conversationId: session.conversationId }
        // The order a live turn writes: the call's input completes as its
        // arguments finish streaming, then the step commits the assistant
        // message, and the process ends while the command runs.
        store.append({
          aggregateId: `session:${sessionId}`, sessionId, type: "tool.input.completed", version: 1, actor: "agent", timestamp: Date.now(),
          payload: {
            toolUseId: `${name}-call`, toolName: "bash", input: { command: "sleep 600" }, inputBytes: 24, inputSha256: "bash-input", inputPreview: "sleep 600",
            executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
          },
        })
        const called = await tree.appendMessages([{ kind: "assistant", content: [{ type: "tool_use", id: `${name}-call`, name: "bash", input: { command: "sleep 600" } }] }])
        if (called.kind !== "committed") throw called.cause
        return { sessionId, conversationId: session.conversationId }
      } finally { tree.getStorage().dispose() }
    }
    const interrupted = await unfinished("interrupted", false)
    const crashed = await unfinished("crashed", false)
    const interruptedInCall = await unfinished("interrupted-in-call", true)
    const crashedInCall = await unfinished("crashed-in-call", true)

    await recoverProject({ directories, reader, writer }, "closed-generation", [interrupted.sessionId, interruptedInCall.sessionId])

    const turnEnds = async (target: { readonly sessionId: string; readonly conversationId: string }): Promise<string[]> => {
      const tree = await tryOpenConversationTree({ ...target, store: asAsyncEventReadSurface(store), writer })
      if (!tree) throw new Error("expected conversation tree")
      try { return (await tree.getBranch()).flatMap((entry) => entry.id.startsWith("itb-") ? [entry.id] : []) } finally { tree.getStorage().dispose() }
    }
    const lastEntryId = async (target: { readonly sessionId: string; readonly conversationId: string }): Promise<string | undefined> => {
      const tree = await tryOpenConversationTree({ ...target, store: asAsyncEventReadSurface(store), writer })
      if (!tree) throw new Error("expected conversation tree")
      try { return (await tree.getBranch()).at(-1)?.id } finally { tree.getStorage().dispose() }
    }
    for (const [target, recorded] of [[interrupted, /^itb-paused-person-/], [crashed, /^itb-crash-/], [interruptedInCall, /^itb-paused-person-/], [crashedInCall, /^itb-crash-/]] as const) {
      expect(await lastEntryId(target)).toMatch(recorded)
      // The open tab reattaches the session, and Resume is offered all the same.
      expect(chatSessionActions("chat", "active", await readChatTurnEnd(asAsyncEventReadSurface(store), target.conversationId))).toContain("chat.resume")
    }

    // The next message finds the turn already ended, so it records no crash over the person's interrupt.
    const next = await tryOpenConversationTree({ ...interruptedInCall, store: asAsyncEventReadSurface(store), writer })
    if (!next) throw new Error("expected conversation tree")
    try {
      await createConversationTreeWriter({ tree: next }).commitUserTurn({ kind: "user", content: "Carry on", origin: "human" })
    } finally { next.getStorage().dispose() }
    const [personTurnEnd, ...later] = await turnEnds(interruptedInCall)
    expect(personTurnEnd).toMatch(/^itb-paused-person-/)
    expect(later).toEqual([])
  })

  test("does not synthesize a tool result for an Ask User exchange closed by interruption", async () => {
    const { store, reader, writer, manager, directories } = fixture()
    const sessionId = await manager.createChat({ name: "interrupted question", initialState: "active" })
    const session = await manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("expected chat session")
    const conversationId = session.conversationId
    const tree = await tryOpenConversationTree({
      conversationId,
      sessionId,
      store: asAsyncEventReadSurface(store),
      writer,
    })
    if (!tree) throw new Error("expected conversation tree")
    const appended = await tree.appendMessages([
      { kind: "user", content: "Ask me" },
      { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] },
      { kind: "system", content: "Interrupted by user.", displayOnly: true },
    ])
    tree.getStorage().dispose()
    if (appended.kind !== "committed") throw appended.cause
    await store.appendBatch([{
      aggregateId: `session:${sessionId}`, sessionId, type: "tool.input.completed", version: 1, actor: "agent", timestamp: 1,
      payload: {
        toolUseId: "ask-1", toolName: "ask_user", input: {}, inputBytes: 2, inputSha256: "ask-input", inputPreview: "{}",
        executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      },
    }, {
      aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 2,
      payload: {
        interactionId: "ask-1", conversationId, toolUseId: "ask-1",
        request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }],
      },
    }, {
      aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.answered", version: 3, actor: "user", timestamp: 3,
      payload: {
        interactionId: "ask-1",
        answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } },
      },
    }])

    const recovery = await recoverProject({ directories, reader, writer }, "closed-generation")

    expect(recovery.degraded).toEqual([])
    expect(store.read({ aggregateId: `session:${sessionId}`, types: ["tool.result.recorded"] })).toEqual([])
  })
})

describe("project recovery behind the writer lane", () => {
  /** A project over the lane-owned runtime store, as the state Worker opens it. */
  function laneFixture() {
    const projectRoot = mkdtempSync(join(tmpdir(), "project-recovery-gate-"))
    const store = createRuntimeEventStore(resolveEventStoreDbFile(projectRoot))
    const reader = asAsyncEventReadSurface(store)
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store, writer: store })
    cleanup.push(async () => {
      try { await store.close() } finally { rmSync(projectRoot, { recursive: true, force: true }) }
    })
    return { store, reader, manager, directories: testDirectories(projectRoot) }
  }

  async function cutChat(fixtureState: ReturnType<typeof laneFixture>, name: string) {
    const { store, reader, manager, directories } = fixtureState
    const sessionId = await manager.createChat({ name, initialState: "active" })
    const session = await manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("expected chat")
    const tree = await tryOpenConversationTree({ sessionId, conversationId: session.conversationId, store: reader, writer: store })
    if (!tree) throw new Error("missing tree")
    try {
      const asked = await tree.appendMessages([{ kind: "user", content: "unfinished", origin: "human" }])
      if (asked.kind !== "committed") throw asked.cause
    } finally { tree.getStorage().dispose() }
    removeOwnerPid(sessionId, directories.projectRoot)
    return { sessionId, conversationId: session.conversationId }
  }

  test("a process start pauses a cut session without reading its history, and its next write lands after its crash record", async () => {
    const state = laneFixture()
    const { store, reader, directories } = state
    const cut = await cutChat(state, "cut")
    const { gate, manager, claim } = openProjectState({ directories, reader, writer: store })

    gate.owe((await claim("ownerless")).owed)
    store.writerLane.admitWritesThrough(gate.admission)

    expect(gate.owed()).toEqual([cut.sessionId])
    expect(await manager.read(cut.sessionId)).toMatchObject({ lifecycleState: "inactive" })
    expect(await readChatTurnEnd(reader, cut.conversationId)).toMatchObject({ recorded: false })

    await manager.updateLabel(cut.sessionId, { label: "renamed" }, "user")

    expect(gate.owed()).toEqual([])
    expect(await readChatTurnEnd(reader, cut.conversationId)).toMatchObject({ end: { reason: "crash" }, recorded: true })
    const facts = await reader.readSlice({ sessionId: cut.sessionId })
    const positions = (type: string) => facts.facts.flatMap((fact) => !(fact instanceof Error) && fact.type === type ? [fact.position] : [])
    expect(Math.max(...positions("chat.entries.appended"))).toBeLessThan(Math.max(...positions("session.label.updated")))
    expect(await reader.readInFlight(cut.sessionId, SESSION_RECOVERY_OWED_IN_FLIGHT_KIND)).toEqual([])
  })

  test("a start that ends before a claimed session recovers leaves it owed to the next start, once", async () => {
    const state = laneFixture()
    const { store, reader, directories } = state
    const cut = await cutChat(state, "cut before recovery")

    const first = await openProjectState({ directories, reader, writer: store }).claim("ownerless")
    // The process ends here: the session is paused and its recovery is owed.
    const next = openProjectState({ directories, reader, writer: store })
    const second = await next.claim("ownerless")

    expect(first.owed).toEqual([{ sessionId: cut.sessionId, cause: "crash" }])
    expect(second.owed).toEqual([{ sessionId: cut.sessionId, cause: "crash" }])
    expect(await next.recover({ sessionId: cut.sessionId, cause: "crash" })).toBeNull()
    expect(await readChatTurnEnd(reader, cut.conversationId)).toMatchObject({ end: { reason: "crash" }, recorded: true })
    expect((await next.claim("ownerless")).owed).toEqual([])
  })

  test("a process start makes the same reads whatever the project's history", async () => {
    // A start that read each past session's history waited longer with every
    // session the project ever ran (ARCH-SUBSTRATE-032). Only the claim's one fold of the
    // workspace's active-session family returns more facts with more
    // sessions; every other request returns the same facts.
    const isActiveSessionFold = ({ method, query }: StateRequest): boolean =>
      method === "readPage" && query !== undefined && query.aggregateId === undefined && query.aggregatePrefix === undefined && query.sessionId === undefined && (query.types?.includes("session.created") ?? false)
    const claimReads = async (pastSessions: number) => {
      const state = laneFixture()
      const { store, reader, manager } = state
      for (let index = 0; index < pastSessions; index++) {
        const past = await cutChat(state, `past ${index}`)
        await manager.updateLifecycleState(past.sessionId, "inactive")
      }
      await cutChat(state, "cut")
      const counter = countStateRequests(reader)
      const { owed } = await openProjectState({ directories: state.directories, reader: counter.reader, writer: store }).claim("ownerless")
      expect(owed).toHaveLength(1)
      const requests = counter.take()
      expect(requests.filter(isActiveSessionFold)).toHaveLength(1)
      return requests.map((request) => `${request.method} ${request.query?.types?.join(",") ?? ""}${isActiveSessionFold(request) ? "" : ` ${request.facts} facts`}`).sort()
    }
    expect(await claimReads(12)).toEqual(await claimReads(2))
  })

  /** Launches subagent `childSessionId` from the last turn of `parent`'s
   *  conversation. A child that `completes` finished its run after every owner
   *  died; any other child was cut in the middle of its run. */
  async function launchSubagent(fixtureState: ReturnType<typeof laneFixture>, parent: { readonly sessionId: string; readonly conversationId: string }, childSessionId: string, run: "completes" | "is cut") {
    const { store, manager, directories } = fixtureState
    const toolUseId = `${childSessionId}-call`
    const childRunId = `${childSessionId}-run`
    const conversationId = `${childSessionId}-conversation`
    const toolInput = { persona: "explorer", description: "Review" }
    const evidence = contentEvidence(JSON.stringify(toolInput))
    const parentFacts = createSessionFactWriter({ sessionId: parent.sessionId, writer: store })
    await parentFacts.record({
      type: "tool.input.completed", version: 1, actor: "agent",
      payload: { toolUseId, toolName: "subagent", input: toolInput, inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview, executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request" },
    })
    parentFacts.dispose()
    const tree = await tryOpenConversationTree({ ...parent, store: asAsyncEventReadSurface(store), writer: store })
    if (!tree) throw new Error("missing tree")
    try {
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "subagent", input: toolInput }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId, content: [{ type: "text", text: "Dispatched." }] })
    } finally { tree.getStorage().dispose() }
    await manager.publishSubagent({
      id: childSessionId, conversationId, description: "Review", executionCwd: directories.projectRoot,
      launchedFrom: { parentSessionId: parent.sessionId, conversationId: parent.conversationId, toolUseId }, initialRoles: {},
      runBinding: prepareSessionFactAppend(childSessionId, buildDurableSubagentCreated({
        childSessionId, childRunId, conversationId,
        parentSessionId: parent.sessionId, parentConversationId: parent.conversationId, parentToolCallId: toolUseId,
        modelRequestId: "request", persona: { name: "explorer", kind: "persona" },
        capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
        admittedModuleIds: [], skillsRevision: 1, model: "test/model", tools: [], executionCwd: directories.projectRoot,
        budget: { maxTurns: 4, maxTokens: 1_000 }, parentDepth: 0, description: "Review",
      })),
      assignment: "review",
      promptFact: prepareSessionFactAppend(childSessionId, buildSubagentPrompted({ childRunId, prompt: "review", task: "review", toolNames: [] })),
    })
    if (run === "completes") {
      const childFacts = createSessionFactWriter({ sessionId: childSessionId, writer: store })
      await childFacts.record(buildSubagentCompleted({ childRunId, status: "completed", isError: false, content: "Reviewed.", durationMs: 1 }))
      childFacts.dispose()
    }
    removeOwnerPid(parent.sessionId, directories.projectRoot)
    return { sessionId: childSessionId, conversationId, toolUseId }
  }

  /** A cut chat that launched a subagent, whose child completed after the
   *  chat's owner died: its recovery publishes the child's completion. */
  async function cutSubagentParent(fixtureState: ReturnType<typeof laneFixture>) {
    const cut = await cutChat(fixtureState, "subagent parent")
    await launchSubagent(fixtureState, cut, "subagent-child", "completes")
    return cut
  }

  /** How many times each fold read its history from the first position,
   *  keyed by the aggregate or session it names and the fact types it reads. */
  function foldsFromStart(requests: readonly StateRequest[]): Map<string, number> {
    const folds = new Map<string, number>()
    for (const request of requests) {
      if (request.method !== "readPage" || request.args[2] !== 0) continue
      const scope = request.query?.aggregateId ?? request.query?.aggregatePrefix ?? (request.query?.sessionId === undefined ? "workspace" : `session-scoped ${request.query.sessionId}`)
      const key = `${scope} ${request.query?.types?.join(",") ?? "all"}`
      folds.set(key, (folds.get(key) ?? 0) + 1)
    }
    return folds
  }

  test("one Worker lifetime folds each session family and each conversation from its start once, whatever the session count", async () => {
    const lifetime = async (pastSessions: number) => {
      const state = laneFixture()
      const { store, manager: seedManager, directories } = state
      for (let index = 0; index < pastSessions; index++) await seedManager.createChat({ name: `past ${index}`, initialState: "inactive" })
      const cut = await cutSubagentParent(state)
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      const { gate, projectionReader, manager, claim } = openProjectState({ directories, reader: counter.reader, writer: store })
      gate.owe((await claim("ownerless")).owed)
      store.writerLane.admitWritesThrough(gate.admission)
      expect(gate.owed()).toEqual([cut.sessionId])
      await gate.settle([cut.sessionId])
      // Recovery published the child's completion into the parent's conversation.
      expect(JSON.stringify(store.read({ aggregateId: `conversation:${cut.conversationId}` }).map((fact) => fact.payload))).toContain("subagent-completions:subagent-child-run")
      // A later owner in the same Worker opens the recovered conversation.
      const reopened = await tryOpenConversationTree({ ...cut, store: projectionReader, writer: store })
      reopened?.getStorage().dispose()
      await manager.listActive()
      const started = foldsFromStart(counter.take())
      // A generation close claims again over the same reader.
      await claim("closed-generation")
      await claim("closed-generation")
      const refolded = [...foldsFromStart(counter.take()).keys()].filter((key) => started.has(key))
      return { started, refolded }
    }
    const foldCounts: number[] = []
    for (const pastSessions of [3, 30]) {
      const { started, refolded } = await lifetime(pastSessions)
      expect([...started].filter(([, folds]) => folds > 1)).toEqual([])
      expect(started.get("workspace session.created")).toBe(1)
      expect(refolded).toEqual([])
      foldCounts.push(started.size)
    }
    // No past session is folded at all.
    expect(foldCounts[1]).toBe(foldCounts[0])
  })

  /** The store positions of the crash records a recovery appended to a conversation. */
  async function crashRecords(reader: ReturnType<typeof laneFixture>["reader"], conversationId: string): Promise<number[]> {
    const facts = await reader.readSlice({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] })
    return facts.facts.flatMap((fact) => !(fact instanceof Error) && JSON.stringify(fact.payload).includes(`"id":"itb-crash-`) ? [fact.position] : [])
  }

  /** The results recorded for one call in a session. */
  async function resultsOf(reader: ReturnType<typeof laneFixture>["reader"], sessionId: string, toolUseId: string) {
    const facts = await reader.readSlice({ aggregateId: `session:${sessionId}` })
    return facts.facts.filter((fact) => !(fact instanceof Error) && fact.type === "tool.result.recorded" && JSON.stringify(fact.payload).includes(toolUseId))
  }

  /** A session that stays active after its owner died, as a child does that a
   *  client tab shows until the process crashes. */
  async function leftActive(fixtureState: ReturnType<typeof laneFixture>, sessionId: string) {
    await fixtureState.manager.updateLifecycleState(sessionId, "active")
    removeOwnerPid(sessionId, fixtureState.directories.projectRoot)
  }

  for (const first of ["the child settles", "a write reaches the parent"] as const) {
    test(`a cut chat and its completed subagent both owe recovery, and each recovers once when ${first} first`, async () => {
      const state = laneFixture()
      const { store, reader, directories } = state
      const cut = await cutChat(state, "subagent parent")
      const child = await launchSubagent(state, cut, "subagent-child", "completes")
      await leftActive(state, child.sessionId)
      const { gate, manager, claim } = openProjectState({ directories, reader, writer: store })
      gate.owe((await claim("ownerless")).owed)
      store.writerLane.admitWritesThrough(gate.admission)
      expect(gate.owed().toSorted()).toEqual([cut.sessionId, child.sessionId].toSorted())

      if (first === "the child settles") await gate.settle([child.sessionId])
      else await manager.updateLabel(cut.sessionId, { label: "renamed" }, "user")
      await gate.settle([cut.sessionId, child.sessionId])

      expect(gate.owed()).toEqual([])
      const crash = await crashRecords(reader, cut.conversationId)
      expect(crash).toHaveLength(1)
      expect(await resultsOf(reader, cut.sessionId, child.toolUseId)).toHaveLength(1)
      const labels = (await reader.readSlice({ aggregateId: `session:${cut.sessionId}`, types: ["session.label.updated"] })).facts.flatMap((fact) => fact instanceof Error ? [] : [fact.position])
      // The write that reached the parent first lands after its crash record.
      expect(labels).toHaveLength(first === "a write reaches the parent" ? 1 : 0)
      for (const position of labels) expect(position).toBeGreaterThan(crash[0] ?? Infinity)
      for (const sessionId of [cut.sessionId, child.sessionId]) expect(await reader.readInFlight(sessionId, SESSION_RECOVERY_OWED_IN_FLIGHT_KIND)).toEqual([])
    })
  }

  test("a cut chat, its cut subagent, and that subagent's completed subagent all owe recovery, and each recovers once", async () => {
    const state = laneFixture()
    const { store, reader, directories } = state
    const grandparent = await cutChat(state, "grandparent")
    const parent = await launchSubagent(state, grandparent, "subagent-parent", "is cut")
    const tree = await tryOpenConversationTree({ sessionId: parent.sessionId, conversationId: parent.conversationId, store: reader, writer: store })
    if (!tree) throw new Error("missing tree")
    try {
      const asked = await tree.appendMessages([{ kind: "user", content: "review", origin: "human" }])
      if (asked.kind !== "committed") throw asked.cause
    } finally { tree.getStorage().dispose() }
    const child = await launchSubagent(state, parent, "subagent-child", "completes")
    await leftActive(state, parent.sessionId)
    await leftActive(state, child.sessionId)
    const { gate, claim } = openProjectState({ directories, reader, writer: store })
    gate.owe((await claim("ownerless")).owed)
    store.writerLane.admitWritesThrough(gate.admission)
    expect(gate.owed()).toHaveLength(3)

    await gate.settle([child.sessionId])
    await gate.settle([grandparent.sessionId, parent.sessionId])

    expect(gate.owed()).toEqual([])
    expect(await crashRecords(reader, grandparent.conversationId)).toHaveLength(1)
    expect(await crashRecords(reader, parent.conversationId)).toHaveLength(1)
    expect(await resultsOf(reader, parent.sessionId, child.toolUseId)).toHaveLength(1)
  })

  for (const owing of ["the parent", "its subagent child"] as const) {
    test(`a generation close finishes a retained deletion of a workflow child while ${owing} owes recovery, which runs once`, async () => {
      const state = laneFixture()
      const { store, reader, directories } = state
      const parent = await cutChat(state, "workflow parent")
      const child = await launchSubagent(state, parent, "subagent-child", "completes")
      if (owing === "the parent") {
        await state.manager.updateLifecycleState(child.sessionId, "inactive")
      } else {
        await state.manager.updateLifecycleState(parent.sessionId, "inactive")
        await leftActive(state, child.sessionId)
      }
      await publishTestWorkflow(state.manager, { id: "workflow-child", launchedFrom: { parentSessionId: parent.sessionId, conversationId: parent.conversationId, toolUseId: "workflow-call" } })
      const { gate, manager, claim } = openProjectState({ directories, reader, writer: store })
      gate.owe((await claim("ownerless")).owed)
      store.writerLane.admitWritesThrough(gate.admission)
      expect(gate.owed()).toEqual([owing === "the parent" ? parent.sessionId : child.sessionId])
      await manager.admitDeletion("workflow-child")

      expect((await claim("closed-generation")).degraded).toEqual([])

      expect(await reader.readInFlight("workflow-child", CHILD_SESSION_DELETION_IN_FLIGHT_KIND)).toEqual([])
      expect(gate.owed()).toEqual([])
      expect(await crashRecords(reader, parent.conversationId)).toHaveLength(owing === "the parent" ? 1 : 0)
      expect(await crashRecords(reader, child.conversationId)).toHaveLength(owing === "the parent" ? 0 : 1)
      expect(await resultsOf(reader, parent.sessionId, child.toolUseId)).toHaveLength(1)
    })
  }
})
