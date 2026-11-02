import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, closeSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import {
  createPersistentSpool,
  recordSpoolHolders,
  sweepPersistentSpools,
  type SpoolHolderProbe,
  type SpoolHolders,
} from "../../../src/infra/persistent-spool.js"
import type { ProcessIdentity } from "../../../src/infra/process-container.js"

const LAUNCHER = 100
const WRITER = 200

let temporary: string

beforeEach(() => { temporary = mkdtempSync(join(tmpdir(), "flywheel-spool-sweep-")) })
afterEach(() => { rmSync(temporary, { recursive: true, force: true }) })

/** The kernel as the sweep sees it: the processes that run now, by pid and
 *  start identity, and the process groups that still run a member. */
function kernel(processes: { readonly [pid: number]: string | "unproven" }, groups: readonly number[] = []): SpoolHolderProbe {
  return {
    identify(pid): ProcessIdentity {
      const running = processes[pid]
      if (running === undefined) return { kind: "absent" }
      return running === "unproven" ? { kind: "unproven" } : { kind: "process", identity: running }
    },
    groupRuns: (pgid) => groups.includes(pgid),
  }
}

async function spoolHeldBy(holders: SpoolHolders | undefined): Promise<string> {
  const spool = createPersistentSpool(temporary)
  closeSync(spool.stdoutFd)
  closeSync(spool.stderrFd)
  if (holders !== undefined) recordSpoolHolders(spool.directory, holders)
  return spool.directory
}

const heldByBoth: SpoolHolders = {
  launcher: { pid: LAUNCHER, identity: "launcher:born" },
  writer: { pid: WRITER, identity: "writer:born" },
}

describe("persistent spool lifetime", () => {
  test("the sweep removes a spool once its launcher and its writer are both proven gone", async () => {
    const spool = await spoolHeldBy(heldByBoth)

    await sweepPersistentSpools({ temporary, probe: kernel({}) })

    expect(existsSync(spool)).toBe(false)
  })

  test("a spool stays while its writer runs, and a recycled writer pid does not pass as that writer", async () => {
    const spool = await spoolHeldBy({ writer: heldByBoth.writer })

    await sweepPersistentSpools({ temporary, probe: kernel({ [WRITER]: "writer:born" }) })
    expect(existsSync(spool)).toBe(true)

    // The pid now names another process: the writer exited and the system
    // gave its number away.
    await sweepPersistentSpools({ temporary, probe: kernel({ [WRITER]: "stranger:born" }) })
    expect(existsSync(spool)).toBe(false)
  })

  test("a spool stays while its launcher still reads it, after its writer exited", async () => {
    const spool = await spoolHeldBy(heldByBoth)

    await sweepPersistentSpools({ temporary, probe: kernel({ [LAUNCHER]: "launcher:born" }) })
    expect(existsSync(spool)).toBe(true)

    await sweepPersistentSpools({ temporary, probe: kernel({ [LAUNCHER]: "stranger:born" }) })
    expect(existsSync(spool)).toBe(false)
  })

  test("a writer's process group that still runs keeps the spool after the writer itself exited", async () => {
    const spool = await spoolHeldBy({ writer: heldByBoth.writer })

    await sweepPersistentSpools({ temporary, probe: kernel({}, [WRITER]) })
    expect(existsSync(spool)).toBe(true)

    await sweepPersistentSpools({ temporary, probe: kernel({}) })
    expect(existsSync(spool)).toBe(false)
  })

  test("nothing short of proof removes a spool", async () => {
    const unproven = await spoolHeldBy(heldByBoth)
    const unrecorded = await spoolHeldBy(undefined)
    const writerOfUnknownIdentity = await spoolHeldBy({ writer: { pid: WRITER } })
    const futureRecord = await spoolHeldBy(undefined)
    writeFileSync(join(futureRecord, "holders.json"), JSON.stringify({ version: 2, writers: [WRITER] }))

    await sweepPersistentSpools({ temporary, probe: kernel({ [LAUNCHER]: "unproven", [WRITER]: "stranger:born" }) })
    expect(existsSync(unproven)).toBe(true)
    await sweepPersistentSpools({ temporary, probe: kernel({ [WRITER]: "stranger:born" }) })

    expect(existsSync(unproven)).toBe(false)
    expect(existsSync(unrecorded)).toBe(true)
    // A pid that runs a process proves nothing against a writer whose own
    // identity was never read.
    expect(existsSync(writerOfUnknownIdentity)).toBe(true)
    expect(existsSync(futureRecord)).toBe(true)
  })

  test.skipIf(process.platform === "win32")("a spool root that another user can enter, or that is a link, is never used or swept", async () => {
    const spool = await spoolHeldBy(heldByBoth)
    const root = dirname(spool)
    chmodSync(root, 0o755)

    expect(() => createPersistentSpool(temporary)).toThrow("is not a private directory of this user")
    await sweepPersistentSpools({ temporary, probe: kernel({}) })
    expect(existsSync(spool)).toBe(true)

    chmodSync(root, 0o700)
    const linked = mkdtempSync(join(tmpdir(), "flywheel-spool-linked-"))
    try {
      symlinkSync(root, join(linked, basename(root)))
      expect(() => createPersistentSpool(linked)).toThrow("is not a private directory of this user")
      await sweepPersistentSpools({ temporary: linked, probe: kernel({}) })
      expect(existsSync(spool)).toBe(true)
    } finally {
      rmSync(linked, { recursive: true, force: true })
    }
  })
})
