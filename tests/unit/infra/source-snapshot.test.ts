import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { sourceSnapshotHome } from "../../../src/infra/cli-subprocess.js"
import { ContainedDirectory } from "../../../src/infra/descriptor-directory.js"
import { Log } from "../../../src/infra/log.js"
import { sharedHoldersIn } from "../../../src/infra/ownership-file-lock.js"
import { encodeHolderText, processHolders } from "../../../src/infra/process-holder.js"
import { enterSourceSnapshot, recordSnapshotProved, refuseSourceSnapshot, SOURCE_FILE_SET, sweepSourceSnapshots, type ServiceSource, type SourceEntry } from "../../../src/infra/source-snapshot.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { SNAPSHOT_SOURCE_FILES as SOURCE, snapshotFixture } from "../../helpers/source-snapshot-fixture.js"

const REPOSITORY = resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const temporaryDirectory = temporaryDirectories()

/** What a checkout holds beside its source, which no snapshot copies. */
const NOT_SOURCE = new Map([
  ["crates/tokenizer/Cargo.toml", "[package]\n"],
  ["webview/index.html", "<html></html>\n"],
  ["webview/dist/client.json", "{}\n"],
  ["webview/node_modules/package/index.js", "export {}\n"],
  ["src/agent-skills/.locks/review.lock", "lock\n"],
  ["src/cli/.index.ts.swp", "swap\n"],
  ["src/cli/index.ts~", "backup\n"],
])

function write(root: string, files: ReadonlyMap<string, string>): void {
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

function fixtureCheckout(): string {
  const checkout = join(temporaryDirectory("flywheel-source-snapshot-"), "checkout")
  write(checkout, new Map([...SOURCE, ...NOT_SOURCE]))
  mkdirSync(join(checkout, "node_modules"))
  return realpathSync(checkout)
}

/** The files under `root`, without entering a link: Bun's recursive
 *  `readdir` follows links, such as the link to the client's packages. */
function filesUnder(root: string, path = root): string[] {
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? filesUnder(root, join(path, entry.name)) : entry.isFile() ? [relative(root, join(path, entry.name)).split(/[\\/]/).join("/")] : [])
    .sort()
}

function entered(entry: SourceEntry): Extract<SourceEntry, { readonly kind: "created" | "reused" }> {
  if (entry.kind === "failed") throw new Error(`the entry failed: ${entry.reason}`)
  if (entry.kind === "proved") throw new Error(`the entry ran the proved snapshot in place of ${entry.refused}`)
  return entry
}

function snapshotted(source: ServiceSource | undefined): ServiceSource {
  if (source === undefined) throw new Error("the service runs from no snapshot")
  return source
}

