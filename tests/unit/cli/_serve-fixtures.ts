import { afterEach, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { createLoginShellPath, type LoginShellPath } from "../../../src/infra/login-shell-path.js"
import { accountServeStartRecordPath } from "../../../src/infra/paths.js"
import type { LauncherContext } from "../../../src/infra/process-supervisor.js"
import { ServeLifetime } from "../../../src/orchestration/app-service/serve-lifetime.js"
import { admitServiceStart } from "../../../src/orchestration/update/service-start.js"
import { createServeStatusReader } from "../../../src/protocol/serve-handshake.js"
import { placeBuild } from "../../helpers/placed-build.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

/** An account home a serve test runs in, and the directory that holds it. */
export interface ShortAccountHome {
  readonly root: string
  readonly accountHome: string
  readonly userDataRoot: string
}

/** A factory of account homes that the calling test file owns, each removed
 *  after the case that made it. Each home sits directly under
 *  `socketTemporaryRoot()`, because a serve binds its lane's socket inside
 *  the home. Call it once at the top level of a file,
 *  because it registers an `afterEach` hook in that scope. */
export function shortAccountHomes(): (prefix: string) => ShortAccountHome {
  const created: string[] = []
  afterEach(() => {
    for (const root of created.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })
  return (prefix) => {
    const root = fs.mkdtempSync(path.join(socketTemporaryRoot(), prefix))
    created.push(root)
    const accountHome = path.join(root, "home")
    return { root, accountHome, userDataRoot: path.join(accountHome, ".flywheel") }
  }
}

/** Polls `check` until it holds, and fails after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("serve did not become ready")
    await Bun.sleep(10)
  }
}

/** A service-local login shell PATH whose probe runs nothing, so a serve under
 *  test never runs the person's login shell or touches the process holder. */
export function unprobedLoginShellPath(): LoginShellPath {
  return { ...createLoginShellPath(), probe: async () => {} }
}

/** A launcher for a serve that opens no project, so it launches nothing. */
export function unusedLauncher(): LauncherContext {
  return {
    scope: {
      spawnOwned: async () => { throw new Error("this serve must not launch a process") },
      adoptOwned: async () => { throw new Error("this serve must not adopt a command") },
      open: () => { throw new Error("this serve must not open a launch scope") },
      close: async () => ({ settled: true }),
    },
    guardian: {
      openGeneration: async () => { throw new Error("this serve must not open a guardian generation") },
      pid: async () => 0,
    },
    startGuardian: async () => {},
  }
}

/** The installed build a start in these tests runs as. The entry counts
 *  that start before `runServe` is called, as it does for a real service. */
export const INSTALLED = { version: "1.4.0", buildId: "b".repeat(64) } as const

export async function countStart(userDataRoot: string): Promise<void> {
  expect(await admitServiceStart({ userDataRoot, execPath: placeBuild(userDataRoot, INSTALLED), nowMs: Date.now() })).toBe("serve")
}

export function startRecordText(userDataRoot: string): string {
  return fs.readFileSync(accountServeStartRecordPath(userDataRoot), "utf8")
}

/** The status records a serve printed, read in order as a client reads them. */
export function statusRecords(output: readonly string[]) {
  const read = createServeStatusReader()
  return output.join("").split("\n").flatMap((line) => read(line) ?? [])
}

/** A serve that retires once nothing holds it, so a start that serves ends
 *  on its own, before its probation's minute, which never fires. */
export const IDLE_SERVE = {
  drainWatchdog: () => ({ arm() {}, dispose: async () => {} }),
  loginShellPath: unprobedLoginShellPath(),
  startHub: () => ({ origin: "http://127.0.0.1:41000", held: () => true, stop() {} }),
  serveLifetime: () => new ServeLifetime({ resident: false, startupGraceMs: 20, idleGraceMs: 10 }),
  installedBuild: () => undefined,
  probation: () => () => {},
}
