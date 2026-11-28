import type { AsyncEventReadSurface } from "../../../infra/substrate/store/event-store-types.js"
import type { ProfileStateStore } from "../../app-service/executor/execution/module-service-host.js"
import { createProjectNotificationJournal, type ProjectNotificationJournal } from "./journal.js"
import { profileNotificationAggregateId } from "./projection.js"
import { createProjectNotificationPublisher, type ProjectNotificationPublisher } from "./publisher.js"
import { recoverProjectNotificationHistory } from "./recovery.js"

/** The session id the journal signs its facts with: the aggregate is the profile's, not one session's. */
const JOURNAL_SESSION_ID = "project-notifications"

/** One project's hold on the journal of one auth profile. */
export interface ProfileNotificationLease {
  readonly journal: ProjectNotificationJournal
  readonly publisher: ProjectNotificationPublisher
  /** Ends this hold. The last hold of the host settles the publisher and closes the journal. */
  release(): Promise<void>
}

interface HeldProfileJournal {
  readonly journal: ProjectNotificationJournal
  readonly publisher: ProjectNotificationPublisher
  holders: number
}

// Keyed by the store's reader, which every project of one host receives as
// the same object, so the host holds one journal and one projection per
// profile aggregate (ARCH-SUBSTRATE-041), as the projection registry keys its
// projections by reader identity.
const heldByStore = new WeakMap<AsyncEventReadSurface, Map<string, HeldProfileJournal>>()

/** Holds the one journal of `profileId` that every project of the host
 *  shares. The first hold recovers the aggregate strictly on its own
 *  connection when the store names its database (ARCH-SUBSTRATE-014), then
 *  opens its journal and its one
 *  publisher, so a change folds, reads, and polls once for the host however
 *  many projects show it. */
export function holdProfileNotificationJournal(store: ProfileStateStore, profileId: string): ProfileNotificationLease {
  let held = heldByStore.get(store.reader)
  if (held === undefined) {
    held = new Map()
    heldByStore.set(store.reader, held)
  }
  const journals = held
  let entry = journals.get(profileId)
  if (entry === undefined) {
    const aggregateId = profileNotificationAggregateId(profileId)
    if (store.dbFile !== undefined) recoverProjectNotificationHistory(store.dbFile, aggregateId)
    const journal = createProjectNotificationJournal({ reader: store.reader, writer: store.writer, aggregateId, sessionId: JOURNAL_SESSION_ID })
    entry = { journal, publisher: createProjectNotificationPublisher({ journal, onStored: store.onStored }), holders: 0 }
    journals.set(profileId, entry)
  }
  const owned = entry
  owned.holders += 1
  let released = false
  return {
    journal: owned.journal,
    publisher: owned.publisher,
    async release() {
      if (released) return
      released = true
      owned.holders -= 1
      if (owned.holders > 0) return
      journals.delete(profileId)
      owned.publisher.closeAdmission()
      await owned.publisher.settled()
    },
  }
}
