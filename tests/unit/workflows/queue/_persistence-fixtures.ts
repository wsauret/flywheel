import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js";
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js";
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js";

export function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "queue-persist-test-"));
}

export function makeQueueStores(baseDir: string, sessionId: string) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
  const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) });
  return { store, writer };
}

