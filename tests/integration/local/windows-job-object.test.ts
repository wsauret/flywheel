import { describe, expect, test } from "bun:test"
import { cpus } from "node:os"

import { windowsJobApi } from "../../../src/infra/windows-job-object.js"

/** These cases drive real job objects and real processes, which is why they sit
 *  in the integration tier rather than the unit one. Only Windows has them. */
const onWindows = process.platform === "win32"

/** A payload that outlives the case unless the container ends it, and that
 *  starts a grandchild of its own so membership is worth asking about. */
function spawnPayload() {
  const child = Bun.spawn({
    cmd: ["cmd.exe", "/c", "ping -n 60 127.0.0.1 >nul"],
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  })
  return { pid: child.pid, kill: () => { child.kill() } }
}

describe("windows job objects", () => {
  test.skipIf(!onWindows)("holds an admitted process and reports it by pid", () => {
    const api = windowsJobApi()
    const job = api?.create(`Flywheel.test.${crypto.randomUUID()}`)
    expect(job).toBeDefined()
    if (!job) return
    const payload = spawnPayload()
    try {
      expect(job.admit(payload.pid)).toBe(true)
      expect(job.pids()).toContain(payload.pid)
    } finally {
      payload.kill()
      job.terminate()
      job.close()
    }
  })

  // A project executor's supervisor lets its job's children leave once the
  // executor runs in the job. A child the member starts on its own is then
  // outside the job, and the member still ends when the last handle closes.
  test.skipIf(!onWindows)("lets the children a member starts leave a job that keeps its members", async () => {
    const job = windowsJobApi()?.create(`Flywheel.test.breakaway.${crypto.randomUUID()}`)
    expect(job).toBeDefined()
    if (!job) return
    const member = Bun.spawn({
      cmd: [process.execPath, "-e", [
        `await new Response(Bun.stdin.stream()).text()`,
        `const child = Bun.spawn(["ping", "-n", "60", "127.0.0.1"], { stdio: ["ignore", "ignore", "ignore"], detached: true, windowsHide: true })`,
        `console.log(child.pid)`,
        `await new Promise(() => {})`,
      ].join("\n")],
      stdin: "pipe",
      stdout: "pipe",
      windowsHide: true,
    })
    let child = Number.NaN
    try {
      expect(job.admit(member.pid)).toBe(true)
      expect(job.letChildrenLeave()).toBe(true)
      void member.stdin.end()
      const { value } = await member.stdout.getReader().read()
      child = Number(new TextDecoder().decode(value).trim())
      expect(job.pids()).toEqual([member.pid])
    } finally {
      job.close()
    }
    try {
      // The member waits forever, so only the closed job ends it.
      await member.exited
      // The child outlives the job that held its parent, because it was
      // never a member of it.
      expect(() => process.kill(child, 0)).not.toThrow()
    } finally {
      if (Number.isInteger(child)) process.kill(child)
    }
  })

  test.skipIf(!onWindows)("creates only jobs with below-normal priority policy", () => {
    const job = windowsJobApi()?.create(`Flywheel.test.priority.${crypto.randomUUID()}`, { priority: "background" })
    expect(job).toBeDefined()
    job?.close()
  })

  // A process ends only when its threads run. With every processor taken at
  // normal priority, a below-normal thread waits seconds for its turn, so an
  // ended background container would hold its owner's settlement that long.
  test.skipIf(!onWindows)("ends a background container's members promptly while normal-priority work holds every processor", async () => {
    const job = windowsJobApi()?.create(`Flywheel.test.priority-end.${crypto.randomUUID()}`, { priority: "background" })
    expect(job).toBeDefined()
    if (!job) return
    const burners = Array.from({ length: cpus().length }, () => Bun.spawn([process.execPath, "-e", "for(;;){}"], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true }))
    const members = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true }))
    try {
      for (const member of members) expect(job.admit(member.pid)).toBe(true)
      await Bun.sleep(1_000)

      const started = performance.now()
      job.terminate()
      await Promise.all(members.map((member) => member.exited))

      expect(performance.now() - started).toBeLessThan(500)
    } finally {
      for (const spawned of [...burners, ...members]) spawned.kill()
      job.close()
    }
  }, 30_000)

  test.skipIf(!onWindows)("refuses a second owner for a name already taken", () => {
    const api = windowsJobApi()
    const name = `Flywheel.test.${crypto.randomUUID()}`
    const first = api?.create(name)
    try {
      // Two owners of one container is the failure this prevents: the second
      // caller gets nothing rather than a handle to somebody else's processes.
      expect(first).toBeDefined()
      expect(api?.create(name)).toBeUndefined()
    } finally {
      first?.close()
    }
  })

  test.skipIf(!onWindows)("opens a container by name from a side that never created it", () => {
    const api = windowsJobApi()
    const name = `Flywheel.test.${crypto.randomUUID()}`
    const owner = api?.create(name)
    expect(owner).toBeDefined()
    if (!owner) return
    const payload = spawnPayload()
    try {
      expect(owner.admit(payload.pid)).toBe(true)
      // This is the guardian's position: it holds no handle and never saw the
      // launch, only the name.
      const observer = api?.open(name)
      expect(observer?.kind).toBe("opened")
      if (observer?.kind !== "opened") return
      expect(observer.job.pids()).toContain(payload.pid)
      observer.job.close()
    } finally {
      payload.kill()
      owner.terminate()
      owner.close()
    }
  })

  test.skipIf(!onWindows)("proves that no container holds a name nobody created", () => {
    // The kernel answers a missing name with ERROR_FILE_NOT_FOUND, the one
    // failure that proves an absence.
    expect(windowsJobApi()?.open(`Flywheel.test.absent.${crypto.randomUUID()}`)).toEqual({ kind: "not-found" })
  })

  test.skipIf(!onWindows)("ends every member from one call, the admitted process included", () => {
    const api = windowsJobApi()
    const job = api?.create(`Flywheel.test.${crypto.randomUUID()}`)
    expect(job).toBeDefined()
    if (!job) return
    const payload = spawnPayload()
    expect(job.admit(payload.pid)).toBe(true)
    expect(job.pids()).toContain(payload.pid)

    job.terminate()

    // The kill is the kernel's, so membership is empty without polling for a
    // process table to catch up.
    expect(job.pids()).toEqual([])
    job.close()
  })

  test.skipIf(!onWindows)("reports nothing once its handle is released", () => {
    const job = windowsJobApi()?.create(`Flywheel.test.${crypto.randomUUID()}`)
    expect(job?.pids()).toEqual([])

    job?.close()

    // A released handle can prove nothing, and nothing is never an absence.
    expect(job?.pids()).toBeUndefined()
    expect(job?.admit(process.pid)).toBe(false)
  })

  test.skipIf(!onWindows)("refuses to admit a pid no process holds", () => {
    const job = windowsJobApi()?.create(`Flywheel.test.${crypto.randomUUID()}`)
    try {
      expect(job?.admit(0x7ffffff0)).toBe(false)
    } finally {
      job?.close()
    }
  })

  test.skipIf(onWindows)("is absent on platforms whose containers are process groups", () => {
    expect(windowsJobApi()).toBeUndefined()
  })
})
