import { describe, expect, spyOn, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { GroupMarkReading } from "../../../src/infra/container-mark.js"
import type { AbandonedLease, GuardianLedger, LedgerLease } from "../../../src/infra/guardian-ledger.js"
import { Log } from "../../../src/infra/log.js"
import { GUARDIAN_LEDGER_RECHECK_MS, runProcessGuardian, type GuardianHost } from "../../../src/infra/process-guardian.js"
import { encodeGuardianFrame, type GuardianReply, type GuardianRequest } from "../../../src/infra/process-guardian-protocol.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { CAPABILITY, GENERATION, IMPOSTOR, adopt, closeGeneration, hello, open, release } from "./_guardian-frames.js"

const encoder = new TextEncoder()

interface GuardianProbe {
  readonly replies: GuardianReply[]
  readonly signals: string[]
  readonly finished: Promise<void>
  /** Pids whose container still holds a process, independently of whether the
   *  leader that started it is still alive. */
  readonly populated: Set<number>
  /** Pids whose container ends when it is signalled, the way a container that
   *  takes SIGTERM does: the leader is gone and no member is left. */
  readonly diesOnSignal: Set<number>
  /** Pids whose identity probe cannot answer. */
  readonly unproven: Set<number>
  /** Pids held by a live process that leads no group, which proves that no
   *  container is named by that pid. */
  readonly others: Set<number>
  /** What the environments of a group's members say about the launch's
   *  mark, where the kernel shows them. A pid with no entry answers as macOS
   *  does: the mark cannot prove membership. */
  readonly groupMarks: Map<number, GroupMarkReading>
  /** Pids whose launch still runs processes outside the group at that pid.
   *  Each one ends when it is signalled. */
  readonly escapes: Set<number>
  /** Ownership tokens the guardian released, in order. */
  readonly forgotten: string[]
  /** Called at each of the guardian's waits, with how many it has made. A
   *  promise it returns holds every wait but the ledger's recheck. */
  onSleep: (count: number) => Promise<void> | void
  send(...requests: readonly GuardianRequest[]): void
  /** Bytes exactly as given, for a peer that is not speaking this protocol. */
  sendRaw(line: string): void
  /** Waits for the reply that answers one request. */
  answer(id: number): Promise<GuardianReply>
  endControl(): void
}
interface ContainerIdentities { [pid: number]: string | undefined }

function guardianProbe(containers: ContainerIdentities, limits: { maxContainers?: number; maxGenerations?: number; killGraceMs?: number } = {}, ledger?: GuardianLedger): GuardianProbe {
  const replies: GuardianReply[] = []
  const signals: string[] = []
  const populated = new Set(Object.keys(containers).map(Number))
  const diesOnSignal = new Set<number>()
  const unproven = new Set<number>()
  const others = new Set<number>()
  const groupMarks = new Map<number, GroupMarkReading>()
  const escapes = new Set<number>()
  const forgotten: string[] = []
  let sleeps = 0
  let enqueue: (line: string) => void = () => {}
  let end: () => void = () => {}
  const control = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueue = (line) => controller.enqueue(encoder.encode(line))
      end = () => controller.close()
    },
  })
  const host: GuardianHost = {
    control,
    send: (reply) => replies.push(reply),
    inspect: ({ pid }) => {
      if (unproven.has(pid)) return { kind: "unproven" }
      if (others.has(pid)) return { kind: "other" }
      const identity = containers[pid]
      return identity === undefined ? { kind: "absent" } : { kind: "container", identity }
    },
    container: ({ pid }) => ({
      signal: (signal) => {
        signals.push(`${signal}:${pid}`)
        if (!diesOnSignal.has(pid)) return
        populated.delete(pid)
        containers[pid] = undefined
      },
      populated: () => populated.has(pid),
    }),
    escaped: ({ pid }) => ({
      signal: (signal) => {
        signals.push(`${signal}:outside:${pid}`)
        escapes.delete(pid)
      },
      populated: () => escapes.has(pid),
    }),
    groupMark: ({ pid }) => groupMarks.get(pid),
    // Every reference this guardian stops owning is reported, so a case can
    // prove that a lease never ends without the container being released.
    forget: ({ token }) => { forgotten.push(token) },
    sleep: (ms) => {
      sleeps += 1
      const held = probe.onSleep(sleeps)
      // The ledger's recheck is the one wait that repeats for as long as the
      // guardian serves, so it yields to the test's own timers.
      return ms === GUARDIAN_LEDGER_RECHECK_MS ? Bun.sleep(1) : held ?? Promise.resolve()
    },
    ...(ledger === undefined ? {} : { ledger }),
  }
  const finished = runProcessGuardian(host, {
    maxContainers: limits.maxContainers ?? 2,
    maxGenerations: limits.maxGenerations ?? 2,
    maxRetiredTokens: 2,
    killGraceMs: limits.killGraceMs ?? 0,
  })
  const probe: GuardianProbe = {
    onSleep: () => {},
    replies,
    signals,
    forgotten,
    finished,
    populated,
    diesOnSignal,
    unproven,
    others,
    groupMarks,
    escapes,
    send: (...requests) => { for (const request of requests) enqueue(encodeGuardianFrame(request)) },
    sendRaw: (line) => enqueue(line),
    async answer(id) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const found = replies.find((reply) => reply.id === id)
        if (found) return found
        await Bun.sleep(1)
      }
      throw new Error(`the guardian never answered request ${id}`)
    },
    endControl: () => end(),
  }
  return probe
}

