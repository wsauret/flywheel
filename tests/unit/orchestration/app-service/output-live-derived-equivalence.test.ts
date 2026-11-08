import { describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { parseProjectionFact } from "../../../../src/infra/event-projection.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStoreAppend, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { projectFrontendOutputBlocks } from "../../../../src/orchestration/app-service/frontend-output-blocks.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createOutputSession } from "../../../../src/orchestration/runner/output-session.js"
import { createSessionMetadataProjection } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { parseSessionMetadataFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { parseConversationTreeFact, salvageConversationTreeFact } from "../../../../src/orchestration/session/conversation/conversation-facts.js"
import { readToolResultDisplayMeta } from "../../../../src/orchestration/session/conversation/tool-result-meta.js"
import { parseSessionRuntimeFact } from "../../../../src/orchestration/session/session-runtime-event-types.js"
import { loadSubagentRunsFromEvents } from "../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { readSubagentRunsByToolUseId } from "../../../../src/orchestration/modules/subagents/history/subagent-history.js"
import { enforceTurnBudget } from "../../../../src/orchestration/agent-runtime/compaction/truncation.js"
import { turnBudgetChars } from "../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import type { WorkflowView } from "../../../../src/workflows/view/types.js"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { corpusProjectDir, strictProjectionAgreementFixtures, tolerantReprojectionFixtures } from "../../../fixtures/tolerant-reprojection-fixtures.js"
import { assertOutputBlocksEquivalent, outputSeamBlocks } from "../runner/_output-session-fixtures.js"
import { plainAgentTree } from "../../../helpers/workflow-view.js"
import { buildMutationDiffEvidence } from "../../../../src/infra/mutation-diff-evidence.js"
import { tailRequest } from "./_output-projection-fixtures.js"

// Edit diffs reach the live stream in the tool result `details` and the durable
// side in the matching `tool.result.recorded` fact. Kept under the 20-hunk-line
// preview budget so the wire ships it whole on both sides.
const editDiff = [
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,1 +1,1 @@",
  "-export const value = 1",
  "+export const value = 2",
].join("\n")
const fileMutation = {
  version: 1 as const,
  files: [{ path: "src/example.ts", change: "modified" as const, unifiedDiff: editDiff }],
  omissions: [],
}

type JsonScalar = string | number | boolean | null | undefined
interface JsonObject { [key: string]: JsonValue }
type JsonValue = JsonScalar | JsonObject | JsonValue[]

/** Both sides are compared as the JSON they serialize to, which is what the
 *  wire and the store carry; a route converts its typed value at this boundary. */
function asJson(value: unknown): JsonValue {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

interface StrictAgreementRoute {
  owningDirectStrictParser(event: StoredFact): JsonValue
  productionProjectionBoundary(event: StoredFact, store: ReturnType<typeof createSqliteEventStore>): Promise<JsonValue>
}

interface StrictAgreementRoutes {
  session_metadata: StrictAgreementRoute
  chat_tree: StrictAgreementRoute
}

const strictAgreementFamilies = ["session_metadata", "chat_tree"] as const

const strictAgreementRoutes: StrictAgreementRoutes = {
  session_metadata: {
    owningDirectStrictParser: (event: StoredFact) => asJson(parseSessionMetadataFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload }).payload),
    productionProjectionBoundary: async (event: StoredFact, store: ReturnType<typeof createSqliteEventStore>) => asJson((await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()).sessions[event.sessionId]),
  },
  chat_tree: {
    owningDirectStrictParser: (event: StoredFact) => asJson(parseConversationTreeFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload }).payload),
    productionProjectionBoundary: async (event: StoredFact, store: ReturnType<typeof createSqliteEventStore>) => {
      const state = await createConversationTreeProjection(asAsyncEventReadSurface(store), event.aggregateId.slice("conversation:".length)).replay()
      return { conversationId: state.conversationId, createdAt: state.createdAt }
    },
  },
}

function assertStrictProjectionAgreement(caseId: string, family: string, identity: string, direct: JsonValue, production: JsonValue): void {
  const firstDifferingPath = firstDifferingJsonPath(direct, production)
  if (firstDifferingPath !== null) throw new Error(`case=${caseId} kind=${family} identity=${identity} firstDifferingField=${firstDifferingPath}`)
}

