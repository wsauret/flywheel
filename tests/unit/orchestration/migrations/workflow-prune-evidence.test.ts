import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { dropLegacyWorkflowPruneEvidence } from "../../../../src/orchestration/modules/workflows/migrations/workflow-prune-evidence.js"

const tmpRoot = path.join(os.tmpdir(), `flywheel-workflow-prune-evidence-${process.pid}-${Date.now()}`)

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

describe("dropLegacyWorkflowPruneEvidence", () => {
  it("drops the obsolete table and all evidence rows idempotently", () => {
    fs.mkdirSync(tmpRoot, { recursive: true })
    const dbFile = path.join(tmpRoot, "flywheel.sqlite")
    const db = new Database(dbFile)
    try {
      db.exec("create table event_prune (aggregate_id text not null, seq integer not null, type text not null, origin text not null)")
      db.exec("insert into event_prune values ('workflow:w1', 1, 'queue.state.changed', 'runtime')")
    } finally {
      db.close()
    }

    expect(dropLegacyWorkflowPruneEvidence(dbFile)).toBe(true)
    expect(dropLegacyWorkflowPruneEvidence(dbFile)).toBe(false)
    const reopened = new Database(dbFile, { readonly: true })
    try {
      expect(reopened.query("select name from sqlite_master where type = 'table' and name = 'event_prune'").get()).toBeNull()
    } finally {
      reopened.close()
    }
  })
})