/** The guardian whose records the ledger probe leaves behind. */
const DEAD_GUARDIAN = 77

/** One record as its writer names it: the token and the writing guardian. */
function record(token: string, guardianPid: number): string {
  return `${token} by ${guardianPid}`
}

/** A ledger as the guardian sees it: the records this guardian wrote, the
 *  ones dead guardians left, and every record removed, in order. Each record
 *  belongs to its writer, as on disk. */
function ledgerProbe(...left: readonly AbandonedLease[]) {
  const held = new Map<string, LedgerLease>()
  const abandoned = new Map(left.map((lease) => [record(lease.token, lease.guardianPid), lease]))
  const dropped: string[] = []
  return {
    held,
    left: abandoned,
    dropped,
    ledger: {
      hold: (lease) => { held.set(lease.token, lease) },
      drop: (token, guardianPid) => {
        if (guardianPid === process.pid) held.delete(token)
        abandoned.delete(record(token, guardianPid))
        dropped.push(record(token, guardianPid))
      },
      abandoned: () => [...abandoned.values()],
    } satisfies GuardianLedger,
  }
}

function abandonedLease(token: string, pid: number, identity: string): AbandonedLease {
  return { token, pid, identity, stopHold: null, guardianPid: DEAD_GUARDIAN, proof: "absent" }
}