describe("a dev service's source snapshot", () => {
  test("copies exactly the file set into the checkout's build cache, under a sixteen-hex digest", async () => {
    const checkout = fixtureCheckout()

    const entry = entered(await enterSourceSnapshot(checkout))

    expect(entry.kind).toBe("created")
    expect(entry.digest).toMatch(/^[0-9a-f]{16}$/)
    expect(entry.root).toBe(join(checkout, "node_modules", ".cache", "flywheel", "source", entry.digest))
    expect(filesUnder(entry.root)).toEqual([...SOURCE.keys()].sort())
    expect(entry.files).toBe(SOURCE.size)
    expect(entry.bytes).toBe([...SOURCE.values()].reduce((sum, content) => sum + content.length, 0))
    expect(realpathSync(join(entry.root, "webview", "node_modules"))).toBe(join(checkout, "webview", "node_modules"))

    write(checkout, new Map([["webview/src/client.ts", "export const generation = 'second'\n"]]))
    const next = entered(await enterSourceSnapshot(checkout))
    expect(next.digest).not.toBe(entry.digest)
    expect(readFileSync(join(entry.root, "webview/src/client.ts"), "utf8")).toBe("export const generation = 'first'\n")
    expect(readFileSync(join(next.root, "webview/src/client.ts"), "utf8")).toBe("export const generation = 'second'\n")
  })

  test("reuses the snapshot of an unchanged checkout without a copy, and a touched file finds the same snapshot", async () => {
    const checkout = fixtureCheckout()
    let copies = 0
    const afterCopy = () => { copies += 1 }
    const first = entered(await enterSourceSnapshot(checkout, { afterCopy }))
    expect(copies).toBe(1)

    const again = entered(await enterSourceSnapshot(checkout, { afterCopy }))
    expect(again).toMatchObject({ kind: "reused", digest: first.digest, root: first.root })
    expect(copies).toBe(1)

    // A new mtime with the same bytes is the same source.
    const touched = new Date(Date.now() + 60_000)
    utimesSync(join(checkout, "src", "cli", "index.ts"), touched, touched)
    expect(entered(await enterSourceSnapshot(checkout, { afterCopy }))).toMatchObject({ kind: "reused", digest: first.digest })
    expect(copies).toBe(2)
    expect(readdirSync(sourceSnapshotHome(checkout)).filter((name) => /^[0-9a-f]{16}$/.test(name))).toEqual([first.digest])
  })

  test("copies again when the checkout changes during a copy, and runs live after the third change", async () => {
    const checkout = fixtureCheckout()
    let edits = 0
    const edit = () => {
      edits += 1
      writeFileSync(join(checkout, "src", "cli", "index.ts"), `export const edit = ${edits}\n`)
    }

    // One change during the first copy: the second copy holds the edited file.
    const retried = entered(await enterSourceSnapshot(checkout, { afterCopy: () => { if (edits === 0) edit() } }))
    expect(edits).toBe(1)
    expect(readFileSync(join(retried.root, "src", "cli", "index.ts"), "utf8")).toBe("export const edit = 1\n")

    const edited = fixtureCheckout()
    let writes = 0
    const failed = await enterSourceSnapshot(edited, { afterCopy: () => { writes += 1; writeFileSync(join(edited, "src", "cli", "index.ts"), `export const edit = ${writes}\n`) } })
    expect(writes).toBe(3)
    expect(failed).toMatchObject({ kind: "failed", checkout: edited, reason: "the checkout changed during each of 3 copies" })
    // Nothing is published and no copy is left behind.
    expect(readdirSync(sourceSnapshotHome(edited))).toEqual([])
  })

  test("copies again when a file leaves the checkout between its walk and its copy", async () => {
    const checkout = fixtureCheckout()
    let reads = 0
    const removeOnce = () => {
      reads += 1
      if (reads === 1) rmSync(join(checkout, "scripts", "dev.ts"))
    }

    const entry = entered(await enterSourceSnapshot(checkout, { beforeRead: removeOnce }))

    expect(reads).toBe(2)
    expect(filesUnder(entry.root)).toEqual([...SOURCE.keys()].filter((path) => path !== "scripts/dev.ts").sort())
    expect(readdirSync(sourceSnapshotHome(checkout)).filter((name) => name.startsWith(".tmp-"))).toEqual([])
  })

  test("runs from its snapshot when the record of the last snapshot cannot be written, and the next entry finds that snapshot by its digest", async () => {
    const checkout = fixtureCheckout()
    // A directory where the record goes: no record can replace it.
    mkdirSync(join(sourceSnapshotHome(checkout), "latest.json", "held"), { recursive: true })
    const warn = spyOn(Log.create({ service: "source-snapshot" }), "warn").mockImplementation(() => {})
    try {
      const first = entered(await enterSourceSnapshot(checkout))
      const again = entered(await enterSourceSnapshot(checkout))

      expect(first.kind).toBe("created")
      expect(again).toMatchObject({ kind: "reused", digest: first.digest })
      const unwritten = "the record of the last snapshot could not be written, so the next dev entry copies the checkout again"
      const fields = { checkout, digest: first.digest, error: expect.any(String) }
      expect(warn.mock.calls).toEqual([[unwritten, fields], [unwritten, fields]])
    } finally {
      warn.mockRestore()
    }
    expect(readdirSync(sourceSnapshotHome(checkout)).filter((name) => name.startsWith(".tmp-"))).toEqual([])
  })

  test("removes the holder record of each gone process when a process joins the snapshot", async () => {
    const checkout = fixtureCheckout()
    const entry = entered(await enterSourceSnapshot(checkout))
    // The record of a process that its supervisor killed, which never
    // released it.
    rewriteHolders(checkout, entry.digest, { pid: GONE_PID, owner: "killed" })
    const info = spyOn(Log.create({ service: "ownership-file-lock" }), "info").mockImplementation(() => {})
    try {
      entered(await enterSourceSnapshot(checkout))
    } finally {
      info.mockRestore()
    }

    const home = sourceSnapshotHome(checkout)
    const records = readdirSync(home).filter((name) => name.startsWith(`${entry.digest}.gate.shared.`))
    expect(records.map((name) => JSON.parse(readFileSync(join(home, name), "utf8")).pid)).toEqual([process.pid])
  })

  test("runs live when a link holds part of the snapshot home, and writes nothing where the link points", async () => {
    const root = temporaryDirectory("flywheel-source-snapshot-")
    const checkout = join(root, "checkout")
    write(checkout, SOURCE)
    const shared = join(root, "shared-node-modules")
    mkdirSync(shared)
    symlinkSync(shared, join(checkout, "node_modules"), "junction")

    const entry = await enterSourceSnapshot(checkout)

    expect(entry.kind).toBe("failed")
    if (entry.kind === "failed") expect(entry.reason).toContain("a link or a file holds part of")
    expect(readdirSync(shared)).toEqual([])
  })

  test("makes this process a holder of the snapshot it enters", async () => {
    const checkout = fixtureCheckout()
    const entry = entered(await enterSourceSnapshot(checkout))

    const home = ContainedDirectory.open(sourceSnapshotHome(checkout), [])
    try {
      expect(sharedHoldersIn(home, `${entry.digest}.gate`)).toEqual({ pids: [process.pid], unreadable: 0 })
    } finally {
      home.close()
    }
    expect(existsSync(join(sourceSnapshotHome(checkout), `${entry.digest}.gate`))).toBe(false)
  })

  test("is recorded once by the process that adopts it, and reported to its service as the snapshot it runs from", async () => {
    // A copy in a snapshot is a module of its own, so the decision it adopts
    // stays in this case.
    const fixture = snapshotFixture(temporaryDirectory("flywheel-snapshot-report-"), ["src/infra/source-snapshot.ts"])
    const copy = await fixture.importFromSnapshot<typeof import("../../../src/infra/source-snapshot.js")>("src/infra/source-snapshot.ts")
    const { Log: copyLog } = await fixture.importFromSnapshot<typeof import("../../../src/infra/log.js")>("src/infra/log.ts")
    const logger = copyLog.create({ service: "source-snapshot" })
    const info = spyOn(logger, "info").mockImplementation(() => {})
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      copy.adoptSourceEntry({ kind: "created", checkout: fixture.checkout, digest: "0123456789abcdef", root: fixture.snapshot, signature: "s", files: 3, bytes: 30, ms: 7 })
      expect(copy.reportSourceEntry()?.snapshot).toEqual({ checkout: fixture.checkout, digest: "0123456789abcdef" })
      copy.adoptSourceEntry({ kind: "failed", checkout: fixture.checkout, reason: "the checkout changed during each of 3 copies", ms: 9 })
      copy.reportSourceEntry()

      expect(info.mock.calls).toEqual([["this process runs from a new snapshot of its checkout", { checkout: fixture.checkout, digest: "0123456789abcdef", files: 3, bytes: 30, ms: 7 }]])
      expect(warn.mock.calls).toEqual([["this process runs its live checkout, because its source could not be snapshotted", { checkout: fixture.checkout, reason: "the checkout changed during each of 3 copies", ms: 9 }]])
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  test("has the other snapshots of its checkout swept for the service that reports it, and never itself", async () => {
    const fixture = snapshotFixture(temporaryDirectory("flywheel-snapshot-sweep-"), ["src/infra/source-snapshot.ts"])
    const copy = await fixture.importFromSnapshot<typeof import("../../../src/infra/source-snapshot.js")>("src/infra/source-snapshot.ts")
    const { Log: copyLog } = await fixture.importFromSnapshot<typeof import("../../../src/infra/log.js")>("src/infra/log.ts")
    const info = spyOn(copyLog.create({ service: "source-snapshot" }), "info").mockImplementation(() => {})
    // A snapshot of the same checkout that no process holds, beside the one
    // the service runs from, which no process holds either.
    write(join(sourceSnapshotHome(fixture.checkout), "fedcba9876543210"), SOURCE)
    try {
      await snapshotted(copy.reportSourceEntry()).sweepOthers()
    } finally {
      info.mockRestore()
    }

    expect(snapshotsIn(fixture.checkout)).toEqual(["0123456789abcdef"])
  })

  test("makes way for a service of the current source when a new client's cutover finds that its checkout's source changed, and hashes the checkout only when the checkout's stats changed", async () => {
    const root = temporaryDirectory("flywheel-snapshot-change-")
    write(join(root, "checkout"), SOURCE)
    const entry = entered(await enterSourceSnapshot(realpathSync(join(root, "checkout"))))
    // The service runs from the snapshot its entry chose, as the copy of this
    // module in that snapshot.
    const fixture = snapshotFixture(root, ["src/infra/source-snapshot.ts"], { digest: entry.digest })
    const copy = await fixture.importFromSnapshot<typeof import("../../../src/infra/source-snapshot.js")>("src/infra/source-snapshot.ts")
    const { Log: copyLog } = await fixture.importFromSnapshot<typeof import("../../../src/infra/log.js")>("src/infra/log.ts")
    const logger = copyLog.create({ service: "source-snapshot" })
    const info = spyOn(logger, "info").mockImplementation(() => {})
    const debug = spyOn(logger, "debug").mockImplementation(() => {})
    try {
      copy.adoptSourceEntry(entry)
      const requests: unknown[] = []
      const answer = snapshotted(copy.reportSourceEntry()).cutoverAnswer(async () => "busy", async (trigger) => {
        requests.push(trigger)
        return "retiring"
      })
      const edited = join(fixture.checkout, "src", "cli", "index.ts")

      expect(await answer()).toBe("busy")
      // A new mtime with the same bytes is the same source. The first answer
      // after it hashes the checkout, and the next one does not.
      const touched = new Date(Date.now() + 60_000)
      utimesSync(edited, touched, touched)
      expect(await answer()).toBe("busy")
      expect(await answer()).toBe("busy")
      expect(debug.mock.calls.map(([, fields]) => fields?.hashed)).toEqual([false, true, false])
      expect(requests).toEqual([])

      writeFileSync(edited, "export const edit = 1\n")
      const current = entered(await enterSourceSnapshot(fixture.checkout)).digest
      expect(current).not.toBe(entry.digest)
      expect(await answer()).toBe("retiring")
      expect(requests).toEqual([{ kind: "source changed", checkout: fixture.checkout, ownDigest: entry.digest, currentDigest: current }])
    } finally {
      info.mockRestore()
      debug.mockRestore()
    }
  })

  test("weighs a cutover by the build first, and a service that makes way for another build asks nothing of its checkout", async () => {
    const root = temporaryDirectory("flywheel-snapshot-build-first-")
    write(join(root, "checkout"), SOURCE)
    const entry = entered(await enterSourceSnapshot(realpathSync(join(root, "checkout"))))
    const fixture = snapshotFixture(root, ["src/infra/source-snapshot.ts"], { digest: entry.digest })
    const copy = await fixture.importFromSnapshot<typeof import("../../../src/infra/source-snapshot.js")>("src/infra/source-snapshot.ts")
    const { Log: copyLog } = await fixture.importFromSnapshot<typeof import("../../../src/infra/log.js")>("src/infra/log.ts")
    const info = spyOn(copyLog.create({ service: "source-snapshot" }), "info").mockImplementation(() => {})
    let reads = 0
    let requests = 0
    try {
      copy.adoptSourceEntry(entry)
      writeFileSync(join(fixture.checkout, "src", "cli", "index.ts"), "export const edit = 1\n")
      const source = snapshotted(copy.reportSourceEntry({ beforeRead: () => { reads += 1 } }))
      const told: string[] = []
      const answer = source.cutoverAnswer(async (beforeRetire) => {
        await beforeRetire?.()
        return "retiring"
      }, async () => {
        requests += 1
        return "retiring"
      })

      expect(await answer(async () => { told.push("retiring") })).toBe("retiring")
      expect(told).toEqual(["retiring"])
      expect(reads).toBe(0)
      expect(requests).toBe(0)
    } finally {
      info.mockRestore()
    }
  })

  test("compares the checkout again when a file leaves it between its walk and its hash", async () => {
    const root = temporaryDirectory("flywheel-snapshot-vanish-")
    write(join(root, "checkout"), SOURCE)
    const entry = entered(await enterSourceSnapshot(realpathSync(join(root, "checkout"))))
    const fixture = snapshotFixture(root, ["src/infra/source-snapshot.ts"], { digest: entry.digest })
    const copy = await fixture.importFromSnapshot<typeof import("../../../src/infra/source-snapshot.js")>("src/infra/source-snapshot.ts")
    const { Log: copyLog } = await fixture.importFromSnapshot<typeof import("../../../src/infra/log.js")>("src/infra/log.ts")
    const logger = copyLog.create({ service: "source-snapshot" })
    const info = spyOn(logger, "info").mockImplementation(() => {})
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    let reads = 0
    try {
      copy.adoptSourceEntry(entry)
      const requests: unknown[] = []
      const answer = snapshotted(copy.reportSourceEntry({
        beforeRead: () => {
          reads += 1
          if (reads === 1) rmSync(join(fixture.checkout, "scripts", "dev.ts"))
        },
      })).cutoverAnswer(async () => "busy", async (trigger) => {
        requests.push(trigger)
        return "retiring"
      })
      writeFileSync(join(fixture.checkout, "src", "cli", "index.ts"), "export const edit = 1\n")

      expect(await answer()).toBe("retiring")

      const current = entered(await enterSourceSnapshot(fixture.checkout)).digest
      expect(requests).toEqual([{ kind: "source changed", checkout: fixture.checkout, ownDigest: entry.digest, currentDigest: current }])
      expect(reads).toBe(2)
      expect(warn.mock.calls).toEqual([])
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  test("is held once by a process that the source entry starts from it, such as an executor or a guardian", async () => {
    const fixture = snapshotFixture(temporaryDirectory("flywheel-snapshot-cli-"), ["scripts/source-cli.ts", "src/cli/index.ts", "src/orchestration/app-service/runtime-executable.ts", "src/infra/startup-trace.ts", "src/cli/root-args.ts", "src/infra/source-snapshot.ts", "src/infra/update/build-identity.ts", "src/infra/app-version.ts", "package.json"])
    const entry = await fixture.importFromSnapshot<typeof import("../../../scripts/source-cli.js")>("scripts/source-cli.ts")
    const argv = process.argv
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      process.argv = [argv[0] ?? "bun", "source-cli.ts", "--version"]
      await entry.runSourceCli()
    } finally {
      process.argv = argv
      stdout.mockRestore()
    }
    // The process holds its snapshot already, so a second hold adds no record.
    const snapshotModule = await fixture.importFromSnapshot<typeof import("../../../src/infra/source-snapshot.js")>("src/infra/source-snapshot.ts")
    snapshotModule.holdRunningSnapshot()

    const home = ContainedDirectory.open(sourceSnapshotHome(fixture.checkout), [])
    try {
      expect(sharedHoldersIn(home, "0123456789abcdef.gate")).toEqual({ pids: [process.pid], unreadable: 0 })
    } finally {
      home.close()
    }
  })
})

/** A pid that no process has: every kernel gives far smaller pids. */
const GONE_PID = 2_147_483_000
/** A digest that names no snapshot in a fixture: the sweeping process runs
 *  from a snapshot that another case owns. */
const ELSEWHERE = "ffffffffffffffff"

/** Enters a snapshot of the checkout after one edit, and answers its digest. */
async function snapshotAfterEdit(checkout: string, edit: number): Promise<string> {
  writeFileSync(join(checkout, "src", "cli", "index.ts"), `export const edit = ${edit}\n`)
  return entered(await enterSourceSnapshot(checkout)).digest
}

/** A shared holder's record, in the fields a gate's holder writes. */
interface HolderRecord {
  readonly pid: number
  readonly owner: string
  readonly v?: number
  readonly start?: string
}

/** Replaces every holder record of the snapshot `digest` with `record`. */
function rewriteHolders(checkout: string, digest: string, record: HolderRecord): void {
  const home = sourceSnapshotHome(checkout)
  for (const name of readdirSync(home).filter((entry) => entry.startsWith(`${digest}.gate.shared.`))) writeFileSync(join(home, name), JSON.stringify(record))
}

function snapshotsIn(checkout: string): string[] {
  return readdirSync(sourceSnapshotHome(checkout)).filter((name) => /^[0-9a-f]{16}$/.test(name)).sort()
}

describe("the sweep of a checkout's snapshots", () => {
  test("removes a snapshot whose every holder is gone, and keeps one that is held, one whose holder cannot be read, and the one the sweep runs from", async () => {
    const checkout = fixtureCheckout()
    const abandoned = entered(await enterSourceSnapshot(checkout))
    const held = await snapshotAfterEdit(checkout, 1)
    const unreadable = await snapshotAfterEdit(checkout, 2)
    const running = await snapshotAfterEdit(checkout, 3)
    rewriteHolders(checkout, abandoned.digest, { pid: GONE_PID, owner: "gone" })
    // An identity in a version this build does not know proves nothing
    // about its holder.
    rewriteHolders(checkout, unreadable, { pid: GONE_PID, owner: "later", v: 2, start: "1" })
    rewriteHolders(checkout, running, { pid: GONE_PID, owner: "gone" })
    const info = spyOn(Log.create({ service: "source-snapshot" }), "info").mockImplementation(() => {})
    try {
      await sweepSourceSnapshots({ checkout, digest: running })

      expect(info.mock.calls).toEqual([["removed the snapshots of the checkout that no process runs from", { checkout, removed: 1, bytes: abandoned.bytes, ms: expect.any(Number) }]])
    } finally {
      info.mockRestore()
    }
    expect(snapshotsIn(checkout)).toEqual([held, unreadable, running].sort())
    expect(readdirSync(sourceSnapshotHome(checkout)).filter((name) => name.startsWith("."))).toEqual([])
  })

  test("keeps a snapshot that a join holds by the time the sweep takes its gate, though nothing held it when the sweep listed it", async () => {
    const checkout = fixtureCheckout()
    const snapshot = entered(await enterSourceSnapshot(checkout))
    rewriteHolders(checkout, snapshot.digest, { pid: GONE_PID, owner: "gone" })
    let joined: SourceEntry | undefined

    await sweepSourceSnapshots({ checkout, digest: ELSEWHERE }, { afterList: async () => { joined = await enterSourceSnapshot(checkout) } })

    expect(joined).toMatchObject({ kind: "reused", digest: snapshot.digest })
    expect(snapshotsIn(checkout)).toEqual([snapshot.digest])
  })

  test("removes a copy or a removal that a gone process left, and keeps the copy of a process that still runs", async () => {
    const checkout = fixtureCheckout()
    entered(await enterSourceSnapshot(checkout))
    const own = processHolders.own() ?? expect.unreachable("the kernel did not give this test process its identity")
    // The name of an entry that a process makes in the snapshot home carries
    // its holder text, so a later sweep can prove it gone.
    const made = (kind: "tmp" | "removing", pid: number, identity: typeof own): string => `.${kind}-${encodeHolderText(pid, identity).replaceAll(" ", "-")}-0badf00d`
    const running = made("tmp", process.pid, own)
    const left = [
      made("tmp", GONE_PID, own),
      // This pid, with another start stamp: the kernel gave the gone
      // creator's pid to this process.
      made("tmp", process.pid, { ...own, start: "1" }),
      made("removing", GONE_PID, own),
    ]
    for (const name of [running, ...left]) write(join(sourceSnapshotHome(checkout), name), SOURCE)

    await sweepSourceSnapshots({ checkout, digest: ELSEWHERE })

    expect(readdirSync(sourceSnapshotHome(checkout)).filter((name) => name.startsWith("."))).toEqual([running])
  })

  test("records a sweep that fails once, and resolves", async () => {
    // A checkout whose `node_modules` is a file holds no snapshot home.
    const checkout = realpathSync(temporaryDirectory("flywheel-snapshot-sweep-"))
    writeFileSync(join(checkout, "node_modules"), "")
    const warn = spyOn(Log.create({ service: "source-snapshot" }), "warn").mockImplementation(() => {})
    try {
      await sweepSourceSnapshots({ checkout, digest: ELSEWHERE })

      expect(warn.mock.calls).toEqual([["the dev service could not remove every snapshot that no process runs from; the next dev service start tries again", { checkout, failures: 1, error: expect.any(String) }]])
    } finally {
      warn.mockRestore()
    }
  })
})

const REFUSAL = "its project executors stopped before they were ready 3 times in a row"

describe("a snapshot whose project executors could not open", () => {
  test("is never entered again while the checkout holds its source: the entry runs the proved snapshot, from the cache and from a copy, and a changed source is tried normally", async () => {
    const checkout = fixtureCheckout()
    const proved = entered(await enterSourceSnapshot(checkout))
    recordSnapshotProved({ checkout, digest: proved.digest })
    const failed = await snapshotAfterEdit(checkout, 1)
    expect(refuseSourceSnapshot({ checkout, digest: failed }, REFUSAL)).toEqual({ kind: "returned", proved: proved.digest })

    const fallback = { kind: "proved", checkout, digest: proved.digest, refused: failed, root: join(sourceSnapshotHome(checkout), proved.digest) }
    expect(await enterSourceSnapshot(checkout)).toMatchObject(fallback)
    // An entry that copies the checkout finds the refused source by its digest.
    rmSync(join(sourceSnapshotHome(checkout), "latest.json"))
    expect(await enterSourceSnapshot(checkout)).toMatchObject(fallback)
    // A ready executor of the refused snapshot, such as one of the service
    // that refused it, neither proves it nor clears the refusal.
    expect(recordSnapshotProved({ checkout, digest: failed })).toBe(false)
    expect(await enterSourceSnapshot(checkout)).toMatchObject(fallback)
    // With the proved snapshot gone, the refused source is all there is.
    rmSync(join(sourceSnapshotHome(checkout), proved.digest), { recursive: true })
    expect(await enterSourceSnapshot(checkout)).toMatchObject({ kind: "reused", digest: failed, runsRefused: true })

    writeFileSync(join(checkout, "src", "cli", "index.ts"), "export const fixed = 1\n")
    const changed = entered(await enterSourceSnapshot(checkout))
    expect(changed.digest).not.toBe(failed)
    expect(changed.digest).not.toBe(proved.digest)
  })

  test("is refused only while another snapshot is proved and still there, and a record of a shape this build does not know names none", async () => {
    const checkout = fixtureCheckout()
    const own = entered(await enterSourceSnapshot(checkout)).digest
    const other = await snapshotAfterEdit(checkout, 1)
    const proofPath = join(sourceSnapshotHome(checkout), "proof.json")
    const warn = spyOn(Log.create({ service: "source-snapshot" }), "warn").mockImplementation(() => {})
    try {
      expect(refuseSourceSnapshot({ checkout, digest: own }, REFUSAL)).toEqual({ kind: "stays", reason: "no snapshot of this checkout is proved" })
      expect(recordSnapshotProved({ checkout, digest: own })).toBe(true)
      // A proof the record already holds is not recorded again.
      expect(recordSnapshotProved({ checkout, digest: own })).toBe(false)
      expect(refuseSourceSnapshot({ checkout, digest: own }, REFUSAL)).toEqual({ kind: "stays", reason: "this snapshot is proved" })
      rmSync(join(sourceSnapshotHome(checkout), own), { recursive: true })
      expect(refuseSourceSnapshot({ checkout, digest: other }, REFUSAL)).toEqual({ kind: "stays", reason: `the proved snapshot ${own} is gone` })

      // A record of another shape names no snapshot and stays as it is until
      // a change replaces it, which says so.
      const unknown = JSON.stringify({ version: 2, proofs: [own] })
      writeFileSync(proofPath, unknown)
      for (let read = 0; read < 3; read += 1) expect(refuseSourceSnapshot({ checkout, digest: other }, REFUSAL).kind).toBe("stays")
      expect(readFileSync(proofPath, "utf8")).toBe(unknown)
      expect(recordSnapshotProved({ checkout, digest: other })).toBe(true)
      expect(warn.mock.calls.filter(([message]) => String(message).includes("it is replaced by a record of this build's shape"))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
    expect(JSON.parse(readFileSync(proofPath, "utf8"))).toEqual({ version: 1, proved: other })
  })

  test("is never proved, refused, or swept away over a proof record that cannot be read", async () => {
    const checkout = fixtureCheckout()
    const first = entered(await enterSourceSnapshot(checkout))
    const second = await snapshotAfterEdit(checkout, 1)
    rewriteHolders(checkout, first.digest, { pid: GONE_PID, owner: "gone" })
    rewriteHolders(checkout, second, { pid: GONE_PID, owner: "gone" })
    // A directory at the record's name cannot be read as a file.
    mkdirSync(join(sourceSnapshotHome(checkout), "proof.json"))
    const warn = spyOn(Log.create({ service: "source-snapshot" }), "warn").mockImplementation(() => {})
    try {
      expect(recordSnapshotProved({ checkout, digest: first.digest })).toBe(false)
      expect(refuseSourceSnapshot({ checkout, digest: second }, REFUSAL)).toMatchObject({ kind: "retries" })
      await sweepSourceSnapshots({ checkout, digest: ELSEWHERE })
    } finally {
      warn.mockRestore()
    }
    expect(snapshotsIn(checkout)).toEqual([first.digest, second].sort())
  })

  test("keeps a service of the proved snapshot serving while its checkout holds the refused source, which its update status names, and makes way once the source changes", async () => {
    const root = temporaryDirectory("flywheel-snapshot-refused-")
    write(join(root, "checkout"), SOURCE)
    const checkout = realpathSync(join(root, "checkout"))
    const proved = entered(await enterSourceSnapshot(checkout))
    recordSnapshotProved({ checkout, digest: proved.digest })
    const edited = join(checkout, "src", "cli", "index.ts")
    const failed = await snapshotAfterEdit(checkout, 1)
    refuseSourceSnapshot({ checkout, digest: failed }, REFUSAL)
    const entry = await enterSourceSnapshot(checkout)
    const fixture = snapshotFixture(root, ["src/infra/source-snapshot.ts"], { digest: proved.digest })
    const copy = await fixture.importFromSnapshot<typeof import("../../../src/infra/source-snapshot.js")>("src/infra/source-snapshot.ts")
    const { Log: copyLog } = await fixture.importFromSnapshot<typeof import("../../../src/infra/log.js")>("src/infra/log.ts")
    const logger = copyLog.create({ service: "source-snapshot" })
    const info = spyOn(logger, "info").mockImplementation(() => {})
    const debug = spyOn(logger, "debug").mockImplementation(() => {})
    try {
      copy.adoptSourceEntry(entry)
      const source = snapshotted(copy.reportSourceEntry())
      expect(source.refusedSource).toEqual({ refused: failed, running: proved.digest })
      expect(info.mock.calls).toEqual([["this process runs the last proved snapshot of its checkout, because the checkout's source could not start", { checkout, digest: proved.digest, refused: failed, ms: expect.any(Number) }]])
      const requests: unknown[] = []
      const answer = source.cutoverAnswer(async () => "busy", async (trigger) => {
        requests.push(trigger)
        return "retiring"
      })

      expect(await answer()).toBe("busy")
      // A new mtime makes the check hash the checkout, which still holds the
      // refused source.
      const touched = new Date(Date.now() + 60_000)
      utimesSync(edited, touched, touched)
      expect(await answer()).toBe("busy")
      expect(requests).toEqual([])

      writeFileSync(edited, "export const fixed = 1\n")
      const current = entered(await enterSourceSnapshot(checkout)).digest
      expect(await answer()).toBe("retiring")
      expect(requests).toEqual([{ kind: "source changed", checkout, ownDigest: proved.digest, currentDigest: current }])
    } finally {
      info.mockRestore()
      debug.mockRestore()
    }
  })

  test("leaves the proved snapshot to every sweep, though no process holds it", async () => {
    const checkout = fixtureCheckout()
    const proved = entered(await enterSourceSnapshot(checkout))
    const other = await snapshotAfterEdit(checkout, 1)
    recordSnapshotProved({ checkout, digest: proved.digest })
    rewriteHolders(checkout, proved.digest, { pid: GONE_PID, owner: "gone" })
    rewriteHolders(checkout, other, { pid: GONE_PID, owner: "gone" })
    const info = spyOn(Log.create({ service: "source-snapshot" }), "info").mockImplementation(() => {})
    try {
      await sweepSourceSnapshots({ checkout, digest: ELSEWHERE })
    } finally {
      info.mockRestore()
    }

    expect(snapshotsIn(checkout)).toEqual([proved.digest])
  })
})

/** The modules a dev service loads from its snapshot: all of `src`, and the
 *  entries of a source run. */
const SNAPSHOT_MODULES = [
  ...readdirSync(join(REPOSITORY, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name)),
  ...["dev.ts", "source-cli.ts", "project-executor.ts"].map((name) => join(REPOSITORY, "scripts", name)),
]

const LITERAL = String.raw`(?:"[^"]*"|'[^']*'|\`[^\`]*\`)`
const LITERAL_ARGUMENTS = String.raw`((?:\s*,\s*${LITERAL})*)`
/** A URL relative to the module itself. */
const URL_FORM = new RegExp(String.raw`new URL\(\s*(${LITERAL})\s*,\s*import\.meta\.url\s*\)`, "g")
/** A name bound to the module's directory, or to a URL relative to it. */
const DIRECTORY_BINDING = new RegExp(String.raw`\b(?:const|let)\s+(\w+)\s*=\s*(dirname\(fileURLToPath\(import\.meta\.url\)\)|import\.meta\.dir|fileURLToPath\(new URL\(\s*${LITERAL}\s*,\s*import\.meta\.url\s*\)\))`, "g")
const STRING_CONSTANT = /\bconst\s+(\w+)\s*=\s*"([^"]*)"/g
/** A static import or re-export of a path relative to the module. */
const RELATIVE_IMPORT = /^\s*(?:import|export)\b[^"'\n]*?["'](\.{1,2}\/[^"']+)["']/gm

/** The path each place in `file` takes relative to the module's own
 *  location, where the arguments are literals or the file's own string
 *  constants. A place built from anything else is not read. */
function moduleRelativePaths(file: string): Array<{ readonly line: number; readonly path: string }> {
  const source = readFileSync(file, "utf8")
  const constants = new Map([...source.matchAll(STRING_CONSTANT)].map((match) => [match[1] ?? "", match[2] ?? ""]))
  const literal = (text: string): string | undefined => {
    const body = text.slice(1, -1)
    const substituted = body.replace(/\$\{(\w+)\}/g, (_, name: string) => constants.get(name) ?? "\0")
    return substituted.includes("\0") || substituted.includes("${") ? undefined : substituted
  }
  const lineAt = (index: number): number => source.slice(0, index).split("\n").length
  const found: Array<{ readonly line: number; readonly path: string }> = []
  const joined = (base: string, argumentsText: string, index: number): void => {
    const segments = [...argumentsText.matchAll(new RegExp(LITERAL, "g"))].map((match) => literal(match[0]))
    if (segments.some((segment) => segment === undefined)) return
    found.push({ line: lineAt(index), path: resolve(base, ...segments.filter((segment) => segment !== undefined)) })
  }
  const moduleDirectory = dirname(file)
  for (const match of source.matchAll(URL_FORM)) {
    // A URL with a part the reader cannot resolve is read up to the folder
    // before that part, which the whole URL lies in.
    const relativeUrl = literal(match[1] ?? "") ?? staticFolder(match[1] ?? "")
    if (relativeUrl !== undefined) found.push({ line: lineAt(match.index), path: resolve(fileURLToPath(new URL(relativeUrl, pathToFileURL(file)))) })
  }
  const bases = new Map<string, string>([["import\\.meta\\.dir", moduleDirectory]])
  for (const match of source.matchAll(DIRECTORY_BINDING)) {
    const bound = match[2] ?? ""
    const url = /new URL\(\s*(.+?)\s*,\s*import\.meta\.url/.exec(bound)?.[1]
    const relativeUrl = url === undefined ? "." : literal(url)
    if (relativeUrl !== undefined) bases.set(match[1] ?? "", resolve(fileURLToPath(new URL(relativeUrl, pathToFileURL(file)))))
  }
  for (const [name, base] of bases) {
    for (const match of source.matchAll(new RegExp(String.raw`\b(?:join|resolve)\(\s*${name}\b${LITERAL_ARGUMENTS}`, "g"))) joined(base, match[1] ?? "", match.index)
  }
  return found
}

/** The folder that a template literal names before its first substitution,
 *  or undefined when the literal names no folder before it. */
function staticFolder(text: string): string | undefined {
  const body = text.slice(1, -1)
  const substitution = body.indexOf("${")
  if (substitution < 0) return undefined
  const folder = body.slice(0, body.lastIndexOf("/", substitution) + 1)
  return folder.length > 0 ? folder : undefined
}

function insideFileSet(path: string): boolean {
  const inRepository = relative(REPOSITORY, path).split(/[\\/]/).join("/")
  return SOURCE_FILE_SET.some((member) => inRepository === member || inRepository.startsWith(`${member}/`))
}

describe("the paths a module takes relative to itself", () => {
  test("stay inside the source a snapshot copies, so a dev service reads the checkout only through its resolvers", () => {
    const outside = SNAPSHOT_MODULES.flatMap((file) => moduleRelativePaths(file)
      .filter(({ path }) => !insideFileSet(path))
      .map(({ line, path }) => `${relative(REPOSITORY, file)}:${line} -> ${relative(REPOSITORY, path) || "."}`))

    expect(outside).toEqual([])
  })

  test("include every file a snapshot module imports by a relative path, so no import names a file the walk skips", () => {
    // The walk skips a name that starts with a dot or ends with a tilde.
    const skippedSegment = (segment: string): boolean => (segment.startsWith(".") && segment !== "." && segment !== "..") || segment.endsWith("~")
    const missing = SNAPSHOT_MODULES.flatMap((file) => [...readFileSync(file, "utf8").matchAll(RELATIVE_IMPORT)]
      .map((match) => resolve(dirname(file), match[1] ?? ""))
      .filter((path) => !insideFileSet(path) || relative(REPOSITORY, path).split(/[\\/]/).some(skippedSegment))
      .map((path) => `${relative(REPOSITORY, file)} -> ${relative(REPOSITORY, path)}`))

    expect(missing).toEqual([])
  })

  test("never name the dev entry, which a client starts from its checkout so that a runtime runs the checkout's current source", () => {
    // A client runs from the snapshot of its own start. A runtime it started
    // from that snapshot's entry would run that old source, because an entry
    // inside a snapshot takes no other.
    const entry = join(REPOSITORY, "scripts", "dev.ts")
    const named = SNAPSHOT_MODULES.flatMap((file) => moduleRelativePaths(file)
      .filter(({ path }) => path === entry)
      .map(({ line }) => `${relative(REPOSITORY, file)}:${line}`))

    expect(named).toEqual([])
  })

  test("are read in each form a module names them by", () => {
    // The reader must find the forms it guards, or the guard passes vacuously.
    const probe = join(REPOSITORY, "src", "orchestration", "app-service", "project-executor-client.ts")
    expect(moduleRelativePaths(probe).map(({ path }) => relative(REPOSITORY, path).split(/[\\/]/).join("/"))).toContain("scripts/project-executor.ts")
    const tokenizer = join(REPOSITORY, "src", "infra", "local-tokenizer.ts")
    expect(moduleRelativePaths(tokenizer).map(({ path }) => relative(REPOSITORY, path).split(/[\\/]/).join("/"))).toContain("crates/tokenizer/flywheel-tokenizer.wasm.zst")
  })
})
