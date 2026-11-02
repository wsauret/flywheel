import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import type { EventStore } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import type { SessionManagerDeps } from "../../../../src/orchestration/session/manager";

export const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-resume-integ-${process.pid}-${Date.now()}`,
);

export const stores: EventStore[] = [];

export function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeDeps(projectRoot: string): SessionManagerDeps {
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot));
  stores.push(store);
  return { projectRoot, executionCwd: projectRoot, store };
}

/** Close any stores opened via makeDeps and remove the shared tmp root. */
export function cleanupStores(): void {
  for (const store of stores.splice(0)) store.close();
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // May not exist
  }
}