describe("process guardian authority", () => {
  test("answers the handshake with its pid and adopts a container that leads its own group", async () => {
    const probe = guardianProbe({ 321: "identity-321" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 321))
    probe.endControl()
    await probe.finished

    expect(probe.replies).toEqual([
      { v: 1, kind: "ready", id: 1, pid: process.pid },
      { v: 1, kind: "opened", id: 2, generation: GENERATION },
      { v: 1, kind: "adopted", id: 3, token: "owned:1" },
    ])
  })

  test("refuses every mutation offered without the capability this channel established", async () => {
    const probe = guardianProbe({ 321: "identity-321" })

    // Before the handshake there is no capability at all, and afterwards only
    // the one the parent established opens anything.
    probe.send(open(1))
    probe.send(hello(2), open(3, GENERATION, IMPOSTOR), adopt(4, "owned:1", 321, GENERATION, IMPOSTOR))
    probe.endControl()
    await probe.finished

    expect(probe.replies).toEqual([
      { v: 1, kind: "rejected", id: 1, reason: "unauthorized" },
      { v: 1, kind: "ready", id: 2, pid: process.pid },
      { v: 1, kind: "rejected", id: 3, reason: "unauthorized" },
      { v: 1, kind: "rejected", id: 4, reason: "unauthorized" },
    ])
    expect(probe.signals).toEqual([])
  })

  test("refuses a second handshake, so the credential of a live channel cannot be replaced", async () => {
    const probe = guardianProbe({})

    probe.send(hello(1), hello(2, IMPOSTOR), open(3, GENERATION, IMPOSTOR))
    probe.endControl()
    await probe.finished

    expect(probe.replies.slice(1)).toEqual([
      { v: 1, kind: "rejected", id: 2, reason: "unauthorized" },
      { v: 1, kind: "rejected", id: 3, reason: "unauthorized" },
    ])
  })

  test("refuses adoption into a generation nobody opened", async () => {
    const probe = guardianProbe({ 101: "a" })

    probe.send(hello(1), adopt(2, "owned:1", 101))
    probe.endControl()
    await probe.finished

    expect(probe.replies.at(-1)).toEqual({ v: 1, kind: "rejected", id: 2, reason: "unknown-generation" })
    expect(probe.signals).toEqual([])
  })

  test("refuses at once a pid held by a live process that leads no group", async () => {
    const probe = guardianProbe({})
    probe.others.add(321)

    probe.send(hello(1), open(2), adopt(3, "owned:1", 321))
    probe.endControl()
    await probe.finished

    expect(probe.replies.at(-1)).toEqual({ v: 1, kind: "rejected", id: 3, reason: "not-a-container" })
    expect(probe.signals).toEqual([])
  })

  test("refuses a pid whose identity does not answer, says it could not prove it, and asks again on the next adoption", async () => {
    // An adoption must be answered now, so it asks once. The refusal names the
    // missing answer rather than a container that was not there, and nothing
    // is kept, so the next adoption of the same pid asks the kernel again.
    const probe = guardianProbe({ 321: "identity-321" })
    probe.unproven.add(321)

    probe.send(hello(1), open(2), adopt(3, "owned:1", 321))
    expect(await probe.answer(3)).toEqual({ v: 1, kind: "rejected", id: 3, reason: "container-unproven" })
    probe.unproven.delete(321)
    probe.send(adopt(4, "owned:2", 321))
    expect(await probe.answer(4)).toEqual({ v: 1, kind: "adopted", id: 4, token: "owned:2" })
    probe.endControl()
    await probe.finished
  })

  test("refuses adoption past the admission bound", async () => {
    const probe = guardianProbe({ 101: "a", 102: "b", 103: "c" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101), adopt(4, "owned:2", 102), adopt(5, "owned:3", 103))
    probe.endControl()
    await probe.finished

    expect(probe.replies.at(-1)).toEqual({ v: 1, kind: "rejected", id: 5, reason: "at-capacity" })
  })

  test("retires a released token so the same token can never own a second container", async () => {
    const probe = guardianProbe({ 101: "a", 102: "b" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101), release(4, "owned:1"), adopt(5, "owned:1", 102))
    probe.endControl()
    await probe.finished

    expect(probe.replies.slice(2)).toEqual([
      { v: 1, kind: "adopted", id: 3, token: "owned:1" },
      { v: 1, kind: "released", id: 4, token: "owned:1" },
      { v: 1, kind: "rejected", id: 5, reason: "token-retired" },
    ])
    expect(probe.signals).toEqual([])
  })

  test("releases the container behind every lease it stops holding", async () => {
    // On a platform whose containers are named, ownership is a handle this side
    // holds. A lease dropped without releasing it would leak that handle, and
    // a container whose last handle never closes outlives its owner.
    const probe = guardianProbe({ 101: "a", 102: "b" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101), adopt(4, "owned:2", 102), release(5, "owned:1"))
    await probe.answer(5)

    expect(probe.forgotten).toEqual(["owned:1"])

    probe.endControl()
    await probe.finished

    // The sweep releases what it still held, and only after the kill: closing
    // first would hand a container back with its members still running.
    expect(probe.forgotten).toEqual(["owned:1", "owned:2"])
  })

  test("releases a container it refused to adopt, so a refusal holds nothing", async () => {
    const probe = guardianProbe({})

    probe.send(hello(1), open(2), adopt(3, "owned:1", 404))
    probe.endControl()
    await probe.finished

    expect(probe.replies.at(-1)).toEqual({ v: 1, kind: "rejected", id: 3, reason: "not-a-container" })
    expect(probe.forgotten).toEqual(["owned:1"])
  })

  test("replays the release it already performed and refuses one it never issued", async () => {
    const probe = guardianProbe({ 101: "a" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101))
    // The first release performs the transition, the second is a retry of a
    // reply that may have been lost, and the third names a lease that never
    // existed.
    probe.send(release(4, "owned:1"), release(5, "owned:1"), release(6, "owned:never"))
    probe.endControl()
    await probe.finished

    expect(probe.replies.slice(3)).toEqual([
      { v: 1, kind: "released", id: 4, token: "owned:1" },
      { v: 1, kind: "released", id: 5, token: "owned:1" },
      { v: 1, kind: "rejected", id: 6, reason: "unknown-token" },
    ])
  })

  test("refuses a release that names another generation's lease", async () => {
    const probe = guardianProbe({ 101: "a" })

    probe.send(hello(1), open(2), open(3, "gen:other"), adopt(4, "owned:1", 101))
    probe.send(release(5, "owned:1", "gen:other"))
    probe.endControl()
    await probe.finished

    expect(probe.replies.at(-1)).toEqual({ v: 1, kind: "rejected", id: 5, reason: "unknown-token" })
    // Still owned, so the sweep at channel end is what ends it.
    expect(probe.signals).toEqual(["SIGTERM:101", "SIGKILL:101"])
  })

  test("terminates every container it still owns when the control channel ends", async () => {
    const probe = guardianProbe({ 101: "a", 102: "b" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101), adopt(4, "owned:2", 102))
    probe.endControl()
    await probe.finished

    expect(probe.signals).toEqual(["SIGTERM:101", "SIGTERM:102", "SIGKILL:101", "SIGKILL:102"])
  })

  test.each<[string, readonly number[], Array<[string, { readonly [field: string]: unknown }]>]>([
    ["records one warning naming only the containers it could not prove empty", [101], [["the guardian's sweep did not prove every container empty", { remaining: 1, containers: [102] }]]],
    ["records nothing for a sweep that emptied every container", [101, 102], []],
  ])("a sweep %s", async (_case, takeTheSignal, warnings) => {
    const warn = spyOn(Log.create({ service: "process-guardian" }), "warn")
    try {
      const probe = guardianProbe({ 101: "a", 102: "b" })
      for (const pid of takeTheSignal) probe.diesOnSignal.add(pid)

      probe.send(hello(1), open(2), adopt(3, "owned:1", 101), adopt(4, "owned:2", 102))
      probe.endControl()
      await probe.finished

      expect(warn.mock.calls).toEqual(warnings)
    } finally {
      warn.mockRestore()
    }
  })

  test("never signals a pid whose identity changed under it", async () => {
    const containers = { 101: "a" }
    const probe = guardianProbe(containers)

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101))
    await Bun.sleep(0)
    containers[101] = "recycled"
    probe.endControl()
    await probe.finished

    expect(probe.signals).toEqual([])
  })

  test("still ends a container whose leader exited before the container emptied", async () => {
    const containers: ContainerIdentities = { 101: "a" }
    const probe = guardianProbe(containers)

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101))
    await Bun.sleep(0)
    // The leader is gone, so nothing leads the group any more, but a descendant
    // still holds it. Ownership ends with the container, not with the leader.
    delete containers[101]
    probe.endControl()
    await probe.finished

    expect(probe.signals).toEqual(["SIGTERM:101", "SIGKILL:101"])
  })

  test("releases without a signal a lease whose pid now holds a live process that leads no group", async () => {
    // The kernel never gives a pid to a new process while a group with that id
    // exists, so the leased container is proven gone.
    const probe = guardianProbe({ 101: "a" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101))
    await Bun.sleep(0)
    probe.others.add(101)
    probe.send(closeGeneration(4))

    expect(await probe.answer(4)).toEqual({ v: 1, kind: "closed", id: 4, generation: GENERATION, remaining: 0 })
    expect(probe.signals).toEqual([])
    probe.endControl()
    await probe.finished
  })

  test("never signals a container whose identity the probe could not answer for", async () => {
    const probe = guardianProbe({ 101: "a" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101))
    await Bun.sleep(0)
    // Nothing was proved about this pid: not that it is still the container
    // that was leased, and not that its leader is gone. A kill on no evidence
    // is a kill of whatever now holds the number.
    probe.unproven.add(101)
    probe.endControl()
    await probe.finished

    expect(probe.signals).toEqual([])
  })

  test("keeps a container whose identity could not be probed instead of reporting it settled", async () => {
    const probe = guardianProbe({ 101: "a" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101))
    await Bun.sleep(0)
    probe.unproven.add(101)
    probe.send(closeGeneration(4))

    expect(await probe.answer(4)).toEqual({ v: 1, kind: "closed", id: 4, generation: GENERATION, remaining: 1 })
    expect(probe.signals).toEqual([])
    probe.endControl()
    await probe.finished
  })

  test("signals nothing once the container it owned is empty", async () => {
    const containers: ContainerIdentities = { 101: "a" }
    const probe = guardianProbe(containers)

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101))
    await Bun.sleep(0)
    delete containers[101]
    probe.populated.delete(101)
    probe.endControl()
    await probe.finished

    expect(probe.signals).toEqual([])
  })

  test("fails closed when the host sends a frame it could not have produced", async () => {
    const probe = guardianProbe({ 101: "a" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101))
    probe.sendRaw("{ not a frame }\n")

    await expect(probe.finished).rejects.toThrow(/frame/i)
    expect(probe.signals).toEqual(["SIGTERM:101", "SIGKILL:101"])
  })
})

