import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Log } from "./log.js"
import { privateTemporaryRoot, type PrivateTemporaryRootStem } from "./private-temporary-root.js"
import { decodeStopHold, hasExactKeys, objectFields } from "./process-guardian-protocol.js"
import { decodeHolderFields, processHolders, type GoneProof } from "./process-holder.js"
import type { StopHold } from "./stop-hold.js"

/** The durable copy of a process guardian's leases (ARCH-TOOLS-025).
 *
 *  A guardian's leases live in its memory, and three processes back an owned
 *  container while it runs: its launcher, its guardian, and its command
 *  supervisor. Each one ends the container when it sees another one die. A
 *  hard kill of the whole account service (`flywheel kill`, a force quit, an
 *  OOM kill) ends all three at once, so none of them sees anything, and the
 *  payload keeps running in its process group with no parent. The guardian
 *  therefore records each lease in this ledger before it answers the
 *  adoption, and removes the record when the lease ends. The next guardian
 *  reads what a dead guardian left and ends it.
 *
 *  A record names its guardian by pid, start stamp, and boot, as every
 *  durable process record does (`process-holder.ts`), and names its
 *  container by pid and the identity the guardian proved when it adopted it.
 *  The records live in one private root of this user in the temporary
 *  directory, `flywheel-leases-<uid>`, one file per lease and guardian, named
 *  `<token>.<guardian pid>.json` with the token URI-encoded. A handover leases
 *  one command under one token in two builds' guardians at once, so each
 *  guardian's record is a file of its own, and a guardian that ends its lease
 *  removes its own record and never the other's. A record needs to survive
 *  the death of processes, not of the host: a reboot ends every process it
 *  names, so no write is synced.
 *
 *  Only macOS and Linux keep a ledger. A Windows container is a job object
 *  with `KILL_ON_JOB_CLOSE`, and only Flywheel processes hold a handle to it,
 *  so Windows itself ends the container when they all die.
 *
 *  The format is durable: version 1 is `{v: 1, token, pid, identity,
 *  stopHold, guardian: {pid, v: 1, start, boot}}`. A record of another
 *  version, or one that does not decode, is reported and left in place. */

const log = Log.create({ service: "process-guardian" })

const LEDGER_ROOT_STEM = "flywheel-leases" satisfies PrivateTemporaryRootStem
const RECORD_SUFFIX = ".json"

/** One lease as the ledger keeps it. */
export interface LedgerLease {
  readonly token: string
  /** The pid that names the container: its supervisor, which leads its
   *  process group. */
  readonly pid: number
  /** The container's identity when the guardian adopted it. */
  readonly identity: string
  readonly stopHold: StopHold | null
}

/** A lease whose guardian is proven gone in this boot, with the proof. */
export interface AbandonedLease extends LedgerLease {
  readonly guardianPid: number
  readonly proof: Exclude<GoneProof, "another-boot">
}

export interface GuardianLedger {
  /** Records a lease of this guardian. A record that cannot be written is
   *  reported, and the lease stands without it: the live owners still back
   *  the container, and only the backstop for a death of all of them is
   *  lost. */
  hold(lease: LedgerLease): void
  /** Removes the record that guardian `guardianPid` wrote for `token`. A
   *  guardian removes its own; a host or a later guardian removes one in the
   *  place of a guardian that is gone. */
  drop(token: string, guardianPid: number): void
  /** The leases on record whose guardian is proven gone in this boot. A
   *  record of another boot names processes that no longer exist, so it is
   *  removed here, and a record whose guardian runs or is not proven gone is
   *  left alone. */
  abandoned(): readonly AbandonedLease[]
}

/** A version 1 record as `abandoned` reads it. */
interface LeaseRecord extends LedgerLease {
  readonly guardian: { readonly pid: number; readonly v: 1; readonly start: string; readonly boot?: string }
}

/** The record a guardian wrote, or nothing for a value of another shape.
 *  It reads by hand with exact keys, as the guardian protocol reads its
 *  frames, so the guardian loads no schema library for one small record. */
