import { test } from "node:test"
import { strict as assert } from "node:assert"

import type { SessionCatalogRow, SessionRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { offeredSessionControls, workflowStateLabel } from "../../../src/protocol/client/session-controls.js"
import { createRuntimeSession } from "./session.js"
import { createViewProjection, summaryOf } from "./view-state.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"
import { authView } from "./session-connection-fixture.js"
import { detailView } from "../../../tests/helpers/runtime-views.js"

const STAMP = "2026-09-22T12:00:00.000Z"

/** A chat-only catalog with a stopped workflow agent available through held detail. */
function stoppedWorkflowConnection(): RuntimeConnection {
  const workflow: SessionRow = {
    id: "wf", kind: "workflow-agent", workflowMembership: { kind: "attempt", workflowId: "workflow", attemptId: "attempt" },
    title: "Investigate", lifecycleState: "inactive", activity: "idle", inputMode: { kind: "message" },
    admittedActions: ["session.delete"], stoppedBy: "person", parentSessionId: "parent-chat", parentToolUseId: "tool-1",
    createdAt: STAMP, lastUpdated: STAMP, notices: [], executionCwd: "/workspace", totalsLoading: true,
  }
  const chat: SessionCatalogRow = {
    id: "parent-chat", kind: "chat", title: "Parent", lifecycleState: "inactive", activity: "idle", inputMode: { kind: "chat" },
    createdAt: STAMP, lastUpdated: STAMP, notices: [], executionCwd: "/workspace", totalsLoading: true,
  }
  return fakeRuntimeConnection({ queries: {
    snapshot: async () => ({
      rows: [chat], activeRuntimeCount: 0, errors: [], snapshotPosition: 0, projectRoot: "/workspace", runtimeVersion: "test", runtimeBuildId: null,
      chatDefault: { kind: "pending" }, executor: { kind: "serving" }, service: { kind: "serving" },
    }),
    sessionDetailSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => {
      const row = [chat, workflow].find((candidate) => candidate.id === sessionId)
      return { sessionId, view: row ? detailView(row, `${sessionId}-conv`) : null }
    }) }),
    authStatusSnapshot: async () => ({ snapshotPosition: 0, auth: authView([]) }),
  } })
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

test("a directly selected workflow agent whose detail says a person stopped it reads stopped and admits no Resume", async () => {
  const session = createRuntimeSession({ connection: stoppedWorkflowConnection() })
  await settle()
  await session.select("wf")
  await settle()

  const summary = summaryOf(createViewProjection()(session), "wf")
  assert.equal(summary?.stoppedBy, "person")
  assert.equal(workflowStateLabel("paused", summary), "Stopped")
  assert.equal(offeredSessionControls(summary, false).primary, null)
  session.dispose()
})
