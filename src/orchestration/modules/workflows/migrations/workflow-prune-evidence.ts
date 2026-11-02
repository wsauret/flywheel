import { Database } from "bun:sqlite"
import * as fs from "node:fs"

import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { applySqliteDurabilityPragmas } from "../../../../infra/sqlite-durability.js"

/** Remove the short-lived per-deletion evidence table from stores opened by the
 * release that introduced it. Sparse workflow sequences need no side ledger. */
export function dropLegacyWorkflowPruneEvidence(dbFile: string): boolean {
  if (!fs.existsSync(dbFile)) return false
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    applySqliteDurabilityPragmas(db, 5000)
    if (!tableExists(db, "event_prune")) return false
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec("drop table event_prune")
      db.exec("COMMIT")
      return true
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  } finally {
    db.close()
  }
}

function tableExists(db: Database, table: string): boolean {
  return db.query<{ found: number }, { $table: string }>(
    "select 1 as found from sqlite_master where type = 'table' and name = $table",
  ).get({ $table: table }) !== null
}