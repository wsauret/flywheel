import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processHolders } from "../../../../src/infra/process-holder.js"
import { ContainedDirectory } from "../../../../src/infra/descriptor-directory.js"
import { acquireLockSyncIn, releaseLockIn } from "../../../../src/infra/ownership-file-lock.js"
import { createPersistentProcessManager } from "../../../../src/infra/persistent-process-manager.js"
import { claimHeadlessProjectExecution, claimProjectServing } from "../../../../src/orchestration/app-service/project-serving-lane.js"

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function project(): string {
  root = mkdtempSync(join(tmpdir(), "fw-lane-claim-"))
  const projectRoot = join(root, "project")
  mkdirSync(projectRoot)
  return projectRoot
}

/** A live process of `lane` that is not this one, holding the project the
 *  way a predecessor that has not finished closing it does. */
function holdAsAnotherProcess(projectRoot: string, lane: "dev" | "installed" | "headless") {
  const flywheel = join(projectRoot, ".flywheel")
  mkdirSync(flywheel, { recursive: true, mode: 0o700 })
  const pid = process.ppid
  const gate = lane === "headless" ? "project-execution.headless.lock" : `project-serving.${lane}.lock`
  const file = join(flywheel, `${gate}.shared.${randomUUID()}`)
  writeFileSync(file, JSON.stringify({ pid, owner: "predecessor" }))
  return { pid, file, release: () => { rmSync(file, { force: true }) } }
}

