import { afterEach } from "bun:test";
import { join } from "node:path";
import { asAsyncEventReadSurface, asAsyncEventWriter, type LocalSqliteEventStore } from "../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js";
import { createSessionFactWriter } from "../../src/orchestration/session/session-fact-writer.js";
import { temporaryDirectories } from "./directories.js";
import type { DurableOwner } from "../../src/infra/durable-owner.js";

/** Real checkpoint persistence for assembled-runner tests without a live
 *  session host. The calling file owns every store it makes: each store is
 *  closed after its case, and then its directory is removed. Call it at the
 *  top level of the file, never inside a test, because it registers hooks in
 *  that scope. Bun loads a helper module once per test process, so hooks
 *  registered when the helper loads would belong only to the first file that
 *  imports it. */
export function checkpointTestPersistences(): (owner?: DurableOwner) => ReturnType<typeof persistenceOver> {
  const temporaryDirectory = temporaryDirectories();
  const stores: LocalSqliteEventStore[] = [];
  afterEach(() => { for (const store of stores.splice(0)) store.close(); });
  return (owner = { kind: "session", sessionId: "session" }) => {
    const store = createSqliteEventStore(join(temporaryDirectory("checkpoint-assembly-"), "events.sqlite"));
    stores.push(store);
    return persistenceOver(store, owner);
  };
}

function persistenceOver(store: LocalSqliteEventStore, owner: DurableOwner) {
  return {
    sessionEventReader: asAsyncEventReadSurface(store),
    sessionEventWriter: createSessionFactWriter({ owner, writer: asAsyncEventWriter(store) }),
  };
}
