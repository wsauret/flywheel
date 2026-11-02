import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { isRuntimeListening, probeRendezvous, readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountServeRecordPath, accountServeSocketPath } from "../../../src/infra/paths.js"
import { createIsolatedAccountRuntimeAttach, joinIsolatedAccountService } from "./_account-service.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

// The isolated account service is started through this process's bun, so it serves this process's lane.
const LANE = serveLaneFor(process.execPath)

// Canonical for the same reason the socket-runtime test gives: the service
// derives its address from the realpath of the account root.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-account-probe-")))
const accountHome = path.join(TMP, "home")
const userDataRoot = path.join(accountHome, ".flywheel")

/** Longer than the dev lane's one-second idle grace, shorter than its
 *  ten-second startup grace: the window in which a counted probe retired
 *  the service before the client that probed could attach. */
const PAST_IDLE_GRACE_MS = 2_500

async function stopAccountService(): Promise<void> {
  const identity = readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))
  if (!identity) return
  try {
    process.kill(identity.pid, "SIGTERM")
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
  }
  await joinIsolatedAccountService(userDataRoot)
  fs.rmSync(accountServeRecordPath(userDataRoot, LANE), { force: true })
}

afterAll(async () => {
  await stopAccountService()
  fs.rmSync(TMP, { recursive: true, force: true })
}, 60_000)

describe("account service holds", () => {
  test("a liveness probe that sends no attach neither holds the service nor ends its startup grace", async () => {
    fs.mkdirSync(userDataRoot, { recursive: true })
    const project = path.join(TMP, "project")
    fs.mkdirSync(path.join(project, ".git"), { recursive: true })
    const attach = createIsolatedAccountRuntimeAttach({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    // `ensure` starts the service and then probes it exactly the way a
    // terminal's launcher does before the terminal process attaches.
    await attach.ensure(() => {})
    const socketPath = accountServeSocketPath(userDataRoot, LANE)
    const started = readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))
    expect(started?.pid).toBeGreaterThan(0)
    // More probes, the shape of a second launcher, a `flywheel web`, and a
    // second start, which asks for the answer to an empty line.
    expect(await isRuntimeListening(socketPath)).toBe(true)
    expect(await isRuntimeListening(socketPath)).toBe(true)
    expect(await probeRendezvous(socketPath, 10_000)).toEqual({ kind: "listening" })

    await Bun.sleep(PAST_IDLE_GRACE_MS)

    // Nothing admitted an attach, so nothing held and nothing ended the
    // startup grace: the same process is still listening for the client.
    expect(await isRuntimeListening(socketPath)).toBe(true)
    expect(readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))?.pid).toBe(started?.pid)
  }, 60_000)
})
