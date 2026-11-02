import { describe, expect, test } from "bun:test"
import { createReplacementOwner, type ReplacementState, type ReplacementTrigger } from "../../../../src/orchestration/app-service/replacement-owner.js"
import { createMutationAdmission } from "../../../../src/orchestration/app-service/mutation-admission.js"
import { createReplacementReport, type ReplacementBlocker } from "../../../../src/orchestration/app-service/replacement-blockers.js"

const A: ReplacementBlocker = { projectRoot: "/a", projectLabel: "a", reason: "recovery" }
const B: ReplacementBlocker = { projectRoot: "/b", projectLabel: "b", reason: "call" }

/** What asks every case's replacement. */
const NEWER: ReplacementTrigger = { kind: "newer build installed", ownBuild: "a".repeat(64), installedBuild: "b".repeat(64) }

/** The drain, under whichever handoff id the owner chose. */
const DRAINING: ReplacementState = { kind: "draining", handoffId: expect.any(String) }

function harness(options: { readonly handOff?: () => Promise<void> } = {}) {
  // Two projects, each answering its own blockers; the owner sees one account-wide list.
  const projects = new Map<string, ReplacementBlocker[]>([["/a", [A]], ["/b", [B]]])
  let reads = 0
  let retirements = 0
  const handOffs: string[] = []
  const published: ReplacementState[] = []
  const owner = createReplacementOwner({
    blockers: async () => { reads += 1; return [...projects.values()].flat() },
    handOff: async (handoffId) => { handOffs.push(handoffId); await options.handOff?.() },
    retire: () => { retirements += 1 },
    repollMs: 5,
  })
  owner.subscribe((state) => published.push(state))
  return { owner, projects, published, handOffs: () => handOffs.length, handoffIds: handOffs, reads: () => reads, retirements: () => retirements }
}