describe("one lane per open project", () => {
  test("handoff releases only the sole holder, including same-process holders", async () => {
    const projectRoot = project()
    const outgoing = await claimProjectServing(projectRoot, "dev")
    const successor = await claimProjectServing(projectRoot, "dev")
    expect(successor.exclusive).toBe(false)
    expect(await outgoing.releaseForHandoff(() => true)).toBe(false)
    successor()
    expect(await outgoing.releaseForHandoff(() => true)).toBe(true)
    const exclusive = await claimProjectServing(projectRoot, "dev")
    expect(exclusive.exclusive).toBe(true)
    exclusive()
    outgoing()
  })

  test("a successor registering during the handoff decision waits for the atomic release", async () => {
    const projectRoot = project()
    const outgoing = await claimProjectServing(projectRoot, "dev")
    const directory = ContainedDirectory.openExisting(projectRoot, [".flywheel"])!
    const gate = acquireLockSyncIn(directory, "project-execution.lock")
    const decision = outgoing.releaseForHandoff(() => true)
    const successor = claimProjectServing(projectRoot, "dev", 0)
    releaseLockIn(directory, gate)
    directory.close()
    expect(await decision).toBe(true)
    const claim = await successor
    expect(claim.exclusive).toBe(true)
    claim()
  })
  for (const lane of ["dev", "installed"] as const) {
    test(`the ${lane} lane refuses a headless execution holder`, async () => {
      const projectRoot = project()
      const flywheel = join(projectRoot, ".flywheel")
      mkdirSync(flywheel, { mode: 0o700 })
      const holder = join(flywheel, `project-execution.headless.lock.shared.${randomUUID()}`)
      writeFileSync(holder, JSON.stringify({ pid: process.pid, owner: "headless" }))
      await expect(claimProjectServing(projectRoot, lane)).rejects.toThrow(`is open in headless execution (pid ${process.pid})`)
      rmSync(holder)
      ;(await claimProjectServing(projectRoot, lane))()
    })
  }

  test("the other lane is refused while a live holder serves the project, and admitted once it releases", async () => {
    const projectRoot = project()
    const releaseDev = await claimProjectServing(projectRoot, "dev")
    await expect(claimProjectServing(projectRoot, "installed")).rejects.toThrow(`is open in the dev lane (pid ${process.pid})`)
    releaseDev()
    const releaseInstalled = await claimProjectServing(projectRoot, "installed")
    await expect(claimProjectServing(projectRoot, "dev")).rejects.toThrow(`is open in the installed lane (pid ${process.pid})`)
    releaseInstalled()
    expect(readdirSync(join(projectRoot, ".flywheel")).filter((name) => name.startsWith("project-serving"))).toEqual([])
  })

  test("a holder whose process is gone never blocks", async () => {
    const projectRoot = project()
    const flywheel = join(projectRoot, ".flywheel")
    mkdirSync(flywheel, { mode: 0o700 })
    writeFileSync(join(flywheel, `project-serving.dev.lock.shared.${randomUUID()}`), JSON.stringify({ pid: 2_147_483_000, owner: "stale" }))
    writeFileSync(join(flywheel, `project-serving.installed.lock.shared.${randomUUID()}`), JSON.stringify({ pid: 2_147_483_001, owner: "stale" }))
    ;(await claimProjectServing(projectRoot, "installed"))()
    expect(readdirSync(flywheel).filter((name) => name.startsWith("project-serving"))).toEqual([])
  })

  // The kernel gives a freed pid to the next process: a holder whose pid now
  // runs a process with another start stamp is gone, even when that process is
  // this one.
  test("a holder whose pid now runs another process never blocks the other lane", async () => {
    const projectRoot = project()
    const flywheel = join(projectRoot, ".flywheel")
    mkdirSync(flywheel, { mode: 0o700 })
    const { boot } = processHolders.own() ?? expect.unreachable("the kernel did not give this test process its identity")
    const recycled = { pid: process.pid, owner: "recycled", v: 1, start: "1", ...(boot === undefined ? {} : { boot }) }
    writeFileSync(join(flywheel, `project-serving.dev.lock.shared.${randomUUID()}`), JSON.stringify(recycled))
    ;(await claimProjectServing(projectRoot, "installed"))()
    expect(readdirSync(flywheel).filter((name) => name.startsWith("project-serving"))).toEqual([])
  })

  // A holder whose record cannot be read may still serve the project, so
  // it keeps the other lane out the way a live holder does.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a holder whose record cannot be read keeps the other lane out", async () => {
    const projectRoot = project()
    const flywheel = join(projectRoot, ".flywheel")
    mkdirSync(flywheel, { mode: 0o700 })
    const holder = join(flywheel, `project-serving.dev.lock.shared.${randomUUID()}`)
    writeFileSync(holder, JSON.stringify({ pid: process.ppid, owner: "hidden" }))
    chmodSync(holder, 0)
    await expect(claimProjectServing(projectRoot, "installed")).rejects.toThrow("is open in the dev lane (1 holder whose record cannot be read)")
    expect(existsSync(holder)).toBe(true)
  })

  test("this process may hold a project more than once", async () => {
    const projectRoot = project()
    const first = await claimProjectServing(projectRoot, "dev")
    const second = await claimProjectServing(projectRoot, "dev")
    first()
    second()
  })

  test("another live process of the same lane is waited out, so a project never has two owners", async () => {
    const projectRoot = project()
    const predecessor = holdAsAnotherProcess(projectRoot, "installed")
    let claimed = false
    const claim = claimProjectServing(projectRoot, "installed").then((release) => { claimed = true; return release })
    await Bun.sleep(20)
    expect(claimed).toBe(false)
    predecessor.release()
    const release = await claim
    expect(claimed).toBe(true)
    expect(release.exclusive).toBe(true)
    release()
  })

  test("a same-lane holder still alive past the wait bound no longer holds the project back", async () => {
    const projectRoot = project()
    const predecessor = holdAsAnotherProcess(projectRoot, "installed")
    const release = await claimProjectServing(projectRoot, "installed", 10)
    expect(release.exclusive).toBe(false)
    release()
    predecessor.release()
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable same-lane holder prevents exclusive acquisition and the outgoing skip", async () => {
    const projectRoot = project()
    const predecessor = holdAsAnotherProcess(projectRoot, "dev")
    chmodSync(predecessor.file, 0)
    const started = Date.now()
    const release = await claimProjectServing(projectRoot, "dev", 10)
    try {
      expect(release.exclusive).toBe(false)
      expect(Date.now() - started).toBeGreaterThanOrEqual(10)
      expect(await release.releaseForHandoff(() => true)).toBe(false)
      chmodSync(predecessor.file, 0o600)
      predecessor.release()
      expect(await release.releaseForHandoff(() => true)).toBe(true)
    } finally {
      if (existsSync(predecessor.file)) chmodSync(predecessor.file, 0o600)
      predecessor.release()
      release()
    }
  })
})