function firstDifferingJsonPath(left: JsonValue, right: JsonValue, path = "$" ): string | null {
  if (Object.is(left, right)) return null
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${path}.length`
    for (let index = 0; index < left.length; index++) {
      const difference = firstDifferingJsonPath(left[index], right[index], `${path}.${index}`)
      if (difference !== null) return difference
    }
    return null
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    for (const key of keys) {
      const difference = firstDifferingJsonPath(left[key] ?? null, right[key] ?? null, `${path}.${key}`)
      if (difference !== null) return difference
    }
    return null
  }
  return path
}

const DECORATION_SESSION_ID = "strict-decoration"
const DECORATION_WORKER_TIME = "2026-01-01T00:00:00.000Z"

function appendStrictDecorationFixtures(store: ReturnType<typeof createSqliteEventStore>, executionCwd: string): WorkflowView {
  const base = { aggregateId: `session:${DECORATION_SESSION_ID}`, sessionId: DECORATION_SESSION_ID, actor: "flywheel" as const }
  const events = [
    { ...base, timestamp: 1, type: "session.created", version: 5, payload: { kind: "workflow", command: "workflow", workflowDefinitionId: "workflow", label: "Request", name: "Request", lastUpdated: DECORATION_WORKER_TIME, executionCwd, lifecycleState: "inactive" } },
    { ...base, timestamp: 2, type: "tool.result.recorded", version: 1, payload: { toolUseId: "tool", outcome: "ok", details: { diff: "-a\n+b", filetype: "text" } } },
    { ...base, timestamp: 3, type: "tool.execution_output.recorded", version: 1, payload: { toolUseId: "tool", output: "output" } },
    { ...base, timestamp: 3, type: "tool.result.recorded", version: 3, payload: { toolUseId: "current", outcome: "ok" } },
    { ...base, timestamp: 3, type: "tool.execution_output.recorded", version: 3, payload: { toolUseId: "current", output: "current output" } },
    { ...base, timestamp: 4, type: "child_run.created", version: 1, payload: { childRunId: "completed", kind: "subagent", toolUseId: "dispatch-completed", agentType: "explorer", description: "find", model: "test", maxTurns: 1, tools: [] } },
    { ...base, timestamp: 5, type: "subagent.prompted", version: 3, payload: { childRunId: "completed", prompt: "find", task: "inspect", toolNames: [] } },
    { ...base, timestamp: 6, type: "subagent.completed", version: 1, payload: { childRunId: "completed", status: "completed", isError: false, durationMs: 1, resultBytes: 1, resultSha256: "sha", resultPreview: "done" } },
    { ...base, timestamp: 7, type: "child_run.created", version: 1, payload: { childRunId: "interrupted", kind: "subagent", toolUseId: "dispatch-interrupted", agentType: "explorer", description: "find", model: "test", maxTurns: 1, tools: [] } },
    { ...base, timestamp: 8, type: "subagent.interrupted", version: 1, payload: { childRunId: "interrupted", reason: "runtime_restarted", recoveryId: "recovery" } },
    { ...base, timestamp: 9, type: "session.child.linked", version: 1, payload: { childSessionId: "durable-v2", lastUpdated: DECORATION_WORKER_TIME } },
    { ...base, aggregateId: "session:durable-v2", sessionId: "durable-v2", timestamp: 10, type: "child_run.created", version: 2, payload: {
      childSessionId: "durable-v2", childRunId: "durable-v2", conversationId: "conversation-v2",
      parentSessionId: DECORATION_SESSION_ID, parentConversationId: "workflow-conversation", parentToolCallId: "dispatch-v2",
      persona: { name: "explorer", kind: "persona" }, capabilityGrant: {
        operation: "subagent", required: [], capabilities: [], moduleIds: [],
        requireWorkflowConfirmation: false, workflowsMode: "off", identity: "durable-v2",
      },
      admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd,
      budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "find",
    } },
    { ...base, aggregateId: "session:durable-v2", sessionId: "durable-v2", timestamp: 11, type: "subagent.completed", version: 2, payload: {
      childRunId: "durable-v2", status: "completed", isError: false, durationMs: 1,
      result: "done", resultBytes: 4, resultSha256: "sha-v2", resultPreview: "done",
    } },
    { ...base, aggregateId: "session:durable-v2", sessionId: "durable-v2", timestamp: 11, type: "child_run.ownership.recovered", version: 1, payload: {
      childRunId: "durable-v2", parentSessionId: DECORATION_SESSION_ID, parentConversationId: "workflow-conversation",
    } },
    { ...base, timestamp: 12, type: "session.child.linked", version: 1, payload: { childSessionId: "durable-v3", lastUpdated: DECORATION_WORKER_TIME } },
    { ...base, aggregateId: "session:durable-v3", sessionId: "durable-v3", timestamp: 13, type: "child_run.created", version: 2, payload: {
      childSessionId: "durable-v3", childRunId: "durable-v3", conversationId: "conversation-v3",
      parentSessionId: DECORATION_SESSION_ID, parentConversationId: "workflow-conversation", parentToolCallId: "dispatch-v3",
      persona: { name: "explorer", kind: "persona" }, capabilityGrant: {
        operation: "subagent", required: [], capabilities: [], moduleIds: [],
        requireWorkflowConfirmation: false, workflowsMode: "off", identity: "durable-v3",
      },
      admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd,
      budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "find",
    } },
    { ...base, aggregateId: "session:durable-v3", sessionId: "durable-v3", timestamp: 14, type: "subagent.resumed", version: 1, payload: { childRunId: "durable-v3", authorizationId: "resume-v3", continuation: 1 } },
    { ...base, aggregateId: "session:durable-v3", sessionId: "durable-v3", timestamp: 15, type: "subagent.completed", version: 3, payload: {
      childRunId: "durable-v3", status: "completed", isError: false, durationMs: 1,
      result: "done", resultBytes: 4, resultSha256: "sha-v3", resultPreview: "done",
    } },
    { ...base, timestamp: 16, type: "session.child.linked", version: 1, payload: { childSessionId: "durable-v4", lastUpdated: DECORATION_WORKER_TIME } },
    { ...base, aggregateId: "session:durable-v4", sessionId: "durable-v4", timestamp: 17, type: "child_run.created", version: 2, payload: {
      childSessionId: "durable-v4", childRunId: "durable-v4", conversationId: "conversation-v4",
      parentSessionId: DECORATION_SESSION_ID, parentConversationId: "workflow-conversation", parentToolCallId: "dispatch-v4",
      persona: { name: "explorer", kind: "persona" }, capabilityGrant: {
        operation: "subagent", required: [], capabilities: [], moduleIds: [],
        requireWorkflowConfirmation: false, workflowsMode: "off", identity: "durable-v4",
      },
      admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd,
      budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "find",
    } },
    // Version 4 added `partial`.
    { ...base, aggregateId: "session:durable-v4", sessionId: "durable-v4", timestamp: 18, type: "subagent.completed", version: 4, payload: {
      childRunId: "durable-v4", status: "partial", isError: false, durationMs: 1,
      result: "done", resultBytes: 4, resultSha256: "sha-v4", resultPreview: "done",
    } },
    { ...base, timestamp: 18, type: "session.child.linked", version: 1, payload: { childSessionId: "durable-v5", lastUpdated: DECORATION_WORKER_TIME } },
    { ...base, aggregateId: "session:durable-v5", sessionId: "durable-v5", timestamp: 18, type: "child_run.created", version: 2, payload: {
      childSessionId: "durable-v5", childRunId: "durable-v5", conversationId: "conversation-v5",
      parentSessionId: DECORATION_SESSION_ID, parentConversationId: "workflow-conversation", parentToolCallId: "dispatch-v5",
      persona: { name: "explorer", kind: "persona" }, capabilityGrant: {
        operation: "subagent", required: [], capabilities: [], moduleIds: [],
        requireWorkflowConfirmation: false, workflowsMode: "off", identity: "durable-v5",
      },
      admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd,
      budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "find",
    } },
    // Version 5 is the current completion writer; `stopped` is the status it
    // added, for a run a person ended with Stop.
    { ...base, aggregateId: "session:durable-v5", sessionId: "durable-v5", timestamp: 18, type: "subagent.completed", version: 5, payload: {
      childRunId: "durable-v5", status: "stopped", isError: true, durationMs: 1,
      result: "stopped", resultBytes: 7, resultSha256: "sha-v5", resultPreview: "stopped",
    } },
    { ...base, timestamp: 19, type: "session.child.linked", version: 1, payload: { childSessionId: "durable-paused", lastUpdated: DECORATION_WORKER_TIME } },
    { ...base, aggregateId: "session:durable-paused", sessionId: "durable-paused", timestamp: 20, type: "child_run.created", version: 3, payload: {
      childSessionId: "durable-paused", childRunId: "durable-paused", conversationId: "conversation-paused",
      parentSessionId: DECORATION_SESSION_ID, parentConversationId: "workflow-conversation", parentToolCallId: "dispatch-paused",
      persona: { name: "explorer", kind: "persona" }, capabilityGrant: {
        operation: "subagent", required: [], capabilities: [], moduleIds: [],
        requireWorkflowConfirmation: false, workflowsMode: "off", identity: "durable-paused",
      },
      admittedModuleIds: [], skillsRevision: 0, tools: [], executionCwd,
      budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "find",
    } },
    // A pause holds a `created` durable run at its save point and names who paused it.
    { ...base, aggregateId: "session:durable-paused", sessionId: "durable-paused", timestamp: 21, type: "subagent.paused", version: 1, payload: { childRunId: "durable-paused", pausedBy: "person" } },
    { ...base, timestamp: 22, type: "workflow.worker_boundary.recorded", version: 1, payload: { data: { type: "workflow.worker_boundary.recorded", timestamp: DECORATION_WORKER_TIME, sessionId: DECORATION_SESSION_ID, stepId: "step" } } },
    { ...base, timestamp: 22, type: "workflow.worker_boundary.recorded", version: 2, payload: { data: { attemptId: "step", timestamp: DECORATION_WORKER_TIME } } },
  ] satisfies EventStoreAppend[]
  store.appendBatch(events)
  const attempts = [{ id: "step", definitionId: "step", briefId: "step", workflowDefinitionId: "workflow", name: "Step", status: "completed", writes: [], resumeRevertCount: 0 }] as const
  return { attempts, tree: plainAgentTree(attempts), cursor: 1, status: "completed", mutationLog: [] }
}
describe("live/derived output equivalence", () => {
  for (const family of strictAgreementFamilies) {
    const fixture = strictProjectionAgreementFixtures[family]
    it(`agrees across owning direct strict parser and production projection for ${fixture.fixtureId}`, async () => {
      expect(fixture.equivalence.kind).toBe("equivalent")
      for (const rejected of Object.values(fixture.strictRejectedFixtures)) expect(rejected.equivalence.kind).toBe("non_equivalent")
      const tmpDir = mkdtempSync(join(tmpdir(), `flywheel-strict-agreement-${family}-`))
      const store = createSqliteEventStore(join(tmpDir, "flywheel.sqlite"))
      try {
        const aggregateId = family === "chat_tree" ? "conversation:strict-conversation" : "session:strict-session"
        store.append({ aggregateId, sessionId: "strict-session", timestamp: 1, ...fixture.fact, payload: JSON.parse(fixture.fact.payloadBytes), payloadJson: fixture.fact.payloadBytes })
        const [stored] = store.read({ aggregateId })
        if (!stored) throw new Error(`missing stored fact for ${fixture.fixtureId}`)
        const routes = strictAgreementRoutes[family]
        const direct = routes.owningDirectStrictParser(stored)
        const production = await routes.productionProjectionBoundary(stored, store)
        assertStrictProjectionAgreement(fixture.fixtureId, family, fixture.fixtureId, direct, production)
      } finally {
        store.close()
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })

  }

  it("keeps strict and salvage chat-tree results identical for a strict-valid fixture", () => {
    const fixture = strictProjectionAgreementFixtures.chat_tree.fact
    const envelope = { type: fixture.type, version: fixture.version, actor: fixture.actor, payload: JSON.parse(fixture.payloadBytes) }
    const strict = parseConversationTreeFact(envelope)
    expect(salvageConversationTreeFact(envelope)).toEqual({ kind: "recovered", fact: strict })
  })

  it("keeps strict and historical decoration readers aligned for every registered descriptor", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-decoration-agreement-"))
    const store = createSqliteEventStore(join(tmpDir, "flywheel.sqlite"))
    try {
      appendStrictDecorationFixtures(store, realpathSync(tmpDir))
      store.append({ aggregateId: `session:${DECORATION_SESSION_ID}`, sessionId: DECORATION_SESSION_ID, timestamp: 23, actor: "workflow", type: "workflow.step.started", version: 1, payload: { data: { label: "Step" } } })

      const events = store.read().filter((event) => event.type !== "session.created" && event.type !== "session.child.linked")
      const descriptors = [...new Set(events.map(({ type, version }) => `${type}@${version}`))].sort()
      expect(descriptors).toEqual(tolerantReprojectionFixtures.decorations.descriptors.map(({ type, version }) => `${type}@${version}`).sort())

      const toolEvents = events.filter((event) => event.type.startsWith("tool."))
      for (const event of toolEvents) expect(() => parseProjectionFact(event, parseSessionRuntimeFact)).not.toThrow()
      expect(await readToolResultDisplayMeta(asAsyncEventReadSurface(store), DECORATION_SESSION_ID)).toEqual(new Map([
        ["tool", { diff: "-a\n+b", filetype: "text", executionOutput: "output" }],
        ["current", { executionOutput: "current output" }],
      ]))

      const subagentEvents = events.filter((event) => event.type.startsWith("subagent.") || event.type === "child_run.created")
      const strictRuns = loadSubagentRunsFromEvents(subagentEvents)
      const strictRunsByToolUseId = new Map(strictRuns.flatMap((run) => run.toolUseId ? [[run.toolUseId, run] as const] : []))
      expect(await readSubagentRunsByToolUseId(asAsyncEventReadSurface(store), DECORATION_SESSION_ID)).toEqual(strictRunsByToolUseId)

      const workflowEvents = events.filter((event) => event.type.startsWith("workflow."))
      for (const event of workflowEvents) expect(() => parseProjectionFact(event, parseSessionRuntimeFact)).not.toThrow()
    } finally {
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })


  it("reports a deliberate nested strict-projection agreement perturbation", () => {
    const fixture = strictProjectionAgreementFixtures.session_metadata
    const direct = JSON.parse(fixture.fact.payloadBytes)
    const production = { ...direct, nested: { durable: { state: "changed" } } }
    const expected = { ...direct, nested: { durable: { state: "stable" } } }
    expect(() => assertStrictProjectionAgreement("strict-agreement-nested-perturbation", "session_metadata", fixture.fixtureId, expected, production)).toThrow(
      /case=strict-agreement-nested-perturbation kind=session_metadata identity=strict-session-created-v5 firstDifferingField=\$\.nested\.durable\.state/,
    )
  })

  it("drives RuntimeEvents through OutputSession and equivalent messages through the durable chat tree", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-output-equivalence-"))
    const store = createSqliteEventStore(join(tmpDir, "flywheel.sqlite"))
    const sessionId = "pipeline-session"
    const conversationId = "pipeline-conversation"
    const live = createOutputSession({ updateEntry: () => {}, sessionId, executionCwd: realpathSync(tmpDir) })
    const realNow = Date.now
    try {
      Date.now = () => 1_000
      const mutationEvidence = await buildMutationDiffEvidence(fileMutation, "example", async nodes => { store.stageSessionContentNodes(sessionId, nodes) })
      const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const userEntryId = await tree.getStorage().allocateId()
      const assistantEntryId = await tree.getStorage().allocateId()
      live.pushUserMessage("sanitized request", 1_000, { entryId: userEntryId })
      live.dispatchRuntimeEvent({
        type: "model.assistant_message.recorded",
        data: { entry_id: assistantEntryId, message: { content: [
          { type: "text", text: "first " },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "write-1", name: "write", input: { path: "src/example.ts", content: "export const value = 1\n" } },
          { type: "tool_use", id: "edit-1", name: "edit", input: { input: "@@ src/example.ts\n= 1aa..1aa\n~export const value = 2" } },
          { type: "tool_use", id: "replace-1", name: "replace", input: { files: ["src/legacy.ts"], old: "before", new: "after" } },
          { type: "tool_use", id: "bash-1", name: "bash", input: { command: "false" } },
          { type: "tool_use", id: "code-1", name: "code", input: { source: "return 'exact  \\n'\n" } },
          { type: "tool_use", id: "memory-1", name: "memory", input: { action: "add", content: "Prefers Bun." } },
          { type: "tool_use", id: "process-1", name: "process", input: { action: "list" } },
        ] } },
      })
      live.dispatchRuntimeEvent({ type: "tool.result.recorded", data: { tool_use_id: "write-1", content: [{ type: "text", text: "written" }], details: { mutationEvidence } } })
      live.dispatchRuntimeEvent({ type: "tool.result.recorded", data: { tool_use_id: "edit-1", content: [{ type: "text", text: "edited" }], details: { mutationEvidence } } })
      live.dispatchRuntimeEvent({ type: "tool.result.recorded", data: { tool_use_id: "replace-1", content: [{ type: "text", text: "historical replacement" }], details: { mutationEvidence } } })
      live.dispatchRuntimeEvent({ type: "tool.result.recorded", data: { tool_use_id: "bash-1", is_error: true, content: [{ type: "text", text: "sanitized failure" }] } })
      live.dispatchRuntimeEvent({ type: "tool.result.recorded", data: { tool_use_id: "code-1", content: [{ type: "text", text: "exact  \n" }] } })
      live.dispatchRuntimeEvent({ type: "tool.result.recorded", data: { tool_use_id: "memory-1", is_error: true, content: [{ type: "text", text: "Memory write failed" }] } })
      live.pushSystemMessage("Sanitized stream interrupted", 1_000)
      live.endTurn("completed")
      live.flush()

      const appended = await tree.appendMessages([
        { kind: "user", content: "sanitized request" },
        { kind: "assistant", content: [
          { type: "text", text: "first " },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "write-1", name: "write", input: { path: "src/example.ts", content: "export const value = 1\n" } },
          { type: "tool_use", id: "edit-1", name: "edit", input: { input: "@@ src/example.ts\n= 1aa..1aa\n~export const value = 2" } },
          { type: "tool_use", id: "replace-1", name: "replace", input: { files: ["src/legacy.ts"], old: "before", new: "after" } },
          { type: "tool_use", id: "bash-1", name: "bash", input: { command: "false" } },
          { type: "tool_use", id: "code-1", name: "code", input: { source: "return 'exact  \\n'\n" } },
          { type: "tool_use", id: "memory-1", name: "memory", input: { action: "add", content: "Prefers Bun." } },
          { type: "tool_use", id: "process-1", name: "process", input: { action: "list" } },
        ] },
        { kind: "toolResult", toolUseId: "write-1", content: [{ type: "text", text: "written" }] },
        { kind: "toolResult", toolUseId: "edit-1", content: [{ type: "text", text: "edited" }] },
        { kind: "toolResult", toolUseId: "replace-1", content: [{ type: "text", text: "historical replacement" }] },
        { kind: "toolResult", toolUseId: "bash-1", content: [{ type: "text", text: "sanitized failure" }], isError: true },
        { kind: "toolResult", toolUseId: "code-1", content: [{ type: "text", text: "exact  \n" }] },
        { kind: "toolResult", toolUseId: "memory-1", content: [{ type: "text", text: "Memory write failed" }], isError: true },
        { kind: "system", content: "Sanitized stream interrupted" },
      ], [userEntryId, assistantEntryId])
      if (appended.kind !== "committed") throw new Error("expected durable pipeline messages")
      tree.getStorage().dispose()
      store.append({
        aggregateId: `session:${sessionId}`,
        type: "tool.result.recorded",
        version: 3,
        timestamp: 1_000,
        actor: "flywheel",
        sessionId,
        payload: { toolUseId: "edit-1", outcome: "ok", details: { mutationEvidence } },
      })
      store.append({
        aggregateId: `session:${sessionId}`,
        type: "tool.result.recorded",
        version: 3,
        timestamp: 1_000,
        actor: "flywheel",
        sessionId,
        payload: { toolUseId: "replace-1", outcome: "ok", details: { mutationEvidence } },
      })
      store.append({
        aggregateId: `session:${sessionId}`,
        type: "tool.result.recorded",
        version: 3,
        timestamp: 1_000,
        actor: "flywheel",
        sessionId,
        payload: { toolUseId: "write-1", outcome: "ok", details: { mutationEvidence } },
      })

      const projection = createSessionDetailProjection({
        projectRoot: tmpDir,
        sessionStore: { get: () => undefined },
        manager: { read: async () => ({ label: "Pipeline", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" as const, name: "Pipeline", kind: "chat" as const, command: "chat" as const, conversationId, executionCwd: realpathSync(tmpDir) }) },
        reader: asAsyncEventReadSurface(store),
        projectionReader: asAsyncEventReadSurface(store),
      })
      const durable = await projection.outputRange(sessionId, tailRequest)
      if (durable.kind !== "ok") throw new Error("expected durable pipeline range")

      expect(live.getBlocks().filter(block => block.kind === "userMessage" || block.kind === "text").map(block => block.id))
        .toEqual(durable.blocks.filter(block => block.kind === "userMessage" || block.kind === "text").map(block => block.id))
      const liveWire = projectFrontendOutputBlocks(live.getBlocks()).map(comparableBlock)
      const durableWire = await Promise.all(durable.blocks.map(async (block) => {
        if (block.kind !== "tool" || (block.invocationBodyOmittedBytes === undefined && block.contentOmittedLines === undefined)) return comparableBlock(block)
        const { blockId: _blockId, ...body } = await projection.outputBlockBody(sessionId, { blockId: `tool:${block.id}` })
        const { invocationBodyOmittedBytes: _sourceOmitted, contentOmittedLines: _contentOmitted, ...shell } = block
        return comparableBlock({ ...shell, ...body, id: block.id, kind: "tool" })
      }))
      const liveText = liveWire.map((block) => block.kind === "text" ? block.content : null)
      const durableText = durableWire.map((block) => block.kind === "text" ? block.content : null)
      if (JSON.stringify(liveText) !== JSON.stringify(durableText)) throw new Error(`text coalescing divergence live=${JSON.stringify(liveText)} derived=${JSON.stringify(durableText)}`)
      assertOutputBlocksEquivalent("runtime-events-vs-chat-tree", liveWire, durableWire)
      expect(liveWire.map((block) => block.identity)).toEqual(["userMessage", "text", "tool:write", "tool:edit", "tool:replace", "tool:bash", "tool:code", "tool:memory", "system"])
      expect(liveWire.find((block) => block.identity === "tool:write")).toMatchObject({ status: "completed", mutationEvidence })
      expect(liveWire.find((block) => block.identity === "tool:write")).not.toHaveProperty("proposedDiff")
      expect(durableWire.find((block) => block.identity === "tool:write")).not.toHaveProperty("proposedDiff")
      expect(liveWire.find((block) => block.identity === "tool:edit")).toMatchObject({ status: "completed", mutationEvidence })
      expect(durableWire.find((block) => block.identity === "tool:edit")).toMatchObject({ status: "completed", mutationEvidence })
      expect(liveWire.find((block) => block.identity === "tool:replace")).toMatchObject({ status: "completed", mutationEvidence })
      expect(durableWire.find((block) => block.identity === "tool:replace")).toMatchObject({ status: "completed", mutationEvidence })
      expect(liveWire.find((block) => block.identity === "tool:bash")).toMatchObject({ status: "error", errorMessage: "Sanitized failure" })
      expect(liveWire.find((block) => block.identity === "tool:code")).toMatchObject({
        status: "completed",
        content: "exact  \n",
      })
      expect(durableWire.find((block) => block.identity === "tool:code")).toMatchObject({
        status: "completed",
        content: "exact  \n",
      })
      expect(liveWire.find((block) => block.identity === "tool:memory")).toMatchObject({
        status: "error",
        errorMessage: "Memory write failed",
      })
      expect(durableWire.find((block) => block.identity === "tool:memory")).toMatchObject({
        status: "error",
        errorMessage: "Memory write failed",
      })
    } finally {
      Date.now = realNow
      live.dispose()
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("keeps full display bytes across aggregate-budgeted conversation replay and store reopen", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-output-budget-reopen-"))
    const dbPath = join(tmpDir, "flywheel.sqlite")
    const sessionId = "budget-reopen-session"
    const conversationId = "budget-reopen-conversation"
    const canonicalContent = `canonical-display\n${"result line\n".repeat(2_000)}tail`
    const fullParts = [{ type: "text" as const, text: canonicalContent }]
    const replacements = await enforceTurnBudget([
      { toolUseId: "search-1", toolName: "search", exempt: false, content: fullParts },
    ], { budgetChars: turnBudgetChars(4_000), executionCwd: tmpDir, projectRoot: tmpDir, artifactScopeId: sessionId })
    const budgetedParts = replacements[0]?.content
    if (!budgetedParts) throw new Error("expected aggregate budget replacement")
    const manager = { read: async () => ({ label: "Budget", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" as const, name: "Budget", kind: "chat" as const, command: "chat" as const, conversationId, executionCwd: tmpDir }) }
    let store = createSqliteEventStore(dbPath)
    try {
      const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
      await writer.record({
        type: "tool.result.recorded",
        version: 1,
        actor: "flywheel",
        payload: {
          toolUseId: "search-1",
          outcome: "ok",
          details: { displayContent: canonicalContent },
        },
      })
      await writer.dispose()
      const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const appended = await tree.appendMessages([
        { kind: "assistant", content: [{ type: "tool_use", id: "search-1", name: "search", input: { pattern: "result" } }] },
        { kind: "toolResult", toolUseId: "search-1", content: budgetedParts },
      ])
      if (appended.kind !== "committed") throw new Error("expected budgeted conversation result")
      await tree.getStorage().dispose()

      const readBody = async () => {
        const projection = createSessionDetailProjection({ projectRoot: tmpDir, sessionStore: { get: () => undefined }, manager, reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store) })
        try {
          const range = await projection.outputRange(sessionId, tailRequest)
          if (range.kind !== "ok") throw new Error("expected durable budget range")
          expect(range.blocks.filter((block) => block.kind === "tool")).toHaveLength(1)
          const tool = range.blocks.find((block) => block.kind === "tool")
          if (!tool || tool.kind !== "tool") throw new Error("expected durable search block")
          expect(tool.contentOmittedLines).toBeGreaterThan(0)
          const body = await projection.outputBlockBody(sessionId, { blockId: `tool:${tool.id}` })
          return body.content
        } finally {
          await projection.dispose()
        }
      }

      const openContent = await readBody()
      store.close()
      store = createSqliteEventStore(dbPath)
      const reopenedContent = await readBody()
      const contextTree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store) })
      if (!contextTree) throw new Error("expected reopened provider conversation")
      const durableResult = (await contextTree.getBranch()).find((entry) => entry.kind === "message" && entry.message.kind === "toolResult")
      if (!durableResult || durableResult.kind !== "message" || durableResult.message.kind !== "toolResult") throw new Error("expected budgeted provider result")
      expect(durableResult.message.content).toEqual(budgetedParts)
      await contextTree.getStorage().dispose()
      expect(Buffer.from(openContent ?? "")).toEqual(Buffer.from(canonicalContent))
      expect(Buffer.from(reopenedContent ?? "")).toEqual(Buffer.from(canonicalContent))
      expect(JSON.stringify(budgetedParts)).not.toContain(canonicalContent)
    } finally {
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("characterizes live-only thinking elision and queued recall through OutputSession", () => {
    const session = createOutputSession({ updateEntry: () => {}, executionCwd: corpusProjectDir(".") })
    try {
      session.dispatchRuntimeEvent({ type: "model.content.delta", data: { delta: { type: "thinking_delta", thinking: "reasoning" }, block_key: "thought" } })
      session.dispatchRuntimeEvent({ type: "model.content.delta", data: { delta: { type: "text_delta", text: "answer" }, block_key: "answer" } })
      session.pushUserMessage("queued", 2_000, { queued: true, dispatchIds: ["queued-cell"] })
      expect(session.getBlocks().map((block) => block.kind)).toEqual(["thinking", "text", "userMessage"])
      expect(session.withdrawQueued(["queued-cell"])).not.toBeNull()
      expect(session.getBlocks().map((block) => block.kind)).toEqual(["thinking", "text"])
    } finally {
      session.dispose()
    }
  })

  it("names the case, block kind, identity, and first differing nested JSON path", () => {
    const blocks = projectFrontendOutputBlocks(outputSeamBlocks())
    const perturbed = blocks.map((block) => block.kind === "tool" && block.id === "tool-ok"
      ? { ...block, presentation: { ...block.presentation, detail: `${block.presentation.detail}!` } }
      : block)
    expect(() => assertOutputBlocksEquivalent("deliberate-nested-perturbation", blocks, perturbed)).toThrow(
      /case=deliberate-nested-perturbation kind=tool identity=tool-ok firstDifferingField=\$\.4\.presentation\.detail/,
    )
  })

  it("keeps preview, full-range, and fresh-store reopen output identical for one bounded long session", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-output-reopen-parity-"))
    const dbPath = join(tmpDir, "flywheel.sqlite")
    const sessionId = "reopen-parity-session"
    const conversationId = "reopen-parity-conversation"
    const manager = { read: async () => ({ label: "Parity", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" as const, name: "Parity", kind: "chat" as const, command: "chat" as const, conversationId, executionCwd: tmpDir }) }
    let store = createSqliteEventStore(dbPath)
    try {
      const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const messages = Array.from({ length: 96 }, (_, index) => ({ kind: "user" as const, content: `bounded-turn-${index}:${"x".repeat(64)}` }))
      const appended = await tree.appendMessages(messages)
      if (appended.kind !== "committed") throw new Error("expected bounded parity history")
      await tree.getStorage().dispose()

      const request = { anchor: { kind: "tail" as const }, maxBlocks: 200, maxBytes: 1024 * 1024 }
      const openProjection = createSessionDetailProjection({ projectRoot: tmpDir, sessionStore: { get: () => undefined }, manager, reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store) })
      const preview = await openProjection.outputWindow(sessionId, request)
      const full = await openProjection.outputRange(sessionId, request)
      expect(preview.range).toEqual(full)
      await openProjection.dispose()

      store.close()
      store = createSqliteEventStore(dbPath)
      const reopenedProjection = createSessionDetailProjection({ projectRoot: tmpDir, sessionStore: { get: () => undefined }, manager, reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store) })
      const reopened = await reopenedProjection.outputRange(sessionId, request)
      expect(reopened).toEqual(full)
      expect(preview.totalBlocks).toBe(96)
      expect(store.read({ aggregateId: `session:${sessionId}`, types: ["output.log.indexed", "output.block.indexed", "output.chunk.recorded"] })).toHaveLength(0)

      if (reopened.kind !== "ok") throw new Error("expected reopened range")
      const perturbed = { ...reopened, blocks: reopened.blocks.map((block, index) => index === 40 && block.kind === "userMessage" ? { ...block, content: `${block.content}!` } : block) }
      expect(() => assertOutputBlocksEquivalent("preview-open-reopen-perturbation", full.kind === "ok" ? full.blocks : [], perturbed.blocks)).toThrow(
        /case=preview-open-reopen-perturbation kind=userMessage identity=.+ firstDifferingField=\$\.40\.content/,
      )
      await reopenedProjection.dispose()
    } finally {
      store.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

function comparableBlock(block: ReturnType<typeof projectFrontendOutputBlocks>[number]) {
  const identity = block.kind === "tool"
    ? `${block.kind}:${block.name}`
    : block.kind === "agentGroup" || block.kind === "question"
      ? `${block.kind}:${block.kind === "question" ? block.toolUseId : block.id}`
      : block.kind
  const { id: _id, timestamp: _timestamp, ...wire } = block.kind === "question" ? { ...block, id: undefined } : block
  return { identity, ...wire }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
