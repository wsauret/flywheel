import { readFileSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { createAccountRuntimeAttach, isRuntimeListening, readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { launchRuntimeClient } from "../../../src/cli/runtime-launch.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import type { StartupDirectories } from "../../../src/infra/directory-authorities.js"
import { accountServeRecordPath, accountServeSocketPath } from "../../../src/infra/paths.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"

// The isolated account service is started through this process's bun, so it serves this process's lane.
const LANE = serveLaneFor(process.execPath)

const starts = new Map<string, Promise<void>>()
const services = new Map<string, Bun.Subprocess<"pipe", "inherit", "inherit">>()

/** Where the isolated service records the origin of its hub, which binds an
 *  ephemeral port. */
export function isolatedHubRecordPath(accountHome: string): string {
  return path.join(accountHome, "isolated-hub-origin")
}

/** The origin the isolated service's hub answers at, once it has started. */
export function isolatedHubOrigin(accountHome: string): string {
  return readFileSync(isolatedHubRecordPath(accountHome), "utf8").trim()
}

export function createIsolatedAccountRuntimeAttach(directories: StartupDirectories) {
  const attach = createAccountRuntimeAttach({ ...directories, allowPersistentProcesses: false })
  return {
    ...attach,
    async ensure(report: Parameters<typeof attach.ensure>[0]): ReturnType<typeof attach.ensure> {
      const socketPath = accountServeSocketPath(directories.userDataRoot, LANE)
      if (!await isRuntimeListening(socketPath)) {
        report({ kind: "phase", label: "Starting account service" })
        let start = starts.get(socketPath)
        if (start === undefined) {
          start = startIsolatedAccountService(directories, socketPath)
          starts.set(socketPath, start)
          void start.finally(() => { starts.delete(socketPath) })
        }
        await start
      }
      return await attach.ensure(report)
    },
  }
}

/** Starts the isolated account service with no client attached, the way a
 *  service manager starts a successor, and resolves once it listens. */
export async function startIsolatedAccountService(directories: StartupDirectories, socketPath = accountServeSocketPath(directories.userDataRoot, LANE)): Promise<void> {
  const child = Bun.spawn([
    process.execPath,
    "--conditions=browser",
    fileURLToPath(new URL("_vscode-account-service.ts", import.meta.url)),
  ], {
    cwd: directories.executionCwd,
    env: { ...process.env, HOME: directories.accountHome },
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  })
  services.set(socketPath, child)
  const deadline = Date.now() + 30_000
  while (
    !await isRuntimeListening(socketPath)
    || readRuntimeIdentity(accountServeRecordPath(directories.userDataRoot, LANE))?.protocolVersion !== RUNTIME_PROTOCOL_VERSION
  ) {
    const exit = await Promise.race([child.exited, Bun.sleep(25).then(() => undefined)])
    if (exit !== undefined) throw new Error(`isolated account service exited with code ${exit}`)
    if (Date.now() >= deadline) throw new Error("isolated account service did not start")
  }
}

/** Waits for the isolated service this process started to exit and returns
 *  its exit code; undefined when this process started none. */
export async function joinIsolatedAccountService(userDataRoot: string): Promise<number | undefined> {
  const socketPath = accountServeSocketPath(userDataRoot, LANE)
  const child = services.get(socketPath)
  if (child === undefined) return undefined
  const code = await child.exited
  services.delete(socketPath)
  return code
}

/** Requests the real graceful shutdown path through the fixture's private
 * input, then waits for the service to release its resources. */
export async function stopIsolatedAccountService(userDataRoot: string): Promise<void> {
  const child = services.get(accountServeSocketPath(userDataRoot, LANE))
  if (child?.exitCode === null) {
    child.stdin.write("stop\n")
    await child.stdin.flush()
  }
  await joinIsolatedAccountService(userDataRoot)
}

/** Prepared account-service fixture. Production terminal launch remains on the
 * legacy project runtime until the atomic cutover phase. */
export async function attachAccountProject(directories: StartupDirectories) {
  const canonical = {
    userDataRoot: realpathSync(directories.userDataRoot),
    accountHome: realpathSync(directories.accountHome),
    projectRoot: realpathSync(directories.projectRoot),
    executionCwd: realpathSync(directories.executionCwd),
  }
  return await launchRuntimeClient({
    ...canonical,
    attach: createIsolatedAccountRuntimeAttach(canonical),
  })
}
