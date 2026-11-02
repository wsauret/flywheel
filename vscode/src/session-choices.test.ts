import assert from "node:assert/strict"
import { test } from "node:test"

import type { FrontendActivity, SessionCatalogRow } from "../../src/protocol/app-service-types.js"
import { sessionChoices } from "./session-choices.js"

function row(id: string, lifecycleState: SessionCatalogRow["lifecycleState"], activity?: FrontendActivity): SessionCatalogRow {
  return {
    id,
    kind: "chat",
    title: id,
    lifecycleState,
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: "2026-10-06T00:00:00.000Z",
    executionCwd: "/repo",
    totalsLoading: true,
    ...(activity === undefined ? {} : { activity }),
  }
}

const ROWS = [row("idle", "active", "idle"), row("busy", "active", "generating"), row("closed", "inactive")]

test("an open chat reads open until a turn runs in it", () => {
  assert.deepEqual(sessionChoices(ROWS, "all").map(({ id, description }) => [id, description]), [["idle", "open"], ["busy", "working"], ["closed", "closed"]])
})

test("Close chat offers only the chats that are still open", () => {
  assert.deepEqual(sessionChoices(ROWS, "open").map(({ id }) => id), ["idle", "busy"])
})
