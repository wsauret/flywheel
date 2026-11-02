import { readFileSync, writeFileSync } from "node:fs"

import { selectStartupDirectories } from "../../../src/infra/directory-authorities.js"
import { Log } from "../../../src/infra/log.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { runServe } from "../../../src/cli/serve.js"
import { createCliLauncher } from "../../../src/cli/runtime-launch.js"
import type { AccountServiceRuntimeOptions } from "../../../src/orchestration/app-service/account-service-runtime.js"
import {
  createAccountHubHandler,
  type AccountHubOptions,
  type Hub,
} from "../../../src/orchestration/app-service/web-serving/hub.js"
import { isolatedHubRecordPath } from "./_account-service.js"

/** The hub on an ephemeral port, so it never meets the person's own
 *  service, with its origin recorded where a test reads it. */
function startIsolatedHub(options: AccountHubOptions): Hub {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => handle(request),
  })
  const origin = `http://127.0.0.1:${server.port}`
  const handle = createAccountHubHandler(options, origin)
  writeFileSync(isolatedHubRecordPath(directories.accountHome), `${origin}\n`)
  return {
    origin,
    held: () => true,
    stop: () => { server.stop(true) },
  }
}

/** Account updates that never check: a test that must stay off the network
 *  and needs no update work sets FLYWHEEL_TEST_NO_UPDATE_CHECK. */
const idleUpdates: AccountServiceRuntimeOptions["createUpdates"] = () => ({
  status: () => ({ revision: 0, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "idle" } }),
  setAutoInstall: async () => ({ ok: true }),
  refreshPolicy: () => {},
  subscribe: () => () => {},
  start: () => {},
  dispose: async () => {},
})

/** The installed build a test names in place of the real `current` link: a
 *  JSON file with `buildId` and `version`, re-read on every request so a test
 *  can install a newer build while the service runs. */
function installedBuildFromFile(file: string): () => { buildId: string; version: string } | undefined {
  return () => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (typeof parsed !== "object" || parsed === null || !("buildId" in parsed) || !("version" in parsed)) return undefined
      if (typeof parsed.buildId !== "string" || typeof parsed.version !== "string") return undefined
      return { buildId: parsed.buildId, version: parsed.version }
    } catch {
      return undefined
    }
  }
}

const directories = selectStartupDirectories({ env: process.env, cwd: process.cwd() })
// The account log, where `flywheel serve` writes its diagnostics.
await Log.init({ dir: directories.accountHome })
const installedBuildFile = process.env.FLYWHEEL_TEST_INSTALLED_BUILD_FILE
const cutLimit = process.env.FLYWHEEL_TEST_REPLACEMENT_CUT_LIMIT_MS
const launcher = await createCliLauncher()
const persistentProcessManager = createPersistentProcessManager()

// Windows hard kills do not deliver a graceful signal. Only the fixture
// parent holds this input, which invokes the production shutdown listener.
process.stdin.once("data", () => { process.emit("SIGINT") })

try {
  // The exit code is the service's answer to its manager, as `flywheel serve` gives it.
  process.exitCode = await runServe([], directories, launcher, persistentProcessManager, false, {
    startHub: startIsolatedHub,
    ...(cutLimit === undefined ? {} : { replacementCutLimitMs: Number(cutLimit) }),
    // The build the file names at start is the one this service executes; a
    // later write to the file is an install that activates a newer build.
    ...(installedBuildFile === undefined ? {} : (() => {
      const readBuild = installedBuildFromFile(installedBuildFile)
      const ownBuildId = readBuild()?.buildId
      return { ownBuildId: () => ownBuildId, installedBuild: readBuild }
    })()),
    ...(process.env.FLYWHEEL_TEST_NO_UPDATE_CHECK === "1" ? { createUpdates: idleUpdates } : {}),
  })
} finally {
  process.stdin.destroy()
  persistentProcessManager.releaseAll()
  await launcher.dispose()
  await Log.closeGlobal()
}