describe("guardian stop hold", () => {
  const holdDirectory = temporaryDirectories()

  test.each(["channel end", "generation close"] as const)("sends a leased container nothing at its %s while the lease's stop hold stands", async (ending) => {
    const hold = join(holdDirectory("stop-hold-"), ".oauth_refresh.lock")
    writeFileSync(hold, "")
    const probe = guardianProbe({ 101: "a" })
    probe.diesOnSignal.add(101)
    const signalledWhileHeld: string[][] = []
    probe.onSleep = (count) => {
      if (count < 5) return
      signalledWhileHeld.push([...probe.signals])
      rmSync(hold, { force: true })
    }

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101, GENERATION, CAPABILITY, { path: hold, boundMs: 35_000 }))
    if (ending === "generation close") {
      probe.send(closeGeneration(4))
      expect(await probe.answer(4)).toMatchObject({ kind: "closed", remaining: 0 })
    }
    probe.endControl()
    await probe.finished

    expect(signalledWhileHeld[0]).toEqual([])
    expect(probe.signals).toEqual(["SIGTERM:101"])
  })
})

describe("guardian generation close", () => {
  test("ends every container of the generation it closes and answers that it is empty", async () => {
    const probe = guardianProbe({ 101: "a" })
    probe.diesOnSignal.add(101)

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101), closeGeneration(4))

    expect(await probe.answer(4)).toEqual({ v: 1, kind: "closed", id: 4, generation: GENERATION, remaining: 0 })
    expect(probe.signals).toEqual(["SIGTERM:101"])
    probe.endControl()
    await probe.finished
  })

  test("reports the containers that outlived its kill instead of claiming settlement", async () => {
    const probe = guardianProbe({ 101: "a" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101), closeGeneration(4))

    expect(await probe.answer(4)).toEqual({ v: 1, kind: "closed", id: 4, generation: GENERATION, remaining: 1 })
    expect(probe.signals).toEqual(["SIGTERM:101", "SIGKILL:101"])
    probe.endControl()
    await probe.finished
    // The container is still this generation's, because nothing proved it
    // empty. The sweep at channel end is what addresses it again.
    expect(probe.signals).toEqual(["SIGTERM:101", "SIGKILL:101", "SIGTERM:101", "SIGKILL:101"])
  })

  test("re-measures a generation whose close could not prove its containers empty", async () => {
    const probe = guardianProbe({ 101: "a" })

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101), closeGeneration(4))
    expect(await probe.answer(4)).toEqual({ v: 1, kind: "closed", id: 4, generation: GENERATION, remaining: 1 })

    // What the first close could not prove empty is still leased, so closing
    // again ends it again and answers what is left instead of replaying a
    // settlement nobody proved.
    probe.diesOnSignal.add(101)
    probe.send(closeGeneration(5))

    expect(await probe.answer(5)).toEqual({ v: 1, kind: "closed", id: 5, generation: GENERATION, remaining: 0 })
    expect(probe.signals).toEqual(["SIGTERM:101", "SIGKILL:101", "SIGTERM:101"])
    probe.endControl()
    await probe.finished
    // The second close proved it empty, so its lease ended there and the sweep
    // has nothing left to address.
    expect(probe.signals).toEqual(["SIGTERM:101", "SIGKILL:101", "SIGTERM:101"])
  })

  test("leaves another generation's containers alone, and refuses every later lease of the closed one", async () => {
    const probe = guardianProbe({ 101: "a", 102: "b" })
    probe.diesOnSignal.add(101)

    probe.send(hello(1), open(2), open(3, "gen:other"))
    probe.send(adopt(4, "owned:1", 101), adopt(5, "owned:2", 102, "gen:other"), closeGeneration(6))
    await probe.answer(6)
    probe.send(open(7), adopt(8, "owned:3", 102))
    await Bun.sleep(1)

    expect(probe.signals).toEqual(["SIGTERM:101"])
    expect(probe.replies.slice(-2)).toEqual([
      { v: 1, kind: "rejected", id: 7, reason: "generation-retired" },
      { v: 1, kind: "rejected", id: 8, reason: "unknown-generation" },
    ])
    probe.endControl()
    await probe.finished
  })

  test("replays the close of a generation it already ended and refuses one it never opened", async () => {
    const probe = guardianProbe({})

    probe.send(hello(1), open(2), closeGeneration(3))
    await probe.answer(3)
    probe.send(closeGeneration(4), closeGeneration(5, "gen:nobody"))
    await Bun.sleep(1)

    expect(probe.replies.slice(-2)).toEqual([
      { v: 1, kind: "closed", id: 4, generation: GENERATION, remaining: 0 },
      { v: 1, kind: "rejected", id: 5, reason: "unknown-generation" },
    ])
    probe.endControl()
    await probe.finished
  })
})

