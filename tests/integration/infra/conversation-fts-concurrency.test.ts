import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { acquireConversationSearchIndex, CONVERSATION_FTS_TABLE } from "../../../src/infra/conversation-fts.js"
import type { AsyncEventReadSurface } from "../../../src/infra/event-store-types.js"
import { countConversationRecall, searchConversationRecall } from "../../../src/infra/conversation-recall-search.js"

const CHILD = path.resolve(import.meta.dir, "../../fixtures/conversation-fts-concurrent-owner.ts")
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

test("independent owners replaying the same page commit it once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-fts-concurrency-"))
  directories.push(directory)
  const dbFile = path.join(directory, "conversation-search.sqlite")
  const emptySource: AsyncEventReadSurface = {
    capturePosition: async () => 0,
    readPage: async (_query, upperPosition, _afterPosition) => ({ facts: [], upperPosition: upperPosition ?? 0, continuationPosition: null, toolContent: { resolve: () => { throw new Error("This fixture has no referenced content") } } }),
  }
  const initializer = acquireConversationSearchIndex(dbFile, emptySource)
  await initializer.through(0)
  await initializer.dispose()

  const spawnOwner = (id: string) => Bun.spawn(
    [process.execPath, CHILD, dbFile, directory, id],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const first = spawnOwner("first")
  const second = spawnOwner("second")
  while (!fs.existsSync(path.join(directory, "ready-first")) || !fs.existsSync(path.join(directory, "ready-second"))) {
    await Bun.sleep(5)
  }
  fs.writeFileSync(path.join(directory, "release"), "")

  const results = await Promise.all([first, second].map(async (child) => ({
    exitCode: await child.exited,
    stderr: await new Response(child.stderr).text(),
  })))
  expect(results).toEqual([
    { exitCode: 0, stderr: "" },
    { exitCode: 0, stderr: "" },
  ])

  const db = new Database(dbFile, { readonly: true })
  try {
    const query = { upperPosition: 1, conversationId: "conv-1", match: "shared", limit: 10 }
    expect(db.query<{ count: number }, []>(`select count(*) as count from ${CONVERSATION_FTS_TABLE}`).get()?.count).toBe(1)
    expect(searchConversationRecall(db, query)).toHaveLength(1)
    expect(countConversationRecall(db, query)).toBe(1)
  } finally {
    db.close()
  }
})