function decodeRecord(value: unknown): LeaseRecord | undefined {
  const record = objectFields(value)
  if (!record || record.v !== 1 || !hasExactKeys(record, ["v", "token", "pid", "identity", "stopHold", "guardian"])) return undefined
  const { token, pid, identity } = record
  const stopHold = decodeStopHold(record.stopHold)
  if (typeof token !== "string" || !isPid(pid) || typeof identity !== "string" || stopHold === undefined) return undefined
  const guardian = objectFields(record.guardian)
  if (!guardian || guardian.v !== 1 || !isPid(guardian.pid) || typeof guardian.start !== "string") return undefined
  const { boot } = guardian
  if (boot !== undefined && typeof boot !== "string") return undefined
  if (!hasExactKeys(guardian, boot === undefined ? ["pid", "v", "start"] : ["pid", "v", "start", "boot"])) return undefined
  return { token, pid, identity, stopHold, guardian: { pid: guardian.pid, v: 1, start: guardian.start, ...(boot === undefined ? {} : { boot }) } }
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}

/** The ledger of this user's guardians in `temporary`. `holders` answers who
 *  this guardian is and whether a recorded guardian still runs, and `writer`
 *  is the pid of the guardian whose leases `hold` records: this process. */
export function createGuardianLedger(
  temporary: string = tmpdir(),
  holders: Pick<typeof processHolders, "own" | "state"> = processHolders,
  writer: number = process.pid,
): GuardianLedger {
  let unwritable = false
  const unreadable = new Set<string>()
  const root = (): string => privateTemporaryRoot(temporary, LEDGER_ROOT_STEM)
  const recordPath = (directory: string, token: string, guardianPid: number): string => join(directory, `${encodeURIComponent(token)}.${guardianPid}${RECORD_SUFFIX}`)

  const remove = (path: string): void => {
    try {
      rmSync(path, { force: true })
    } catch (error) {
      log.debug("a guardian ledger record could not be removed; a later guardian removes it", { error: errorCode(error) })
    }
  }

  return {
    hold(lease) {
      try {
        const own = holders.own()
        // A record whose guardian has no start stamp could never be proven
        // gone, and one without its boot could pass for a record of this
        // boot after a restart, so neither is written.
        if (own?.boot === undefined) throw new Error("this guardian could not read its own identity and boot")
        const directory = root()
        const path = recordPath(directory, lease.token, writer)
        const staged = `${path}.tmp`
        const record = { v: 1, ...lease, guardian: { pid: writer, ...own } }
        writeFileSync(staged, JSON.stringify(record), { mode: 0o600 })
        renameSync(staged, path)
      } catch (error) {
        if (unwritable) return
        unwritable = true
        log.warn("the guardian could not record a lease; a crash of every owner of that container would leave it running", { token: lease.token, error: error instanceof Error ? error.message : String(error) })
      }
    },
    drop(token, guardianPid) {
      try {
        remove(recordPath(root(), token, guardianPid))
      } catch (error) {
        log.debug("the guardian ledger could not be opened to remove a record", { error: errorCode(error) })
      }
    },
    abandoned() {
      let directory: string
      let names: readonly string[]
      try {
        directory = root()
        names = readdirSync(directory).filter((name) => name.endsWith(RECORD_SUFFIX))
      } catch (error) {
        log.debug("the guardian ledger could not be read", { error: errorCode(error) })
        return []
      }
      const abandoned: AbandonedLease[] = []
      for (const name of names) {
        const path = join(directory, name)
        let parsed: unknown
        try {
          parsed = JSON.parse(readFileSync(path, "utf8"))
        } catch (error) {
          // Removed by its own guardian since the listing.
          if (errorCode(error) === "ENOENT") continue
          parsed = undefined
        }
        const decoded = decodeRecord(parsed)
        if (decoded === undefined) {
          if (!unreadable.has(name)) {
            unreadable.add(name)
            log.warn("a guardian ledger record has a shape this build cannot read, so it stays", { record: name })
          }
          continue
        }
        const { guardian: { pid: guardianPid, ...identity }, ...lease } = decoded
        const state = holders.state(decodeHolderFields(guardianPid, identity))
        if (state.kind !== "gone") continue
        if (state.proof === "another-boot") {
          remove(path)
          continue
        }
        abandoned.push({ ...lease, guardianPid, proof: state.proof })
      }
      return abandoned
    },
  }
}

/** This host's ledger, or none on Windows, where `KILL_ON_JOB_CLOSE` ends a
 *  job once its last Flywheel handle closes. */
export const platformGuardianLedger: GuardianLedger | undefined = process.platform === "win32" ? undefined : createGuardianLedger()

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : String(error)
}
