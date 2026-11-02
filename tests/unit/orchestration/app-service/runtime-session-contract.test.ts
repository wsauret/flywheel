import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { RuntimeProtocolRpc, RuntimeUiPatchSchema, runtimeQueryResultSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { classifyChatMutation } from "../../../../src/orchestration/app-service/session-mutation-routing.js"
import { createProjectControlClient } from "../../../../src/orchestration/app-service/project-control-client.js"
import { projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import type { RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import type { RuntimeUiPatch } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { fixture } from "./_project-control-client-fixture.js"
import { durableRow } from "./_frontend-projection-fixtures.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { replayWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"

describe("runtime session protocol contract", () => {
  const tmp = temporaryDirectories()
  test("committed turn and parent Stop evidence replace held detail without activity or token churn", async () => {
    const projectRoot = tmp("detail-admission-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const f = fixture()
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const flowId = await publishTestWorkflow(manager)
    const childId = await startTestWorkflowMember(manager, store, flowId)
    const child = await manager.read(childId)
    if (child?.kind !== "workflow-agent") throw new Error("Missing workflow member")
    f.metadata.set("parent", durableRow("parent", { conversationId: "conversation", childSessionIds: [childId] }))
    f.metadata.set(childId, { ...durableRow(childId), ...child, kind: "workflow-agent", conversationId: child.conversationId, workflowMembership: child.workflowMembership })
    const history = createSessionDetailProjection({
      projectRoot, manager: f.options.state.sessions,
      sessionStore: { get: () => undefined }, reader, projectionReader: reader,
    })
    f.options.history.sessionDetail = ({ sessionId }) => history.sessionDetail(sessionId)
    const client = createProjectControlClient(f.options)
    const patches: RuntimeUiPatch[] = []
    const catalogPatches: RuntimeUiPatch[] = []
    const stop = store.onStored(f.stored.emit)
    const unsubscribe = client.subscribe((event) => {
      if (event.type === "patch" && event.patch.cursor.domain === "session_detail") patches.push(event.patch)
      if (event.type === "patch" && event.patch.cursor.domain === "session") catalogPatches.push(event.patch)
    })
    const tree = await createConversationTree({ conversationId: "conversation", sessionId: "parent", store: reader, writer })
    // The child runs its first agent, whose conversation records its turn end.
    const stepTree = await tryOpenConversationTree({ conversationId: child.conversationId, sessionId: childId, store: reader, writer })
    if (!stepTree) throw new Error("Missing member conversation")
    try {
      const input = { workflow_definition_id: "work", summary: "Work", description: "Work" }
      const evidence = contentEvidence(JSON.stringify(input))
      await writer.append({
        aggregateId: "session:parent", sessionId: "parent", type: "tool.input.completed", version: 1, actor: "agent", timestamp: 1,
        payload: { toolUseId: "launch", toolName: "workflow", input, inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview, executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request" },
      })
      await client.query({ type: "sessionDetailSnapshot", sessionIds: ["parent", childId] })
      expect((await client.query({ type: "snapshot" })).rows.map((row) => row.id)).toEqual(["parent"])
      await f.options.state.sessions.updateLabel(childId, { label: "Renamed child", shortLabel: "Renamed child" }, "user")
      await client.query({ type: "sessionDetailSnapshot", sessionIds: [childId] })
      await tree.appendMessage({ kind: "user", content: "Continue", origin: "human" })
      const end = interruptedTurnEnd("person")
      await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "cut"))
      const paused = await client.query({ type: "sessionDetailSnapshot", sessionIds: ["parent"] })
      expect(paused.views[0]?.view?.row.admittedActions).toContain("chat.resume")
      expect(patches.some((patch) => patch.payload.kind === "session_detail.changed" && patch.payload.row?.kind === "chat" && patch.payload.row.admittedActions?.includes("chat.resume"))).toBe(true)
      await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "Continuing." }] })
      const resumed = await client.query({ type: "sessionDetailSnapshot", sessionIds: ["parent"] })
      expect(resumed.views[0]?.view?.row.admittedActions).not.toContain("chat.resume")
      expect(patches.at(-1)?.payload).toMatchObject({ kind: "session_detail.changed", row: { id: "parent" } })
      await stepTree.appendMessage({ kind: "user", content: "Work", origin: "human" })
      await stepTree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "step-cut"))
      const interrupted = await client.query({ type: "sessionDetailSnapshot", sessionIds: [childId] })
      expect(interrupted.views[0]?.view?.row.admittedActions).toContain("chat.resume")
      await stepTree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "Continuing work." }] })
      const continued = await client.query({ type: "sessionDetailSnapshot", sessionIds: [childId] })
      expect(continued.views[0]?.view?.row.admittedActions).not.toContain("chat.resume")
      expect(continued.views[0]?.view?.row.admittedActions).toContain("chat.interrupt")

      const beforeStop = replayWorkflowControl(store.read({ aggregateId: `workflow:${flowId}` }))
      const aborted = transitionWorkflow(replayWorkflow(beforeStop), { type: "ABORT", reason: "The user stopped it before it finished" })
      if (aborted.command.kind !== "commit") throw new Error("Expected abort commit")
      const proposal = aborted.command.proposal
      await manager.commitWorkflow({ workflowId: flowId, events: proposal.facts.map((fact, index) => ({ ...fact, aggregateId: `workflow:${flowId}`, sessionId: flowId, timestamp: 2, ...(index === 0 ? { expectedSeq: proposal.expectedSeq } : {}) })) })
      const stopped = await client.query({ type: "sessionDetailSnapshot", sessionIds: [childId] })
      expect(stopped.views[0]?.view?.row.admittedActions).toEqual(["session.delete"])
      expect(patches.at(-1)?.payload).toMatchObject({ kind: "session_detail.changed", row: { id: childId, admittedActions: ["session.delete"] } })
      const count = patches.length
      f.stored.emit(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] }))
      await client.query({ type: "sessionDetailSnapshot", sessionIds: [childId] })
      expect(patches).toHaveLength(count)
      f.stored.emit([{ id: "tokens", seq: 0, position: 1000, aggregateId: `session:${childId}`, sessionId: childId, actor: "flywheel", timestamp: 2, type: "model.usage.measured", version: 5, payload: {} }])
      await client.query({ type: "sessionDetailSnapshot", sessionIds: [childId] })
      expect(patches).toHaveLength(count)
      f.metadata.delete(childId)
      f.notify({ kind: "deleted", sessionId: childId })
      await client.query({ type: "snapshot" })
      await client.query({ type: "sessionDetailSnapshot", sessionIds: [childId] })
      expect(catalogPatches.filter((patch) => patch.cursor.scope === "session" && patch.cursor.sessionId === childId)).toEqual([])
      expect(f.failures).toEqual([])
    } finally {
      tree.getStorage().dispose()
      stepTree.getStorage().dispose()
      unsubscribe()
      stop()
      await client.close()
      await history.dispose()
      store.close()
    }
  })
  test("metadata replacement and removal share the detail snapshot watermark without equivalent row churn", async () => {
    const f = fixture()
    f.metadata.set("chat", durableRow("chat"))
    let detailReads = 0
    f.options.history.sessionDetail = async ({ sessionId }) => {
      detailReads++
      const metadata = f.metadata.get(sessionId)
      if (!metadata) return { view: null }
      const row = projectSessionCatalogRow(metadata)
      if (row.kind !== "chat") throw new Error("Expected chat detail")
      const view: RuntimeSessionDetailView = {
        id: sessionId, kind: "chat", source: "durable", conversationId: "conv", budget: null,
        row,
        status: { activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected",
          activeSubagentCount: 0, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
          waitingOnBackgroundWork: false, startedAt: 0,
          streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [] },
      }
      return { view }
    }
    const client = createProjectControlClient(f.options)
    const patches: RuntimeUiPatch[] = []
    const unsubscribe = client.subscribe((event) => {
      if (event.type === "patch" && event.patch.cursor.domain === "session_detail") patches.push(event.patch)
    })
    try {
      await client.query({ type: "sessionDetail", sessionId: "chat" })
      await f.options.state.sessions.updateLabel("chat", { label: "Unheld rename", shortLabel: "Unheld rename" }, "user")
      await client.query({ type: "sessionDetailSnapshot", sessionIds: [] })
      expect(detailReads).toBe(1)
      expect(patches).toHaveLength(0)
      await client.query({ type: "sessionDetailSnapshot", sessionIds: ["chat"] })
      await f.options.state.sessions.updateLabel("chat", { label: "Renamed", shortLabel: "Renamed" }, "user")
      const snapshot = await client.query({ type: "sessionDetailSnapshot", sessionIds: ["chat"] })
      expect(snapshot.views[0]?.view?.row.title).toBe("Renamed")
      expect(patches).toHaveLength(1)
      expect(patches[0]?.position).toBe(snapshot.snapshotPosition)
      await f.options.state.sessions.updateLabel("chat", { label: "Renamed", shortLabel: "Renamed" }, "user")
      await client.query({ type: "sessionDetailSnapshot", sessionIds: ["chat"] })
      expect(patches).toHaveLength(1)
      f.metadata.delete("chat")
      f.notify({ kind: "deleted", sessionId: "chat" })
      const removed = await client.query({ type: "sessionDetailSnapshot", sessionIds: ["chat"] })
      expect(removed.views[0]?.view).toBeNull()
      expect(patches.at(-1)?.payload).toEqual({ kind: "session_detail.changed", row: null })
    } finally {
      unsubscribe()
      await client.close()
    }
  })
  test("a child row travels only in session detail: the session domain rejects it, and one message request reaches every kind", () => {
    const dispatch = RuntimeProtocolRpc.requests.get("RuntimeDispatch")
    if (dispatch === undefined) throw new Error("Runtime dispatch RPC is missing")
    const send = { type: "session.send", sessionId: "child-1", input: "Focus on the protocol boundary." } as const
    expect(Schema.decodeUnknownSync(dispatch.payloadSchema)(send)).toEqual(send)
    for (const retired of ["chat.send", "subagent.steer", "workflow.steer"]) {
      expect(() => Schema.decodeUnknownSync(dispatch.payloadSchema)({ ...send, type: retired })).toThrow()
    }

    const row = {
      id: "child-1",
      kind: "subagent",
      title: "Protocol child",
      lifecycleState: "active",
      notices: [],
      inputMode: { kind: "message" },
      admittedActions: ["session.send", "subagent.interrupt", "background.terminate", "session.delete"],
      lastUpdated: "2026-01-01T00:00:00.000Z",
      executionCwd: "/workspace/app",
      totalsLoading: true,
    } as const
    // The catalog lists sessions only (ARCH-PROTOCOL-048): a child row on the session
    // domain is rejected by construction, not filtered by a client.
    const patch = { cursor: { scope: "session", domain: "session", sessionId: row.id }, position: 2, prevPosition: 1, payload: { kind: "session.added", row } } as const
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ ...patch, payload: { kind: "session.updated", row } })).toThrow()
    const workflowRow = { ...row, kind: "workflow", inputMode: { kind: "message" }, admittedActions: ["session.send", "workflow.interrupt", "background.terminate", "session.delete"] }
    for (const kind of ["session.added", "session.updated"]) {
      expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ ...patch, payload: { kind, row: workflowRow } })).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(runtimeQueryResultSchema("snapshot"))({ rows: [workflowRow], activeRuntimeCount: 0, errors: [], snapshotPosition: 0, projectRoot: "/workspace/app", runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "none" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(runtimeQueryResultSchema("snapshot"))({ rows: [row], activeRuntimeCount: 0, errors: [], snapshotPosition: 0, projectRoot: "/workspace/app", runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "none" } })).toThrow()
    // A listed chat admits only chat actions and carries no workflow state.
    const chatRow = { ...row, kind: "chat", inputMode: { kind: "chat" }, admittedActions: ["chat.interrupt", "session.delete"] }
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ ...patch, payload: { kind: "session.added", row: chatRow } })).toMatchObject({ payload: { row: chatRow } })
    for (const actions of [["session.send", "session.delete"], ["background.terminate"]]) {
      expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ ...patch, payload: { kind: "session.added", row: { ...chatRow, admittedActions: actions } } })).toThrow()
    }
    const listed = Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ ...patch, payload: { kind: "session.added", row: { ...chatRow, workflowState: "running" } } })
    expect(listed.payload).not.toHaveProperty("row.workflowState")

    const detail = {
      view: {
        source: "durable", id: row.id, kind: "subagent", conversationId: "conv-child", budget: null, row,
        status: {
          activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0,
          activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false,
          startedAt: 1, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
        },
      },
    }
    expect(Schema.decodeUnknownSync(runtimeQueryResultSchema("sessionDetail"))(detail)).toEqual(detail)
    const replacement = { ...patch, cursor: { ...patch.cursor, domain: "session_detail" }, payload: { kind: "session_detail.changed", row } } as const
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(replacement)).toEqual(replacement)
    const removed = { ...replacement, payload: { kind: "session_detail.changed", row: null } } as const
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(removed)).toEqual(removed)
    const snapshot = { snapshotPosition: 2, views: [{ sessionId: row.id, view: detail.view }] }
    expect(Schema.decodeUnknownSync(runtimeQueryResultSchema("sessionDetailSnapshot"))(snapshot)).toEqual(snapshot)
    expect(() => Schema.decodeUnknownSync(runtimeQueryResultSchema("sessionDetail"))({ view: { ...detail.view, row: { ...row, inputMode: { kind: "chat" } } } })).toThrow()
  })

  test("session.activate, workflow.resume, and workflow.restart decode, and a refusal carries no message instruction", () => {
    const dispatch = RuntimeProtocolRpc.requests.get("RuntimeDispatch")
    if (dispatch === undefined) throw new Error("Runtime dispatch RPC is missing")

    for (const command of [{ type: "session.activate", sessionId: "chat-1" }, { type: "workflow.resume", workflowId: "wf-1" }, { type: "workflow.restart", workflowId: "wf-1" }] as const) {
      expect(Schema.decodeUnknownSync(dispatch.payloadSchema)(command)).toEqual(command)
    }
    const refusal = { ok: false, error: "Restart runs it again from its recorded request." }
    expect(Schema.decodeUnknownSync(dispatch.successSchema)(refusal)).toEqual(refusal)
  })
})

