import * as fs from "node:fs"

import { acquireConversationSearchIndex } from "../../src/infra/conversation-fts.js"
import type { AsyncEventReadSurface, StoredFact } from "../../src/infra/event-store-types.js"

const [dbFile, coordinationDir, ownerId] = process.argv.slice(2)
if (!dbFile || !coordinationDir || !ownerId) throw new Error("Expected database, coordination directory, and owner id")

const fact: StoredFact = {
  aggregateId: "conversation:conv-1",
  type: "chat.entries.appended",
  version: 1,
  timestamp: 1,
  actor: "test",
  sessionId: "conv-1",
  payload: {
    conversationId: "conv-1",
    entries: [{
      kind: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2025-01-01T00:00:00.000Z",
      message: { kind: "user", content: "shared replay token" },
    }],
  },
  position: 1,
  id: "fact-1",
  seq: 0,
}

const source: AsyncEventReadSurface = {
  capturePosition: async () => 1,
  readPage: async (query, upperPosition, _afterPosition) => {
    // The index first reads only deletions; the race belongs to the read that finds the chat fact.
    if (query.types && !query.types.includes(fact.type)) {
      return { facts: [], upperPosition: upperPosition ?? 1, continuationPosition: null, toolContent: { resolve: () => { throw new Error("This fixture has no referenced content") } } }
    }
    fs.writeFileSync(`${coordinationDir}/ready-${ownerId}`, "")
    while (!fs.existsSync(`${coordinationDir}/release`)) await Bun.sleep(5)
    return {
      facts: [fact],
      upperPosition: upperPosition ?? 1,
      continuationPosition: null,
      toolContent: { resolve: () => { throw new Error("This fixture has no referenced content") } },
    }
  },
}

const index = acquireConversationSearchIndex(dbFile, source)
try {
  await index.through(1)
} finally {
  await index.dispose()
}