describe("exclusive headless project execution", () => {
  test("a second host in this process is refused until the first releases", async () => {
    const projectRoot = project()
    const first = await claimHeadlessProjectExecution(projectRoot)
    await expect(claimHeadlessProjectExecution(projectRoot)).rejects.toThrow(`is open in headless execution (pid ${process.pid})`)
    first()
    first()
    ;(await claimHeadlessProjectExecution(projectRoot))()
    expect(readdirSync(join(projectRoot, ".flywheel"))).toEqual([])
  })

  for (const lane of ["dev", "installed"] as const) {
    test(`headless execution refuses a live ${lane} holder until release`, async () => {
      const projectRoot = project()
      const serving = await claimProjectServing(projectRoot, lane)
      await expect(claimHeadlessProjectExecution(projectRoot)).rejects.toThrow(`is open in the ${lane} lane (pid ${process.pid})`)
      serving()
      ;(await claimHeadlessProjectExecution(projectRoot))()
    })
  }

  for (const owner of ["dev", "installed", "headless"] as const) {
    test(`headless execution sweeps a dead ${owner} owner`, async () => {
      const projectRoot = project()
      const holder = holdAsAnotherProcess(projectRoot, owner)
      writeFileSync(holder.file, JSON.stringify({ pid: 2_147_483_000, owner: "dead" }))
      ;(await claimHeadlessProjectExecution(projectRoot))()
      expect(existsSync(holder.file)).toBe(false)
    })

    test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(`an unreadable ${owner} holder blocks headless execution`, async () => {
      const projectRoot = project()
      const holder = holdAsAnotherProcess(projectRoot, owner)
      chmodSync(holder.file, 0)
      await expect(claimHeadlessProjectExecution(projectRoot)).rejects.toThrow("1 holder whose record cannot be read")
      if (owner === "headless") {
        for (const lane of ["dev", "installed"] as const) {
          await expect(claimProjectServing(projectRoot, lane)).rejects.toThrow("1 holder whose record cannot be read")
        }
      }
      expect(existsSync(holder.file)).toBe(true)
      chmodSync(holder.file, 0o600)
      holder.release()
      ;(await claimHeadlessProjectExecution(projectRoot))()
    })
  }

  test("a recycled headless pid does not block either execution kind", async () => {
    const projectRoot = project()
    const holder = holdAsAnotherProcess(projectRoot, "headless")
    const { boot } = processHolders.own() ?? expect.unreachable("the kernel did not give this test process its identity")
    const recycled = { pid: process.pid, owner: "recycled", v: 1, start: "1", ...(boot === undefined ? {} : { boot }) }
    writeFileSync(holder.file, JSON.stringify(recycled))
    ;(await claimProjectServing(projectRoot, "dev"))()
    expect(existsSync(holder.file)).toBe(false)
    writeFileSync(holder.file, JSON.stringify(recycled))
    ;(await claimHeadlessProjectExecution(projectRoot))()
    expect(existsSync(holder.file)).toBe(false)
  })

  for (const pair of [["headless", "headless"], ["headless", "dev"], ["installed", "headless"], ["dev", "installed"]] as const) {
    test(`simultaneous ${pair.join("/")} checks admit exactly one owner`, async () => {
      const projectRoot = project()
      const directory = ContainedDirectory.open(projectRoot, [".flywheel"], { privateDirectories: true })
      const mutex = acquireLockSyncIn(directory, "project-execution.lock")
      const claims = pair.map((owner) => owner === "headless" ? claimHeadlessProjectExecution(projectRoot) : claimProjectServing(projectRoot, owner))
      releaseLockIn(directory, mutex)
      directory.close()
      const results = await Promise.allSettled(claims)
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
      for (const result of results) {
        if (result.status === "fulfilled") result.value()
      }
      expect(readdirSync(join(projectRoot, ".flywheel"))).toEqual([])
    })
  }

  test("failed runtime assembly retains ownership until process death", async () => {
    const projectRoot = project()
    const runtimeModule = await import("../../../../src/orchestration/app-service/project-execution-runtime.js")
    const assembly = spyOn(runtimeModule, "assembleProjectRuntime").mockImplementation(async () => {
      await expect(claimHeadlessProjectExecution(projectRoot)).rejects.toThrow("is open in headless execution")
      throw new Error("assembly failed")
    })
    const { runHeadlessChat } = await import("../../../../src/orchestration/headless/run-headless-chat.js")
    const records: string[] = []
    try {
      const code = await runHeadlessChat({
        projectRoot, executionCwd: projectRoot, accountHome: projectRoot, userDataRoot: join(projectRoot, "account"),
        workerUrl: "unused",
        launcher: {
          spawnOwned: async () => { throw new Error("unused") },
          adoptOwned: async () => { throw new Error("unused") },
          open() { return this },
          close: async () => ({ settled: true as const }),
        },
        persistentProcesses: createPersistentProcessManager().client(),
        allowPersistentProcesses: false,
        input: [],
        write: async (line) => { records.push(line) },
      })
      expect(code).toBe(1)
      expect(assembly).toHaveBeenCalledTimes(1)
      expect(JSON.parse(records[0] ?? "")).toMatchObject({ type: "outcome", outcome: "failed" })
      await expect(claimHeadlessProjectExecution(projectRoot)).rejects.toThrow("is open in headless execution")
      await expect(claimProjectServing(projectRoot, "dev")).rejects.toThrow("is open in headless execution")
    } finally {
      assembly.mockRestore()
    }
  })
})
