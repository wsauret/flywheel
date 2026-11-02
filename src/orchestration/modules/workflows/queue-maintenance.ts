import { factDescriptors, factTypes } from "../../../infra/event-registry.js"
import { factRowsChanged } from "../../../infra/sqlite-event-store-core.js"
import { WorkflowQueueFactSchemas } from "../../../workflows/view/view-facts.js"
import type { SupersededFactInvalidationResult } from "../../module-seams.js"
import { openMaintenanceDb } from "../../session/event-store-maintenance.js"
import { QUEUE_STEP_SKILL_ID_UPGRADES } from "./migrations/queue-step-skill-id.js"
import { RETIRED_SELF_REVIEW_QUEUE_UPGRADES } from "./migrations/retired-self-review.js"
import { RETIRED_CHILD_ASK_USER_QUEUE_UPGRADES } from "./migrations/retired-child-ask-user.js"
import { STEP_ROW_CONTENT_ID_QUEUE_UPGRADES } from "./migrations/step-row-content-id.js"
import { LOOP_BODY_ROWS_QUEUE_UPGRADES } from "./migrations/loop-body-rows.js"

/** One-time invalidation of workflow-queue state whose facts predate the
 *  registered schema versions and no registered migration can upgrade. The
 *  registry deliberately drops superseded versions so incompatible persisted
 *  state fails explicitly instead of growing reader tolerance branches; this
 *  operation makes that state stop existing. Every queue-fact row in an affected
 *  aggregate is deleted, not only the unregistered ones: a queue history without
 *  its creation fact is unreadable by invariant. Sessions and their conversation
 *  trees are untouched; the session simply reads as having no queue, like a chat.
 *
 *  One owner for the upgrade path: `prepareWorkspaceState` runs the fact
 *  migrations, and this operation never competes with it. A version a registered
 *  migration upgrades is history in transit, not superseded state, so it is
 *  reported through `upgradable` and kept. Maintenance can therefore run against
 *  a store that no Flywheel start has upgraded yet without losing that history.
 *
 *  Out-of-band deletion: it bypasses the owning store's onStored broadcast,
 *  so run it with Flywheel stopped (or restart afterwards). A live process
 *  cannot hold a stale in-memory view of an affected queue - reading one
 *  throws before a view exists - but the durable rows it deletes are not
 *  republished to running projections. */
export function invalidateSupersededQueueFacts(dbPath: string): SupersededFactInvalidationResult {
  const db = openMaintenanceDb(dbPath, { readonly: false })
  if (!db) return { storeFound: false, dbPath, invalidated: [], rowsDeleted: 0, upgradable: [] }
  const registered = new Set(factDescriptors(WorkflowQueueFactSchemas).map(({ type, version }) => `${type}@${version}`))
  const upgradable = new Set([...QUEUE_STEP_SKILL_ID_UPGRADES, ...RETIRED_SELF_REVIEW_QUEUE_UPGRADES, ...RETIRED_CHILD_ASK_USER_QUEUE_UPGRADES, ...STEP_ROW_CONTENT_ID_QUEUE_UPGRADES, ...LOOP_BODY_ROWS_QUEUE_UPGRADES].map(({ type, fromVersion }) => `${type}@${fromVersion}`))
  const typeList = factTypes(WorkflowQueueFactSchemas).map((type) => `'${type}'`).join(", ")
  try {
    const observed = db.query<{ aggregateId: string; type: string; version: number }, []>(`
      select distinct aggregate_id as aggregateId, type, version
      from event
      where type in (${typeList})
    `).all()
    const supersededByAggregate = new Map<string, string[]>()
    const inTransit = new Set<string>()
    for (const row of observed) {
      const key = `${row.type}@${row.version}`
      if (registered.has(key)) continue
      if (upgradable.has(key)) {
        inTransit.add(key)
        continue
      }
      const keys = supersededByAggregate.get(row.aggregateId) ?? []
      keys.push(key)
      supersededByAggregate.set(row.aggregateId, keys)
    }
    const invalidated: Array<SupersededFactInvalidationResult["invalidated"][number]> = []
    const deleteQueueFacts = db.query<unknown, { $aggregateId: string }>(`
      delete from event where aggregate_id = $aggregateId and type in (${typeList})
    `)
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const [aggregateId, supersededFacts] of supersededByAggregate) {
        deleteQueueFacts.run({ $aggregateId: aggregateId })
        invalidated.push({ aggregateId, supersededFacts: supersededFacts.sort(), rowsDeleted: factRowsChanged(db) })
      }
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
    return {
      storeFound: true,
      dbPath,
      invalidated,
      rowsDeleted: invalidated.reduce((total, entry) => total + entry.rowsDeleted, 0),
      upgradable: [...inTransit].sort(),
    }
  } finally {
    db.close()
  }
}
