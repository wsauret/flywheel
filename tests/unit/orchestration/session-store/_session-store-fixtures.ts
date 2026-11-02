import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedRuntime } from "effect"
import { EventStoreLive } from "../../../../src/infra/event-store-effect.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"

export const createSessionStoreTestContext = () => {
  const baseDir = mkdtempSync(join(tmpdir(), "flywheel-session-store-"))
  const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(baseDir)))
  return {
    runtime,
    cleanup: async () => {
      await runtime.dispose()
      rmSync(baseDir, { recursive: true, force: true })
    },
  }
}
