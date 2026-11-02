import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAccountProjectRegistry } from "../../../../src/orchestration/app-service/account-project-registry.js"
import { createReplacementHandoffs, type ReplacementHandoffsOptions } from "../../../../src/orchestration/app-service/replacement-handoffs.js"

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function account() {
  const root = mkdtempSync(join(tmpdir(), "flywheel-replacement-handoffs-"))
  const registry = createAccountProjectRegistry({ userDataRoot: join(root, "account") })
  cleanups.push(async () => {
    await registry.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const project = (name: string): string => {
    const projectRoot = join(root, name)
    mkdirSync(projectRoot)
    return projectRoot
  }
  const roots = (): (readonly string[])[] => registry.replacementHandoffs("installed").map((row) => [...row.projectRoots].sort())
  return { root, registry, project, roots }
}

/** An open project as the account reaches it: its executor, which records
 *  every handoff command it was sent and whose answer the test may make
 *  fail, whether a surface holds the project, and its browser endpoint,
 *  whose opens `browsers` records. */
/** An account that holds no project awake for the phone. */
const noPhone = { awakeForPhone: () => false, holdAwakeForPhone: async (): Promise<void> => {} }

function openedProject(calls: string[], name: string, fail: () => boolean = () => false, surface: { readonly held?: boolean; readonly browsers?: string[] } = {}) {
  return {
    composition: {
      async handoff(kind: "interrupt_for_replacement" | "continue_after_replacement", handoffId: string) {
        if (fail()) throw new Error(`${name} executor is recovering`)
        calls.push(`${name}:${kind}:${handoffId}`)
        return kind === "interrupt_for_replacement" && name === "idle" ? [] : [`${name}-session`]
      },
    },
    holdClient: () => () => {},
    held: () => surface.held === true,
    async openBrowser() {
      surface.browsers?.push(name)
      return `http://127.0.0.1/${name}`
    },
  }
}

/** Opens each named project from `projects`, counting holds. */
function opener(projects: ReadonlyMap<string, ReturnType<typeof openedProject>>, held: { count: number }, refuse: (projectRoot: string) => boolean = () => false): ReplacementHandoffsOptions["open"] {
  return async (projectRoot) => {
    if (refuse(projectRoot)) throw new Error("project store is locked")
    const found = projects.get(projectRoot)
    if (!found) throw new Error(`unexpected open of ${projectRoot}`)
    return { ...found, holdClient: () => { held.count += 1; return () => { held.count -= 1 } } }
  }
}

async function until(label: string, accept: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!accept()) {
    if (Date.now() > deadline) throw new Error(`${label} did not happen`)
    await Bun.sleep(2)
  }
}

describe("replacement handoffs", () => {
  test("the handoff names every project open at the cut, so work any of them admits after the cut is continued", async () => {
    const { registry, project } = account()
    const running = project("running")
    const idle = project("idle")
    const calls: string[] = []
    const handoffs = createReplacementHandoffs({
      lane: "installed",
      ...noPhone,
      registry,
      openProjects: () => new Map([[running, openedProject(calls, "running")], [idle, openedProject(calls, "idle")]]),
      open: async () => { throw new Error("the predecessor opens nothing") },
    })

    await handoffs.handOff("h1")

    const [row, ...others] = registry.replacementHandoffs("installed")
    expect(others).toEqual([])
    if (!row) throw new Error("no handoff row")
    expect(row.handoffId).toBe("h1")
    expect([...row.projectRoots].sort()).toEqual([idle, running].sort())
    expect(row.predecessorPid).toBe(process.pid)
    expect(handoffs.predecessorPids(running)).toEqual([])
    expect(calls.sort()).toEqual(["idle:interrupt_for_replacement:h1", "running:interrupt_for_replacement:h1"])
  })

  test("a replacement writes its row with no project open, and a project whose executor serves during the handoff joins it", async () => {
    const { registry, project, roots } = account()
    const late = project("late")
    const handoffs = createReplacementHandoffs({ lane: "installed", ...noPhone, registry, openProjects: () => new Map(), open: async () => { throw new Error("unused") } })

    await handoffs.handOff("h1")
    expect(roots()).toEqual([[]])
    await handoffs.join(late)
    await handoffs.join(late)
    expect(roots()).toEqual([[late]])
  })

  test("a handoff whose row failed to persist never authorizes successor-only recovery", async () => {
    const { registry, project } = account()
    const root = project("unrecorded")
    const handoffs = createReplacementHandoffs({
      lane: "installed", ...noPhone,
      registry: { ...registry, recordReplacementHandoff: async () => { throw new Error("disk full") } },
      openProjects: () => new Map([[root, openedProject([], "unrecorded")]]),
      open: async () => { throw new Error("unused") },
    })
    await expect(handoffs.handOff("unwritten")).rejects.toThrow("disk full")
    expect(await handoffs.stopped(root, { continuations: 1, handovers: 0 })).toBe(false)
  })

  test("each project's stop narrows the row to the projects with work to continue, a command to adopt, or a surface to serve again", async () => {
    const { registry, project, roots } = account()
    const empty = project("empty")
    const busy = project("busy")
    const silent = project("silent")
    const viewed = project("viewed")
    const calls: string[] = []
    const handoffs = createReplacementHandoffs({
      lane: "installed",
      ...noPhone,
      registry,
      openProjects: () => new Map([[empty, openedProject(calls, "empty")], [busy, openedProject(calls, "busy")], [silent, openedProject(calls, "silent")], [viewed, openedProject(calls, "viewed", () => false, { held: true })]]),
      open: async () => { throw new Error("unused") },
    })
    await handoffs.handOff("h1")

    expect(await handoffs.stopped(empty, { continuations: 0, handovers: 0 })).toBe(false)
    // `busy` holds one continuation row and one handover row for the successor.
    expect(await handoffs.stopped(busy, { continuations: 1, handovers: 1 })).toBe(true)
    // A surface held `viewed` at the cut, so it stays named with no work to continue.
    expect(await handoffs.stopped(viewed, { continuations: 0, handovers: 0 })).toBe(true)
    // `silent` never reports, as after a crash or a stop past its deadline, so it stays named.
    expect(roots()).toEqual([[busy, silent, viewed].sort()])
  })

  test("the successor serves each named project's browser endpoint again, so a page that redials its project's own address finds it", async () => {
    const { registry, project } = account()
    const viewed = project("viewed")
    await registry.recordReplacementHandoff("installed", { handoffId: "h1", requestedAt: 1, predecessorPid: process.pid, projectRoots: [viewed], phoneAwakeRoots: [] })
    const calls: string[] = []
    const browsers: string[] = []
    const held = { count: 0 }
    const projects = new Map([[viewed, openedProject(calls, "viewed", () => false, { browsers })]])
    const handoffs = createReplacementHandoffs({ lane: "installed", ...noPhone, registry, openProjects: () => new Map(), open: opener(projects, held) })

    expect(handoffs.predecessorPids(viewed)).toEqual([process.pid])
    await handoffs.continueAll()

    expect(browsers).toEqual(["viewed"])
    expect(calls).toEqual(["viewed:continue_after_replacement:h1"])
    // The duty leaves the project to its idle grace, which a reattached surface holds.
    expect(held.count).toBe(0)
    expect(registry.replacementHandoffs("installed")).toEqual([])
  })

  test("the row names a project the phone held awake at the cut whose stop handed commands over", async () => {
    const { registry, project } = account()
    const woken = project("woken")
    const wokenResumed = project("woken-resumed")
    const quiet = project("quiet")
    const calls: string[] = []
    const awakeAtCut = new Set([woken, wokenResumed])
    const handoffs = createReplacementHandoffs({
      lane: "installed", registry, open: async () => { throw new Error("unused") },
      openProjects: () => new Map([[woken, openedProject(calls, "woken")], [wokenResumed, openedProject(calls, "woken-resumed")], [quiet, openedProject(calls, "quiet")]]),
      awakeForPhone: (projectRoot) => awakeAtCut.has(projectRoot),
      holdAwakeForPhone: async () => { throw new Error("the predecessor holds nothing awake") },
    })
    await handoffs.handOff("h1")
    // The phone's hold ends with the project's close; the cut already read it.
    awakeAtCut.clear()

    await handoffs.stopped(woken, { continuations: 0, handovers: 1 })
    await handoffs.stopped(wokenResumed, { continuations: 1, handovers: 0 })
    await handoffs.stopped(quiet, { continuations: 0, handovers: 1 })

    expect(registry.replacementHandoffs("installed").map((row) => row.phoneAwakeRoots)).toEqual([[woken]])
  })

  test("the successor holds a continued project awake for the phone only when its row names it so", async () => {
    const { registry, project } = account()
    const woken = project("woken")
    const quiet = project("quiet")
    await registry.recordReplacementHandoff("installed", { handoffId: "h1", requestedAt: 1, predecessorPid: process.pid, projectRoots: [woken, quiet], phoneAwakeRoots: [woken] })
    const calls: string[] = []
    const projects = new Map([[woken, openedProject(calls, "woken")], [quiet, openedProject(calls, "quiet")]])
    const awake: string[] = []
    const handoffs = createReplacementHandoffs({
      lane: "installed", registry, openProjects: () => new Map(), open: opener(projects, { count: 0 }),
      awakeForPhone: () => false,
      holdAwakeForPhone: async (projectRoot) => { awake.push(projectRoot) },
    })

    await handoffs.continueAll()

    expect(calls.toSorted()).toEqual(["quiet:continue_after_replacement:h1", "woken:continue_after_replacement:h1"])
    expect(awake).toEqual([woken])
  })

  test("a service never continues a handoff it recorded itself", async () => {
    const { registry, project, roots } = account()
    const open = project("open")
    const calls: string[] = []
    const held = { count: 0 }
    const projects = new Map([[open, openedProject(calls, "open")]])
    const handoffs = createReplacementHandoffs({ lane: "installed", ...noPhone, registry, openProjects: () => projects, open: opener(projects, held), retryDelayMs: () => 1 })

    await handoffs.handOff("h1")
    // The project's next executor generation becomes ready in this same
    // service and joins the handoff. A continuation pass that reads the rows
    // now continues nothing here.
    await handoffs.join(open)
    await handoffs.continueAll()

    expect(calls).toEqual(["open:interrupt_for_replacement:h1"])
    expect(roots()).toEqual([[open]])
  })

  test("a duty still retrying a predecessor's row never takes up the handoff this service recorded", async () => {
    const { registry, project } = account()
    const shared = project("shared")
    await registry.recordReplacementHandoff("installed", { handoffId: "old", requestedAt: 1, predecessorPid: process.pid, projectRoots: [shared], phoneAwakeRoots: [] })
    const calls: string[] = []
    const held = { count: 0 }
    let failing = true
    const failed = Promise.withResolvers<void>()
    const projects = new Map([[shared, openedProject(calls, "shared", () => { if (failing) failed.resolve(); return failing })]])
    const handoffs = createReplacementHandoffs({ lane: "installed", ...noPhone, registry, openProjects: () => projects, open: opener(projects, held), retryDelayMs: () => 5 })

    const continued = handoffs.continueAll()
    // The duty's first attempt has failed, so it waits to retry.
    await failed.promise
    failing = false
    await handoffs.handOff("mine")
    await continued

    expect(calls).toContain("shared:continue_after_replacement:old")
    expect(calls).not.toContain("shared:continue_after_replacement:mine")
    expect(registry.replacementHandoffs("installed").map((row) => row.handoffId)).toEqual(["mine"])
    handoffs.dispose()
  })

  test("a continuation that fails is retried on its own, with no executor event, and each project continues independently", async () => {
    const { root, registry, project, roots } = account()
    const steady = project("steady")
    const flaky = project("flaky")
    const locked = project("locked")
    const deleted = join(root, "deleted")
    await registry.recordReplacementHandoff("installed", { handoffId: "h1", requestedAt: 1, predecessorPid: process.pid, projectRoots: [steady, flaky, locked, deleted], phoneAwakeRoots: [] })
    const calls: string[] = []
    const held = { count: 0 }
    let flakyFailures = 1
    let lockedOpen = false
    const projects = new Map([
      [steady, openedProject(calls, "steady")],
      [flaky, openedProject(calls, "flaky", () => flakyFailures-- > 0)],
      [locked, openedProject(calls, "locked")],
    ])
    const handoffs = createReplacementHandoffs({
      lane: "installed",
      ...noPhone,
      registry,
      openProjects: () => new Map(),
      open: opener(projects, held, (projectRoot) => projectRoot === locked && !lockedOpen),
      retryDelayMs: () => 2,
    })

    const continued = handoffs.continueAll()
    // The project that opens continues at once, and the one whose first
    // continuation failed continues on its retry, while the locked project
    // keeps retrying.
    await until("steady and flaky continued", () => calls.includes("steady:continue_after_replacement:h1") && calls.includes("flaky:continue_after_replacement:h1"))
    await until("row narrowed", () => JSON.stringify(roots()) === JSON.stringify([[locked]]))
    expect(calls.filter((call) => call.startsWith("flaky:"))).toEqual(["flaky:continue_after_replacement:h1"])

    lockedOpen = true
    await continued
    expect(calls.filter((call) => call.startsWith("locked:"))).toEqual(["locked:continue_after_replacement:h1"])
    // A project whose directory is gone has nothing to continue and leaves the row.
    expect(registry.replacementHandoffs("installed")).toEqual([])
    expect(held.count).toBe(0)
  })

  test("a live pid that serves none of its row's projects is not waited for", async () => {
    const { registry, project } = account()
    const named = project("named")
    // A live process that is not a service of this lane, such as a reused pid.
    await registry.recordReplacementHandoff("installed", { handoffId: "h1", requestedAt: 1, predecessorPid: process.ppid, projectRoots: [named], phoneAwakeRoots: [] })
    const calls: string[] = []
    const held = { count: 0 }
    const projects = new Map([[named, openedProject(calls, "named")]])
    const handoffs = createReplacementHandoffs({ lane: "installed", ...noPhone, registry, openProjects: () => new Map(), open: opener(projects, held) })

    const started = Date.now()
    await handoffs.continueAll()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls).toEqual(["named:continue_after_replacement:h1"])
  })

  test("asking whether the predecessor still serves never re-creates a project the person deleted", async () => {
    const { root, registry, project } = account()
    const kept = project("kept")
    const deleted = join(root, "deleted")
    // A live pid keeps the check reading every root the row names.
    await registry.recordReplacementHandoff("installed", { handoffId: "h1", requestedAt: 1, predecessorPid: process.ppid, projectRoots: [kept, deleted], phoneAwakeRoots: [] })
    const calls: string[] = []
    const held = { count: 0 }
    const projects = new Map([[kept, openedProject(calls, "kept")]])
    const handoffs = createReplacementHandoffs({ lane: "installed", ...noPhone, registry, openProjects: () => new Map(), open: opener(projects, held) })

    await handoffs.continueAll()
    expect(existsSync(deleted)).toBe(false)
    expect(calls).toEqual(["kept:continue_after_replacement:h1"])
    expect(registry.replacementHandoffs("installed")).toEqual([])
  })

  test("a predecessor that still serves past its bound is waited for and never signalled", async () => {
    const { registry, project } = account()
    const named = project("named")
    // The predecessor's serving holder, as its claim writes it, for a live
    // pid that this test must not end.
    mkdirSync(join(named, ".flywheel"))
    writeFileSync(join(named, ".flywheel", `project-serving.installed.lock.shared.${randomUUID()}`), JSON.stringify({ pid: process.ppid, owner: "previous" }))
    await registry.recordReplacementHandoff("installed", { handoffId: "h1", requestedAt: 1, predecessorPid: process.ppid, projectRoots: [named], phoneAwakeRoots: [] })
    const calls: string[] = []
    const held = { count: 0 }
    const projects = new Map([[named, openedProject(calls, "named")]])
    const handoffs = createReplacementHandoffs({ lane: "installed", ...noPhone, registry, openProjects: () => new Map(), open: opener(projects, held), predecessorBoundMs: 150 })
    // The spy calls through, so the liveness reads still ask the kernel.
    const kill = spyOn(process, "kill")
    let signals: unknown[]
    try {
      const started = Date.now()
      await handoffs.continueAll()
      expect(Date.now() - started).toBeGreaterThanOrEqual(150)
      signals = kill.mock.calls.map((call) => call[1]).filter((signal) => signal !== 0)
      expect(kill.mock.calls.length).toBeGreaterThan(0)
    } finally {
      kill.mockRestore()
    }
    expect(signals).toEqual([])
    expect(calls).toEqual(["named:continue_after_replacement:h1"])
  })
})