describe("session runtime actor command contract", () => {
  test("question settlement, background termination, and chat.compact classify as ordered mailbox commands", () => {
    for (const tag of ["question.answer", "question.cancel", "background.terminate", "chat.compact"] as const) {
      const route = classifyChatMutation(tag)
      expect(route.category).toBe("ordered")
      if (route.category === "ordered") expect(route.mutation.kind).toBe(tag)
    }
  })

  test("chat.open, session.fork, and session.activate classify as supervisor commands", () => {
    for (const tag of ["chat.open", "session.fork", "session.activate"] as const) {
      const route = classifyChatMutation(tag)
      expect(route.category).toBe("supervisor")
      if (route.category === "supervisor") expect(route.kind).toBe(tag)
    }
  })

  test("session.close, session.delete, and session.discard_transient classify as lifecycle commands with synchronous markClosing preflight", () => {
    for (const tag of ["session.close", "session.delete", "session.discard_transient"] as const) {
      const route = classifyChatMutation(tag)
      expect(route.category).toBe("lifecycle")
      // The markClosing preflight is the type-checked metadata every lifecycle
      // command must carry before any ordered queue wait.
      if (route.category === "lifecycle") expect(route.mutation.preflight).toBe("markClosing")
    }
  })

  test("chat.interrupt and bash.detach classify as preemptive signals that never enter the ordered mailbox", () => {
    const interrupt = classifyChatMutation("chat.interrupt")
    expect(interrupt.category).toBe("preemptive")
    if (interrupt.category === "preemptive") expect(interrupt.signal.kind).toBe("interrupt-current-turn")

    const detach = classifyChatMutation("bash.detach")
    expect(detach.category).toBe("preemptive")
    if (detach.category === "preemptive") expect(detach.signal.kind).toBe("release-foreground-bash")
  })

  test("session.reorder classifies as out-of-actor session-list behavior", () => {
    const route = classifyChatMutation("session.reorder")
    expect(route.category).toBe("out-of-actor")
  })
})