describe("process guardian ledger", () => {
  test("records each lease it holds, removes its own record when the lease ends, and keeps the record of a container its sweep could not empty", async () => {
    const records = ledgerProbe()
    const probe = guardianProbe({ 101: "a", 102: "b" }, {}, records.ledger)

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101), adopt(4, "owned:2", 102))
    await probe.answer(4)
    expect([...records.held.values()]).toEqual([
      { token: "owned:1", pid: 101, identity: "a", stopHold: null },
      { token: "owned:2", pid: 102, identity: "b", stopHold: null },
    ])

    probe.send(release(5, "owned:1"))
    await probe.answer(5)
    // 102 outlives the sweep's kill, so its record is what lets the next
    // guardian end it.
    probe.endControl()
    await probe.finished

    expect(records.dropped).toEqual([record("owned:1", process.pid)])
    expect([...records.held.keys()]).toEqual(["owned:2"])
  })

  test("ends a container a dead guardian left once its supervisor is gone too, and signals nothing it cannot prove is that container", async () => {
    const records = ledgerProbe(
      // The supervisor is gone and the payload still holds its group.
      abandonedLease("owned:orphan", 321, "identity-321"),
      // The supervisor still runs, so its own watch of its dead guardian ends
      // the container, or a later owner adopts it.
      abandonedLease("owned:supervised", 322, "identity-322"),
      // The pid now holds a process that leads no group, so the container is
      // proven gone.
      abandonedLease("owned:gone", 323, "identity-323"),
      // The pid now leads another container, so the recorded one is gone.
      abandonedLease("owned:reused", 324, "old"),
      // The probe does not answer, so nothing is decided yet.
      abandonedLease("owned:unproven", 325, "identity-325"),
      // The leader is gone and no member of its group carries the launch's
      // mark, where the kernel shows every member's environment.
      abandonedLease("owned:stranger", 326, "identity-326"),
      // The same, and the launch still runs a process outside that group.
      abandonedLease("owned:escaped", 328, "identity-328"),
    )
    const probe = guardianProbe({ 322: "identity-322", 324: "new" }, {}, records.ledger)
    probe.populated.add(321)
    probe.diesOnSignal.add(321)
    probe.groupMarks.set(321, "marked")
    probe.others.add(323)
    probe.unproven.add(325)
    probe.populated.add(326)
    probe.groupMarks.set(326, "unmarked")
    probe.populated.add(328)
    probe.groupMarks.set(328, "unmarked")
    probe.escapes.add(328)

    probe.send(hello(1))
    await probe.answer(1)
    for (let attempt = 0; attempt < 100 && records.dropped.length < 5; attempt += 1) await Bun.sleep(1)
    probe.endControl()
    await probe.finished

    // The stranger's groups take no signal; the launch's process outside one
    // of them does.
    expect(probe.signals.toSorted()).toEqual(["SIGTERM:321", "SIGTERM:outside:328"])
    expect(records.dropped.toSorted()).toEqual(["owned:escaped", "owned:gone", "owned:orphan", "owned:reused", "owned:stranger"].map((token) => record(token, DEAD_GUARDIAN)))
    expect([...records.left.values()].map((lease) => lease.token).toSorted()).toEqual(["owned:supervised", "owned:unproven"])
  })

  test("removes a dead guardian's record of a command it adopted since, and leaves its own record and the command alone", async () => {
    const records = ledgerProbe(abandonedLease("owned:adopted", 327, "c"))
    const probe = guardianProbe({ 327: "c" }, {}, records.ledger)

    probe.send(hello(1), open(2), adopt(3, "owned:adopted", 327))
    await probe.answer(3)
    for (let attempt = 0; attempt < 100 && records.left.size > 0; attempt += 1) await Bun.sleep(1)

    expect(records.dropped).toEqual([record("owned:adopted", DEAD_GUARDIAN)])
    expect([...records.held.keys()]).toEqual(["owned:adopted"])
    expect(probe.signals).toEqual([])
    probe.endControl()
    await probe.finished
  })

  test("sweeps its own leases at channel end and waits for a recovery pass in progress at most the kill grace", async () => {
    const records = ledgerProbe(abandonedLease("owned:orphan", 321, "identity-321"))
    const probe = guardianProbe({ 101: "a" }, { killGraceMs: 60_000 }, records.ledger)
    probe.populated.add(321)
    probe.diesOnSignal.add(101)
    let resume: () => void = () => {}
    const held = new Promise<void>((resolve) => { resume = resolve })
    // Only the recovery pass's first wait, its grace after the orphan's TERM,
    // holds. The guardian's bound on that pass is a later wait, which ends.
    probe.onSleep = (count) => (count === 1 ? held : undefined)

    probe.send(hello(1), open(2), adopt(3, "owned:1", 101))
    await probe.answer(3)
    for (let attempt = 0; attempt < 100 && !probe.signals.includes("SIGTERM:321"); attempt += 1) await Bun.sleep(1)
    probe.endControl()
    try {
      const waited = (async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) await Bun.sleep(1)
        return "still waiting"
      })()
      expect(await Promise.race([probe.finished.then(() => "finished"), waited])).toBe("finished")
      expect(probe.signals).toEqual(["SIGTERM:321", "SIGTERM:101"])
      // The cut pass did not finish the orphan, so its record stays for the
      // next guardian.
      expect([...records.left.values()].map((lease) => lease.token)).toEqual(["owned:orphan"])
    } finally {
      probe.populated.delete(321)
      resume()
      await probe.finished
    }
  })
})
