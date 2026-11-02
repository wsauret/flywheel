import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createGuardianLedger, type LedgerLease } from "../../../src/infra/guardian-ledger.js"
import { Log } from "../../../src/infra/log.js"
import { createProcessHolders, type HolderKernel } from "../../../src/infra/process-holder.js"
import { privateTemporaryRoot } from "../../../src/infra/private-temporary-root.js"
import type { BootIdentity, ProcessStart } from "../../../src/infra/process-container.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporary = temporaryDirectories()

const BOOT = "2507fc47f1c3430b8bc31e1bc9887e94"
const OTHER_BOOT = "0123456789abcdef0123456789abcdef"
const DEAD_GUARDIAN = 4242
/** The guardian of the build a command is handed over to. */
const ADOPTING_GUARDIAN = 5151

const lease: LedgerLease = { token: "owned:1", pid: 321, identity: "321 321 99", stopHold: { path: "/config/.lock", boundMs: 1_000 } }

/** The kernel as a ledger sees it: which pids run, with which start stamp,
 *  in which boot. This process always runs with start "1". */
function kernel(starts: { readonly [pid: number]: string }, boot: string = BOOT): HolderKernel {
  return {
    start: (pid): ProcessStart => {
      const start = pid === process.pid ? "1" : starts[pid]
      return start === undefined ? { kind: "absent" } : { kind: "process", start }
    },
    boot: (): BootIdentity => ({ kind: "boot", id: boot }),
  }
}

/** A record as a guardian with `pid` and `start` wrote it in `boot`. */
function recordOf(directory: string, guardian: { readonly pid: number; readonly start: string; readonly boot: string }, written: LedgerLease = lease): string {
  const path = join(privateTemporaryRoot(directory, "flywheel-leases"), `${encodeURIComponent(written.token)}.${guardian.pid}.json`)
  writeFileSync(path, JSON.stringify({ v: 1, ...written, guardian: { v: 1, ...guardian } }))
  return path
}

describe("guardian ledger", () => {
  test("answers a lease as abandoned once the guardian that recorded it is gone, and never while it runs", () => {
    const directory = temporary("guardian-ledger-")
    // The guardian that records the lease is this process.
    createGuardianLedger(directory, createProcessHolders(kernel({}))).hold(lease)

    expect(createGuardianLedger(directory, createProcessHolders(kernel({}))).abandoned()).toEqual([])

    // A later process that reads the same record after its guardian died.
    recordOf(directory, { pid: DEAD_GUARDIAN, start: "7", boot: BOOT })
    expect(createGuardianLedger(directory, createProcessHolders(kernel({ [DEAD_GUARDIAN]: "8" }))).abandoned())
      .toEqual([{ ...lease, guardianPid: DEAD_GUARDIAN, proof: "another-process" }])
    expect(createGuardianLedger(directory, createProcessHolders(kernel({ [DEAD_GUARDIAN]: "7" }))).abandoned()).toEqual([])
  })

  test("forgets a dropped lease, so nothing is answered for it later", () => {
    const directory = temporary("guardian-ledger-")
    const ledger = createGuardianLedger(directory, createProcessHolders(kernel({})))
    ledger.hold(lease)
    ledger.drop(lease.token, process.pid)

    expect(readdirSync(privateTemporaryRoot(directory, "flywheel-leases"))).toEqual([])
  })

  test("keeps each guardian's record of one token apart, so a guardian that drops its own leaves the adopting guardian's", () => {
    const directory = temporary("guardian-ledger-")
    const holders = createProcessHolders(kernel({}))
    // A handover leases one command under one token in two builds' guardians
    // at once: this process, and the adopting build's guardian.
    const handingOver = createGuardianLedger(directory, holders)
    const adopting = createGuardianLedger(directory, holders, ADOPTING_GUARDIAN)
    handingOver.hold(lease)
    adopting.hold(lease)
    handingOver.drop(lease.token, process.pid)

    // The adopting guardian dies with every other owner, and its record is
    // what the next guardian finds.
    expect(createGuardianLedger(directory, createProcessHolders(kernel({ [ADOPTING_GUARDIAN]: "8" }))).abandoned())
      .toEqual([{ ...lease, guardianPid: ADOPTING_GUARDIAN, proof: "another-process" }])
    adopting.drop(lease.token, ADOPTING_GUARDIAN)
    expect(readdirSync(privateTemporaryRoot(directory, "flywheel-leases"))).toEqual([])
  })

  test("removes a record of another boot without answering it, since every process it names is gone", () => {
    const directory = temporary("guardian-ledger-")
    const path = recordOf(directory, { pid: DEAD_GUARDIAN, start: "7", boot: OTHER_BOOT })

    expect(createGuardianLedger(directory, createProcessHolders(kernel({}))).abandoned()).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  test("leaves each record it cannot read in place, and reports each one once", () => {
    const directory = temporary("guardian-ledger-")
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
      const path = join(privateTemporaryRoot(directory, "flywheel-leases"), `${encodeURIComponent(record.token)}.${DEAD_GUARDIAN}.json`)
      writeFileSync(path, JSON.stringify(record))
      return path
    })
    const warn = spyOn(Log.create({ service: "process-guardian" }), "warn").mockImplementation(() => {})
    try {
      const ledger = createGuardianLedger(directory, createProcessHolders(kernel({})))

      expect(ledger.abandoned()).toEqual([])
      expect(ledger.abandoned()).toEqual([])
      expect(paths.filter((path) => existsSync(path))).toEqual(paths)
      expect(warn).toHaveBeenCalledTimes(unreadable.length)
    } finally {
      warn.mockRestore()
    }
  })
})
