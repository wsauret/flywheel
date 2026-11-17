import { expect, test } from "bun:test"
import { join } from "node:path"
import { asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { buildDurableSubagentCreated, buildSubagentCompleted, buildSubagentPrompted } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { loadSubagentRunsFromEvents } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

test("A created, prompted, and completed subagent records three facts in order", async () => {
  const root = temporaryDirectory("subagent-run-facts-")
  const sessionId = "child-1"
  const executionCwd = join(root, "alternate-worktree")
  const store = createSqliteEventStore(resolveEventStoreDbFile(root))
  const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
  await writer.transaction(() => {
    void writer.record(buildDurableSubagentCreated({
      childSessionId: sessionId,
      childRunId: "run-1",
      conversationId: "child-conversation",
      parentSessionId: "parent",
      parentConversationId: "parent-conversation",
      parentToolCallId: "tool-1",
      modelRequestId: "request-1",
      persona: { name: "reviewer", kind: "persona" },
      capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
      admittedModuleIds: [],
      skillsRevision: 1,
      model: "claude-test",
      effort: "medium",
      tools: ["read", "search", "handoff"],
      executionCwd,
      budget: { maxTurns: 4, maxTokens: 0 },
      parentDepth: 0,
      description: "review the diff",
    }))
    void writer.record(buildSubagentPrompted({ childRunId: "run-1", prompt: "Inspect the change", task: "You are a reviewer", toolNames: ["read", "search", "handoff"] }))
    void writer.record(buildSubagentCompleted({ childRunId: "run-1", status: "completed", isError: false, content: "Looks good", durationMs: 120, totalTokens: 42, toolUses: 2 }))
  })
  writer.dispose()
  store.close()

  const reopened = createSqliteEventStore(resolveEventStoreDbFile(root))
  const facts = reopened.read({ aggregateId: `session:${sessionId}` })
  reopened.close()

  expect(facts.map((fact) => fact.type)).toEqual(["child_run.created", "subagent.prompted", "subagent.completed"])
  const runs = loadSubagentRunsFromEvents(facts)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({
    childRunId: "run-1",
    status: "completed",
    modelRequestId: "request-1",
    agentType: "reviewer",
    description: "review the diff",
    model: "claude-test",
    tools: ["read", "search", "handoff"],
    executionCwd,
    prompt: "Inspect the change",
    task: "You are a reviewer",
    isError: false,
    durationMs: 120,
    totalTokens: 42,
    toolUses: 2,
    resultPreview: "Looks good",
  })
})
