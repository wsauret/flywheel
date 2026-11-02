import { readFileSync, realpathSync } from "node:fs"

import { launchRuntimeClient } from "../../../src/cli/runtime-launch.js"
import { isRuntimeListening } from "../../../src/cli/runtime-attach.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import type { StartupDirectories } from "../../../src/infra/directory-authorities.js"
import { accountServeRecordPath, accountServeSocketPath } from "../../../src/infra/paths.js"
import type { AttachedRuntimeClient } from "../../../src/protocol/app-service-types.js"
import { createIsolatedAccountRuntimeAttach, joinIsolatedAccountService } from "./_account-service.js"

// The isolated account service is started through this process's bun, so it serves this process's lane.
const LANE = serveLaneFor(process.execPath)

export async function withProjectRuntime<T>(directories: StartupDirectories, use: (client: AttachedRuntimeClient) => Promise<T>): Promise<T> {
  const canonical = canonicalDirectories(directories)
  const launched = await attachProjectRuntime(canonical)
  try { return await use(launched.client) }
  finally { await launched.dispose(); await stopProjectRuntime(canonical) }
}

export function attachProjectRuntime(directories: StartupDirectories) {
  const canonical = canonicalDirectories(directories)
  return launchRuntimeClient({ ...canonical, attach: createIsolatedAccountRuntimeAttach(canonical) })
}

export function canonicalDirectories(directories: StartupDirectories): StartupDirectories {
  return {
    accountHome: realpathSync(directories.accountHome),
    userDataRoot: realpathSync(directories.userDataRoot),
    projectRoot: realpathSync(directories.projectRoot),
    executionCwd: realpathSync(directories.executionCwd),
  }
}

export async function stopProjectRuntime(given: StartupDirectories, timeoutMs = 30_000): Promise<void> {
  const directories = canonicalDirectories(given)
  const pid = runtimePid(directories)
  if (pid !== undefined) {
    try { process.kill(pid) } catch {}
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && await isRuntimeListening(accountServeSocketPath(directories.userDataRoot, LANE))) await Bun.sleep(25)
  await joinIsolatedAccountService(directories.userDataRoot)
}

export function runtimePid(given: StartupDirectories): number | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(accountServeRecordPath(canonicalDirectories(given).userDataRoot, LANE), "utf8"))
    return typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number" ? value.pid : undefined
  } catch { return undefined }
}
