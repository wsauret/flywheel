import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { isRuntimeListening, readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { sweepPersistentSpools } from "../../../src/infra/persistent-spool.js"
import { createProcessTemporaryDirectory, removeProcessTemporaryDirectory } from "../../../src/infra/process-temporary-directory.js"
import { accountServeRecordPath, accountServeSocketPath } from "../../../src/infra/paths.js"
import { decodeServeStatusLine, type ServeStatusRecord } from "../../../src/protocol/serve-handshake.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { descendantProcesses, identifyProcess, killIdentifiedProcess, processAlive, type ProcessIdentity } from "../../helpers/real-process-fixture.js"
import { removeWhenReleased } from "../../helpers/remove-when-released.js"

// A source run serves the dev lane, and `serve ensure` finds or starts that lane's service.
const LANE = serveLaneFor(process.execPath)
const ENTRY = fileURLToPath(new URL("../../../scripts/dev.ts", import.meta.url))
// Canonical, because the service address is a hash of the account data root
// string, and the temporary directory can be reached through a link.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "fw-serve-ensure-")))
const userDataRoot = path.join(TMP, ".flywheel")
const services = new Map<number, ProcessIdentity>()

afterAll(async () => {
  for (const [pid, identity] of services) {
    const descendants = await descendantProcesses(pid)
    for (const row of descendants.toReversed()) {
      const descendant = identifyProcess(row.pid)
      if (descendant) killIdentifiedProcess(descendant)
    }
    killIdentifiedProcess(identity)
    const deadline = Date.now() + 30_000
    for (const target of [pid, ...descendants.map((row) => row.pid)]) {
      while (processAlive(target)) {
        if (Date.now() >= deadline) throw new Error(`serve ensure cleanup did not release process ${target}`)
        await Bun.sleep(50)
      }
    }
  }
  // The ensure command that launched each service exited at once, so no
  // launcher reaps the service's spool; the sweep every launch runs removes a
  // spool whose writer is gone, and it runs here once the services are.
  await sweepPersistentSpools()
  // Force-stopped services leave extracted native assets outside their home.
  // Their owners reclaim those entries once the owning processes are gone.
  for (const stem of ["fw-ipc", "flywheel-native"] as const) await removeProcessTemporaryDirectory(await createProcessTemporaryDirectory(stem))
  if (!process.env.FW_KEEP_TMP) removeWhenReleased(TMP)
}, 60_000)

/** Runs `flywheel serve ensure` as the editor extension does, in an isolated
 *  home whose service binds an ephemeral hub, and answers every status record
 *  it printed and how it exited. */
async function serveEnsure(): Promise<{ readonly code: number; readonly records: readonly ServeStatusRecord[] }> {
  const child = Bun.spawn([process.execPath, "--conditions=browser", ENTRY, "serve", "ensure"], {
    cwd: TMP,
    env: {
      ...process.env,
      HOME: TMP,
      FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1",
      FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
    },
    stdout: "pipe",
    stderr: "inherit",
    windowsHide: true,
  })
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  const records = stdout.split("\n").flatMap((line) => {
    const record = decodeServeStatusLine(line)
    return record === undefined ? [] : [record]
  })
  return { code, records }
}

describe("flywheel serve ensure", () => {
  test("starts this lane's service where no registration starts it, prints the listening record of the service that answered, and exits; a second run finds it", async () => {
    const started = await serveEnsure()
    const listening = started.records.find((record) => record.flywheel === "serve.listening")
    if (listening?.flywheel !== "serve.listening") throw new Error(`serve ensure printed no listening record: ${JSON.stringify(started.records)}`)
    const identity = identifyProcess(listening.pid)
    if (identity === undefined) throw new Error(`cannot identify the listening service ${listening.pid}`)
    services.set(listening.pid, identity)
    expect(started.code).toBe(0)
    expect(listening).toMatchObject({ protocolVersion: RUNTIME_PROTOCOL_VERSION, lane: LANE })
    // The record names the service that listens, not the command that asked for it.
    expect(readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))?.pid).toBe(listening.pid)
    expect(await isRuntimeListening(accountServeSocketPath(userDataRoot, LANE))).toBe(true)

    const again = await serveEnsure()
    expect(again.code).toBe(0)
    expect(again.records.filter((record) => record.flywheel === "serve.listening")).toEqual([listening])
  }, 120_000)
})
