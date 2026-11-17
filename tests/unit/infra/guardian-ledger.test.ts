import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { platformGuardianLedger, type GuardianLedger } from "../../../src/infra/guardian-ledger.js"
import { Log } from "../../../src/infra/log.js"
import { processHolders } from "../../../src/infra/process-holder.js"
import { privateTemporaryRoot } from "../../../src/infra/private-temporary-root.js"
import type { BootIdentity, ProcessStart } from "../../../src/infra/process-container.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { processHoldersOver } from "../../helpers/process-holders.js"

const temporary = temporaryDirectories()

const BOOT = "2507fc47f1c3430b8bc31e1bc9887e94"
const OTHER_BOOT = "0123456789abcdef0123456789abcdef"
const DEAD_GUARDIAN = 4242
/** The guardian of the build a command is handed over to. */
const ADOPTING_GUARDIAN = 5151

type LedgerLease = Parameters<GuardianLedger["hold"]>[0]

const lease: LedgerLease = { token: "owned:1", pid: 321, identity: "321 321 99", stopHold: { path: "/config/.lock", boundMs: 1_000 } }

/** The private root the ledger keeps its records in. Each case points the
 *  temporary directory at a folder of its own, so the ledger never reads or
 *  removes the records of this user's running guardians. */
const ledgerRoot = (): string => privateTemporaryRoot(tmpdir(), "flywheel-leases")

const restores: (() => void)[] = []

function restoreKernel(): void {
  for (const restore of restores.splice(0)) restore()
}

const userTemporary = process.env.TMPDIR

beforeEach(() => {
  process.env.TMPDIR = temporary("guardian-ledger-")
})

afterEach(() => {
  restoreKernel()
  if (userTemporary === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = userTemporary
})

/** Makes the kernel, as the ledger's holder answers see it, say which pids
 *  run, with which start stamp, in which boot. This process always runs with
 *  start "1". */
async function kernel(starts: { readonly [pid: number]: string }, boot: string = BOOT): Promise<void> {
  const holders = await processHoldersOver({
    start: (pid): ProcessStart => {
      const start = pid === process.pid ? "1" : starts[pid]
      return start === undefined ? { kind: "absent" } : { kind: "process", start }
    },
    boot: (): BootIdentity => ({ kind: "boot", id: boot }),
  })
  restoreKernel()
  const own = spyOn(processHolders, "own").mockImplementation(() => holders.own())
  const state = spyOn(processHolders, "state").mockImplementation((holder) => holders.state(holder))
  restores.push(() => { own.mockRestore() }, () => { state.mockRestore() })
}

/** A record as a guardian with `pid` and `start` wrote it in `boot`. */
function recordOf(guardian: { readonly pid: number; readonly start: string; readonly boot: string }, written: LedgerLease = lease): string {
  const path = join(ledgerRoot(), `${encodeURIComponent(written.token)}.${guardian.pid}.json`)
  writeFileSync(path, JSON.stringify({ v: 1, ...written, guardian: { v: 1, ...guardian } }))
  return path
}

// Windows keeps no ledger: `KILL_ON_JOB_CLOSE` ends a container once its
// last Flywheel handle closes.
describe.skipIf(platformGuardianLedger === undefined)("guardian ledger", () => {
  const ledger = (): GuardianLedger => platformGuardianLedger ?? expect.unreachable("this host keeps no guardian ledger")

  test("answers a lease as abandoned once the guardian that recorded it is gone, and never while it runs", async () => {
    await kernel({})
    // The guardian that records the lease is this process.
    ledger().hold(lease)
    expect(ledger().abandoned()).toEqual([])

    // A later process that reads the same record after its guardian died.
    recordOf({ pid: DEAD_GUARDIAN, start: "7", boot: BOOT })
    await kernel({ [DEAD_GUARDIAN]: "8" })
    expect(ledger().abandoned()).toEqual([{ ...lease, guardianPid: DEAD_GUARDIAN, proof: "another-process" }])
    await kernel({ [DEAD_GUARDIAN]: "7" })
    expect(ledger().abandoned()).toEqual([])
  })

  test("forgets a dropped lease, so nothing is answered for it later", async () => {
    await kernel({})
    ledger().hold(lease)
    ledger().drop(lease.token, process.pid)

    expect(readdirSync(ledgerRoot())).toEqual([])
  })

  test("keeps each guardian's record of one token apart, so a guardian that drops its own leaves the adopting guardian's", async () => {
    await kernel({ [ADOPTING_GUARDIAN]: "9" })
    // A handover leases one command under one token in two builds' guardians
    // at once: this process, and the adopting build's guardian.
    ledger().hold(lease)
    recordOf({ pid: ADOPTING_GUARDIAN, start: "9", boot: BOOT })
    ledger().drop(lease.token, process.pid)

    // The adopting guardian dies with every other owner, and its record is
    // what the next guardian finds.
    await kernel({ [ADOPTING_GUARDIAN]: "8" })
    expect(ledger().abandoned()).toEqual([{ ...lease, guardianPid: ADOPTING_GUARDIAN, proof: "another-process" }])
    ledger().drop(lease.token, ADOPTING_GUARDIAN)
    expect(readdirSync(ledgerRoot())).toEqual([])
  })

  test("removes a record of another boot without answering it, since every process it names is gone", async () => {
    await kernel({})
    const path = recordOf({ pid: DEAD_GUARDIAN, start: "7", boot: OTHER_BOOT })

    expect(ledger().abandoned()).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  test("leaves each record it cannot read in place, and reports each one once", async () => {
    await kernel({})
    const guardian = { v: 1, pid: DEAD_GUARDIAN, start: "7", boot: BOOT }
    // Another version, a key version 1 does not define, and a guardian pid
    // that names no process: each of a dead guardian, so a record this build
    // read would be answered.
    const unreadable = [
      { v: 2, token: "owned:2" },
      { v: 1, ...lease, token: "owned:3", guardian, extra: true },
      { v: 1, ...lease, token: "owned:4", guardian: { ...guardian, pid: 0 } },
    ]
    const paths = unreadable.map((record) => {
      const path = join(ledgerRoot(), `${encodeURIComponent(record.token)}.${DEAD_GUARDIAN}.json`)
      writeFileSync(path, JSON.stringify(record))
      return path
    })
    const warn = spyOn(Log.create({ service: "process-guardian" }), "warn").mockImplementation(() => {})
    try {
      expect(ledger().abandoned()).toEqual([])
      expect(ledger().abandoned()).toEqual([])
      expect(paths.filter((path) => existsSync(path))).toEqual(paths)
      expect(warn).toHaveBeenCalledTimes(unreadable.length)
    } finally {
      warn.mockRestore()
    }
  })
})
