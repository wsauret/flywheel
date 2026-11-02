import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import {
  recordSubagentCompleted,
  recordSubagentCreated,
  recordSubagentPrompted,
} from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { loadSubagentRunsFromEvents } from "../../../../src/orchestration/modules/subagents/history/subagent-run-projection"

describe("subagent run facts", () => {
  test("records subagent run facts and replays the projection from SQLite", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "subagent-run-facts-"))
    try {
      const sessionId = "session-1"
      const eventStore = createSqliteEventStore(resolveEventStoreDbFile(tmp))
      const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(eventStore) })

      await writer.transaction(() => {
        recordSubagentCreated(writer, {
          childRunId: "tool-1",
          toolUseId: "tool-1",
          modelRequestId: "request-1",
          agentType: "reviewer",
          description: "review the diff",
          model: "claude-test",
          effort: "medium",
          maxTurns: 4,
          tools: ["read", "search", "handoff"],
          executionCwd: join(tmp, "alternate-worktree"),
        })
        recordSubagentPrompted(writer, {
          childRunId: "tool-1",
          prompt: "Inspect the change",
          task: "You are a reviewer",
          toolNames: ["read", "search", "handoff"],
        })
        recordSubagentCompleted(writer, {
          childRunId: "tool-1",
          status: "completed",
          isError: false,
          content: "Looks good",
          durationMs: 120,
          totalTokens: 42,
          toolUses: 2,
        })
      })
      writer.dispose()
      eventStore.close()

      const reopened = createSqliteEventStore(resolveEventStoreDbFile(tmp))
      const runs = loadSubagentRunsFromEvents(reopened.read({ aggregateId: `session:${sessionId}` }))
      reopened.close()

      expect(runs.length).toBe(1)
      expect(runs[0]).toMatchObject({
        childRunId: "tool-1",
        status: "completed",
        modelRequestId: "request-1",
        agentType: "reviewer",
        description: "review the diff",
        model: "claude-test",
        tools: ["read", "search", "handoff"],
        executionCwd: join(tmp, "alternate-worktree"),
        prompt: "Inspect the change",
        task: "You are a reviewer",
        isError: false,
        durationMs: 120,
        totalTokens: 42,
        toolUses: 2,
        resultPreview: "Looks good",
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
