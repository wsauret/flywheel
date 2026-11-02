import { expect, test } from "bun:test"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { legacyWorkflowFixture } from "../../../helpers/workflow-agent-legacy-fixtures.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { convertWorkflowAgentSessions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-agent-sessions.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership.js"
import { readWorkflowUsage } from "../../../../src/orchestration/workflow-host/member-totals.js"
import { Database } from "bun:sqlite"
import { recoverSessionMetadata } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { readSubagentRuns } from "../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { createHash } from "node:crypto"
import { readConversationSnapshotSync } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { buildSessionContent, type SessionContentNodeRow } from "../../../../src/infra/session-content.js"

const temporary = temporaryDirectories()
const contentRow = (content: string) => ({ sha256: createHash("sha256").update(content).digest("hex"), content, bytes: Buffer.byteLength(content) })

test("conversion transfers linked execution units and held input without altering their raw evidence, leaving indivisible usage residual", async () => {
  const root = temporary("workflow-execution-transfer-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const f = legacyWorkflowFixture(root)
  f.store.append({ aggregateId: "session:old", sessionId: "old", type: "prompt.assembled", version: 2, actor: "flywheel", timestamp: 1,
    payload: JSON.parse('{"requestId":"request-one","conversationId":"old-provider-key","turn":1,"promptKind":"workflow-agent","systemPromptHash":"system","toolSurfaceHash":"surface","promptSha256":"prompt","messageCount":1,"estimatedContextTokens":100,"contextWindow":1000,"treePointer":{"conversationId":"generation-one","leafEntryId":null}}') })
  const question = f.store.append({ aggregateId: "session:old", sessionId: "old", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 2,
    payload: JSON.parse('{"interactionId":"question-one","conversationId":"generation-one","toolUseId":"ask-one","request":[]}') })
  const damaged = f.store.append({ aggregateId: "session:old", sessionId: "old", type: "agent_input.answered", version: 3, actor: "user", timestamp: 3,
    payload: JSON.parse('{"interactionId":"question-one","damagedAnswer":"retained bytes"}') })
  f.store.append({ aggregateId: "session:old", sessionId: "old", type: "tool.input.completed", version: 1, actor: "agent", timestamp: 3,
    payload: JSON.parse('{"toolUseId":"parent-question","toolName":"message_session","input":{"to":"parent","text":"Question","wait":true},"inputBytes":1,"inputSha256":"hash","inputPreview":"question","executionMode":"foreground","traceKind":"tool","childHasOwnViewport":false,"modelRequestId":"request-one"}') })
  f.store.append({ aggregateId: "session:old", sessionId: "old", type: "model.usage.measured", version: 3, actor: "provider", timestamp: 4,
    payload: JSON.parse('{"totalCostUsd":0.1,"billedCostUsd":0.1,"inputTokens":10,"outputTokens":5,"cacheReadTokens":0,"cacheCreateTokens":0,"reasoningTokens":0,"budgetStreamId":"shared"}') })
  f.store.append({ aggregateId: "session:old", sessionId: "old", type: "model.usage.measured", version: 3, actor: "provider", timestamp: 5,
    payload: JSON.parse('{"totalCostUsd":0.15,"billedCostUsd":0.15,"inputTokens":20,"outputTokens":8,"cacheReadTokens":0,"cacheCreateTokens":0,"reasoningTokens":0,"budgetStreamId":"shared"}') })
  f.store.putInFlight("old", "chat.queued_user_input", "held-human", JSON.parse('{"conversationId":"generation-one","text":"still pending","origin":"human"}'))
  f.store.putInFlight("old", "session.planned_continuation", "old", JSON.parse('{"version":2,"sessionId":"old","kind":"workflow","handoffId":"planned-handoff"}'))
  f.store.putInFlight("old", "usage.settlement", "wire-attempt", JSON.parse('{"state":"pending","attemptId":"wire-attempt","requestId":"request-one","profileId":"Personal","budgetStreamId":"usage-stream","identity":{"providerSessionKey":"provider-key","conversationId":"generation-one"},"turn":1}'))
  f.store.putInFlight("old", "session.command_handover", "process-one", JSON.parse('{"version":1,"handoffId":"handoff-one","sessionId":"old","conversationId":"generation-one","processId":"process-one","pid":123,"description":"kept command","logPath":"/scratch/log","recordPath":"/scratch/record","channel":"channel","token":"fixture-token","startedAtMs":1,"deadlineAtMs":1000,"kept":true}'))
  f.store.putInFlight("old", "session.reply_wait", "parent:parent-question", JSON.parse('{"openedAtMs":1,"readKey":"msg:old:parent-question"}'))
  f.store.putInFlight("old", "chat.queued_user_input", "msg:parent:answer", JSON.parse('{"target":"workflow","text":"Private answer","producer":{"kind":"session","sessionId":"parent","conversationId":"parent-conversation","toolUseId":"answer","hop":1}}'))
  f.store.append({ aggregateId: "session:old", sessionId: "old", type: "file.changed", version: 3, actor: "flywheel", timestamp: 6,
    payload: { ...JSON.parse('{"mutationId":"mutation-one","operationId":"operation-one","path":"/scratch/test","displayPath":"test","changeKind":"created","before":null,"origin":{"kind":"tool_call","toolUseId":"parent-question"}}'),
      after: { bytes: 1, sha256: createHash("sha256").update("x").digest("hex"), preview: "x" } } })
  f.store.putInFlight("old", "file.mutation", "operation-one", { version: 3, operationId: "operation-one", damaged: "retained plan" })
  f.store.append({ aggregateId: "session:nested", sessionId: "nested", timestamp: 7, actor: "flywheel", type: "session.created", version: 5,
    payload: JSON.parse('{"kind":"subagent","command":"subagent","conversationId":"nested-conversation","label":"Nested","lifecycleState":"inactive","lastUpdated":"2026-10-16T00:00:00.000Z","executionCwd":"/scratch/work","launchedFrom":{"parentSessionId":"old","conversationId":"generation-one","toolUseId":"nested-call"}}') })
  const binding = f.store.append({ aggregateId: "session:nested", sessionId: "nested", timestamp: 8, actor: "flywheel", type: "child_run.created", version: 2,
    payload: JSON.parse('{"childSessionId":"nested","childRunId":"nested-run","conversationId":"nested-conversation","parentSessionId":"old","parentConversationId":"generation-one","parentToolCallId":"nested-call","persona":{"name":"general","kind":"general"},"capabilityGrant":{"operation":"subagent","required":[],"capabilities":[],"moduleIds":[],"requireWorkflowConfirmation":false,"workflowsMode":"on","identity":"original-grant"},"admittedModuleIds":[],"skillsRevision":1,"model":"fixture-model","tools":[],"executionCwd":"/scratch/work","budget":{"maxTurns":10,"maxTokens":1000},"parentDepth":0,"description":"Nested work"}') })
  const nestedResult = contentRow("Nested child result")
  const nestedOwnContent = contentRow("Nested session content")
  const nestedResultEvent = f.store.append({ aggregateId: "session:old", sessionId: "old", type: "tool.result.recorded", version: 1, actor: "flywheel", timestamp: 8,
    contentRows: [nestedResult],
    payload: { toolUseId: "nested-call", outcome: "ok", contentBytes: nestedResult.bytes, contentSha256: nestedResult.sha256, contentPreview: "Nested result preview", contentTruncated: false } })
  f.store.append({ aggregateId: "session:nested", sessionId: "nested", type: "tool.result.recorded", version: 1, actor: "flywheel", timestamp: 8,
    contentRows: [nestedOwnContent],
    payload: { toolUseId: "nested-own-call", outcome: "ok", contentBytes: nestedOwnContent.bytes, contentSha256: nestedOwnContent.sha256, contentPreview: "Nested content preview", contentTruncated: false } })
  const db = new Database(f.dbFile)
  const damagedOutput = f.store.append({ aggregateId: "session:old", sessionId: "old", parentEventId: question.id, timestamp: 9, actor: "agent", type: "tool.execution_output.recorded", version: 1, payload: {} })
  db.query("update event set payload = ? where id = ?").run("{", damagedOutput.id)
  const content = "Retained tool result"
  const sha256 = createHash("sha256").update(content).digest("hex")
  f.store.append({ aggregateId: "conversation:generation-one", sessionId: "old", type: "chat.entries.appended", version: 2, actor: "flywheel", timestamp: 10,
    contentRows: [{ sha256, content, bytes: Buffer.byteLength(content) }],
    payload: { conversationId: "generation-one", entries: [
      { id: "tool-call", kind: "message", parentId: null, timestamp: "2026-10-16T00:00:00.000Z", message: {
        kind: "assistant", content: [
          { type: "tool_use", id: "parent-question", name: "message_session", input: { to: "parent", text: "Question", wait: true } },
          { type: "tool_use", id: "nested-call", name: "subagent", input: { persona: "general", prompt: "Nested work" } },
        ],
      } },
      { id: "referenced-result", kind: "message", parentId: "tool-call", timestamp: "2026-10-16T00:00:00.000Z", message: {
      kind: "toolResult", toolUseId: "parent-question", content: [{ type: "text_reference", sha256, bytes: Buffer.byteLength(content), preview: content }],
    } }] } })
  const raw = db.query<{ id: string; payload: string; position: number }, []>("select id, payload, position from event where type in ('agent_input.requested', 'agent_input.answered') order by position").all()
  try {
    expect(readConversationSnapshotSync(f.store, "generation-one").entriesById["referenced-result"]).toMatchObject({ message: { content: [{ type: "text", text: content }] } })
    const before = await readWorkflowUsage(asAsyncEventReadSurface(f.store), "old")
    // No run registration exists yet, so the exact old cumulative result is asserted after conversion.
    expect(before.policy.totalInputTokens).toBe(0)
    expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(1)
    const members = await workflowMembershipReader(asAsyncEventReadSurface(f.store)).list("old")
    const member = members.find(row => row.conversationId === "generation-one")!
    expect(f.store.read({ aggregateId: `session:${member.sessionId}`, types: ["agent_input.requested", "agent_input.answered"] }).map(row => row.id)).toEqual([question.id, damaged.id])
    expect(db.query("select id, payload, position from event where type in ('agent_input.requested', 'agent_input.answered') order by position").all()).toEqual(raw)
    expect(f.store.readInFlight(member.sessionId, "chat.queued_user_input").find(row => row.key === "held-human")).toMatchObject({ payload: { text: "still pending" } })
    expect(f.store.readInFlight("old", "chat.queued_user_input")).toEqual([])
    expect(f.store.readInFlight("old", "session.planned_continuation")[0]?.payload).toEqual({ version: 3, target: { kind: "workflow", workflowId: "old" }, handoffId: "planned-handoff" })
    expect(f.store.readInFlight(member.sessionId, "usage.settlement")[0]?.payload).toMatchObject({ attemptId: "wire-attempt", profileId: "Personal", budgetStreamId: "usage-stream" })
    expect(f.store.readInFlight(member.sessionId, "session.command_handover")[0]?.payload).toMatchObject({ sessionId: member.sessionId, processId: "process-one", logPath: "/scratch/log", kept: true })
    expect(f.store.readInFlight(member.sessionId, "session.reply_wait")).toMatchObject([{ key: "parent:parent-question", payload: { readKey: "msg:old:parent-question" } }])
    expect(f.store.readInFlight(member.sessionId, "chat.queued_user_input").find(row => row.key === "msg:parent:answer")?.payload).toMatchObject({ conversationId: "generation-one", text: "Private answer" })
    expect(f.store.readInFlight(member.sessionId, "file.mutation")).toMatchObject([{ key: "operation-one", payload: { damaged: "retained plan" } }])
    expect(recoverSessionMetadata(f.store, "nested")?.launchedFrom?.parentSessionId).toBe(member.sessionId)
    expect((await readSubagentRuns(asAsyncEventReadSurface(f.store), "nested"))[0]).toMatchObject({ parentSessionId: member.sessionId, parentConversationId: "generation-one", executionCwd: "/scratch/work", capabilityGrant: { identity: "original-grant" } })
    expect(f.store.read({ aggregateId: "session:nested", types: ["child_run.created"] })[0]).toEqual(binding)
    const movedNestedResult = f.store.read({ aggregateId: `session:${member.sessionId}`, types: ["tool.result.recorded"] }).find(row => row.id === nestedResultEvent.id)!
    expect(movedNestedResult.payload.contentSha256).toBe(nestedResult.sha256)
    expect(f.store.toolContent.resolve(member.sessionId, nestedResult.sha256)).toBe(nestedResult.content)
    expect(f.store.toolContent.resolve("nested", nestedOwnContent.sha256)).toBe(nestedOwnContent.content)
    expect(db.query("select payload, session_id from event where id = ?").get(damagedOutput.id)).toEqual({ payload: "{", session_id: member.sessionId })
    expect(readConversationSnapshotSync(f.store, "generation-one").entriesById["referenced-result"]).toMatchObject({ message: { content: [{ type: "text", text: content }] } })
    const usage = await readWorkflowUsage(asAsyncEventReadSurface(f.store), "old")
    expect(usage.policy).toMatchObject({ totalCost: 0.15, totalInputTokens: 20, totalOutputTokens: 8 })
    expect(usage.display).toEqual(usage.policy)
  } finally { db.close(); f.store.close() }
})

test("conversion gives each generation only the content closure its moved rows reach, including children named by a damaged payload", async () => {
  const root = temporary("workflow-content-closure-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const f = legacyWorkflowFixture(root)
  const db = new Database(f.dbFile)
  try {
    const nodes: SessionContentNodeRow[] = []
    // Larger than one node, so the root is an index whose leaves are reachable only through it.
    const manifest = await buildSessionContent("x".repeat(200_000), async rows => { nodes.push(...rows) })
    f.store.stageSessionContentNodes("old", nodes)
    const [first, second, unreferenced] = [contentRow("first result"), contentRow("second result"), contentRow("residual only")]
    for (const [conversationId, toolUseId, row] of [["generation-one", "call-one", first], ["generation-two", "call-two", second]] as const) {
      f.store.append({ aggregateId: `conversation:${conversationId}`, sessionId: "old", type: "chat.entries.appended", version: 2, actor: "flywheel", timestamp: 1,
        payload: { conversationId, entries: [{ id: `${toolUseId}-entry`, kind: "message", parentId: null, timestamp: "2026-10-16T00:00:00.000Z", message: {
          kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "bash", input: { command: "true" } }],
        } }] } })
      f.store.append({ aggregateId: "session:old", sessionId: "old", type: "tool.result.recorded", version: 1, actor: "flywheel", timestamp: 2, contentRows: [row],
        payload: { toolUseId, outcome: "ok", contentBytes: row.bytes, contentSha256: row.sha256, contentPreview: row.content, contentTruncated: false } })
    }
    const call = f.store.append({ aggregateId: "session:old", sessionId: "old", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 3,
      payload: JSON.parse('{"interactionId":"question-one","conversationId":"generation-one","toolUseId":"call-one","request":[]}') })
    f.store.append({ aggregateId: "session:old", sessionId: "old", parentEventId: call.id, type: "tool.execution_output.recorded", version: 1, actor: "agent", timestamp: 4,
      payload: { damaged: { manifestRoot: manifest.root } } })
    f.store.append({ aggregateId: "session:old", sessionId: "old", type: "tool.result.recorded", version: 1, actor: "flywheel", timestamp: 5, contentRows: [unreferenced],
      payload: { toolUseId: "unowned-call", outcome: "ok", contentBytes: unreferenced.bytes, contentSha256: unreferenced.sha256, contentPreview: unreferenced.content, contentTruncated: false } })
    const scope = (sessionId: string) => db.query<{ sha256: string }, [string]>("select sha256 from tool_content where session_id = ? order by sha256").all(sessionId).map(row => row.sha256)
    const source = scope("old")

    expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(1)

    const members = await workflowMembershipReader(asAsyncEventReadSurface(f.store)).list("old")
    const owner = (conversationId: string) => members.find(row => row.conversationId === conversationId)!.sessionId
    expect(scope(owner("generation-one"))).toEqual([first.sha256, ...nodes.map(node => node.sha256)].toSorted())
    expect(scope(owner("generation-two"))).toEqual([second.sha256])
    expect(scope("old")).toEqual(source)
    expect(f.store.toolContent.resolve(owner("generation-one"), first.sha256)).toBe(first.content)
  } finally { db.close(); f.store.close() }
})