describe("replacement owner", () => {
  test("a request aggregates blockers across projects, waits, and republishes only a changed list", async () => {
    const { owner, projects, published } = harness()
    expect(owner.state).toEqual({ kind: "none" })
    expect(await owner.request(NEWER)).toBe("busy")
    expect(owner.state).toEqual({ kind: "requested", blockers: [A, B] })
    expect(published).toEqual([{ kind: "requested", blockers: [A, B] }])

    owner.refresh()
    await Bun.sleep(1)
    expect(published).toHaveLength(1)

    projects.set("/b", [])
    owner.refresh()
    await Bun.sleep(1)
    expect(published).toHaveLength(2)
    expect(owner.state).toEqual({ kind: "requested", blockers: [A] })
    owner.dispose()
  })

  test("the drain begins once, when nothing blocks, and answers retiring from then on", async () => {
    const { owner, projects, published, retirements } = harness()
    await owner.request(NEWER)
    projects.set("/a", [])
    projects.set("/b", [])
    owner.refresh()
    await Bun.sleep(1)
    expect(owner.state).toEqual(DRAINING)
    expect(published.at(-1)).toEqual(DRAINING)
    expect(retirements()).toBe(1)
    owner.refresh()
    expect(await owner.request(NEWER)).toBe("retiring")
    expect(owner.state).toEqual(DRAINING)
    expect(retirements()).toBe(1)
    owner.dispose()
  })

  test("a request that finds nothing live drains at once, answering before the stop", async () => {
    const { owner, projects, retirements } = harness()
    projects.clear()
    const order: string[] = []
    expect(await owner.request(NEWER, async () => { order.push("answered"); expect(retirements()).toBe(0) })).toBe("retiring")
    expect(order).toEqual(["answered"])
    expect(retirements()).toBe(1)
    owner.dispose()
  })

  test("the repoll asks again on its own while requested and stops once the drain begins", async () => {
    const { owner, projects, reads, retirements } = harness()
    await owner.request(NEWER)
    const after = reads()
    await Bun.sleep(12)
    expect(reads()).toBeGreaterThan(after)
    projects.clear()
    await Bun.sleep(12)
    expect(owner.state).toEqual(DRAINING)
    const settled = reads()
    await Bun.sleep(12)
    expect(reads()).toBe(settled)
    expect(retirements()).toBe(1)
    owner.dispose()
  })

  test("running turns, questions, children, and shell commands never delay: the drain begins with one handoff whose id the state carries, and the stop follows the cut", async () => {
    const running: ReplacementBlocker[] = [
      { projectRoot: "/a", projectLabel: "a", sessionId: "a-1", reason: "turn" },
      { projectRoot: "/a", projectLabel: "a", sessionId: "a-2", reason: "question" },
      { projectRoot: "/b", projectLabel: "b", sessionId: "b-1", reason: "subagent" },
      { projectRoot: "/b", projectLabel: "b", sessionId: "b-2", reason: "shell" },
    ]
    const order: string[] = []
    const handedOff = Promise.withResolvers<void>()
    const { owner, projects, handOffs, handoffIds, published, retirements } = harness({ handOff: async () => { order.push("handoff"); await handedOff.promise } })
    projects.set("/a", running.slice(0, 2))
    projects.set("/b", running.slice(2))
    const answered = owner.request(NEWER, async () => { order.push("answered") })
    await Bun.sleep(1)
    // Once the handoff begins, every executor hears its id, and the service
    // no longer makes way for anything else.
    expect(handOffs()).toBe(1)
    const [handoffId] = handoffIds
    if (handoffId === undefined) throw new Error("no handoff began")
    expect(published).toEqual([{ kind: "draining", handoffId }])
    // A second request while the cut settles starts no other handoff.
    expect(await owner.request(NEWER)).toBe("retiring")
    expect(retirements()).toBe(0)
    handedOff.resolve()
    expect(await answered).toBe("retiring")
    expect(order).toEqual(["handoff", "answered"])
    expect(handOffs()).toBe(1)
    expect(retirements()).toBe(1)
    expect(published).toHaveLength(1)
    owner.dispose()
  })

  test("running shell commands never delay: a request whose only blockers are commands drains at once with one handoff and answers retiring", async () => {
    const commands: ReplacementBlocker[] = [
      { projectRoot: "/a", projectLabel: "a", sessionId: "a-1", sessionTitle: "Build", reason: "shell" },
      { projectRoot: "/b", projectLabel: "b", sessionId: "b-1", sessionTitle: "Serve", reason: "shell" },
    ]
    const { owner, projects, handOffs, published, retirements } = harness()
    projects.set("/a", commands.slice(0, 1))
    projects.set("/b", commands.slice(1))
    expect(await owner.request(NEWER)).toBe("retiring")
    expect(handOffs()).toBe(1)
    expect(published).toEqual([DRAINING])
    expect(retirements()).toBe(1)
    owner.dispose()
  })

  test("only the delaying blockers are published, and a failed handoff still drains", async () => {
    const turn: ReplacementBlocker = { projectRoot: "/b", projectLabel: "b", sessionId: "b-9", reason: "turn" }
    const { owner, projects, handOffs, retirements } = harness({ handOff: async () => { throw new Error("executor went away") } })
    projects.set("/b", [turn])
    expect(await owner.request(NEWER)).toBe("busy")
    expect(owner.state).toEqual({ kind: "requested", blockers: [A] })
    projects.set("/a", [])
    owner.refresh()
    await Bun.sleep(1)
    expect(handOffs()).toBe(1)
    expect(owner.state).toEqual(DRAINING)
    expect(retirements()).toBe(1)
    owner.dispose()
  })

  test("a read that fails leaves the state as it was and the request answers busy", async () => {
    let fail = true
    let retirements = 0
    const owner = createReplacementOwner({
      blockers: async () => { if (fail) throw new Error("project did not answer"); return [] },
      handOff: async () => {},
      retire: () => { retirements += 1 },
      repollMs: 5,
    })
    expect(await owner.request(NEWER)).toBe("busy")
    expect(owner.state).toEqual({ kind: "none" })
    fail = false
    expect(await owner.request(NEWER)).toBe("retiring")
    expect(retirements).toBe(1)
    owner.dispose()
  })

  // A project folder deleted while the service holds it open fails every
  // read of its store, so the owner hears its executor's answer, as the
  // executor composes it, and every later install joins this request.
  test("a project whose store cannot be read holds the request only while a call is in flight, then the drain begins", async () => {
    const unreadable = async (): Promise<never> => { throw new Error("disk I/O error") }
    const admission = createMutationAdmission()
    const report = createReplacementReport({
      projectRoot: "/work/gone", projectLabel: undefined, listMetadata: unreadable, runningChildren: () => [], runningWorkflows: () => [], keptSessions: () => [],
      sessionStore: { allIds: () => [], get: () => undefined }, client: { query: unreadable, admission },
    })
    let retirements = 0
    const owner = createReplacementOwner({ blockers: () => report.blockers(), handOff: async () => {}, retire: () => { retirements += 1 }, repollMs: 5 })
    const released = Promise.withResolvers<void>()
    const call = admission.admit(() => released.promise)
    expect(await owner.request(NEWER)).toBe("busy")
    expect(owner.state).toEqual({ kind: "requested", blockers: [{ projectRoot: "/work/gone", projectLabel: "gone", reason: "call" }] })

    released.resolve()
    await call
    await Bun.sleep(20)
    expect(owner.state).toEqual(DRAINING)
    expect(retirements).toBe(1)
    owner.dispose()
    report.stop()
  })

  test("a cut that has not settled within the owner's limit stops holding the stop", async () => {
    let retirements = 0
    const owner = createReplacementOwner({
      blockers: async () => [],
      // A turn that never settles: its continuation authority is already
      // durable, and the stop path shelves it as interrupted.
      handOff: () => new Promise<void>(() => {}),
      retire: () => { retirements += 1 },
      cutLimitMs: 5,
    })
    expect(await owner.request(NEWER)).toBe("retiring")
    expect(owner.state).toEqual(DRAINING)
    expect(retirements).toBe(1)
    owner.dispose()
  })
})
