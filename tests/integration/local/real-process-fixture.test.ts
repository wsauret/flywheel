import { afterEach, describe, expect, test } from "bun:test"

import * as fs from "node:fs"
import * as path from "node:path"

import {
  createRealProcessFixture,
  harnessProcesses,
  identifyProcess,
  killIdentifiedProcess,
  processAlive,
  stopHarnessProcesses,
  type RealProcessFixture,
} from "../../helpers/real-process-fixture.js"

/** Cleanup must be independent of the code under test and safe against pid
 *  reuse: the operating system hands a number that a finished process had to an
 *  unrelated later one, and a test that signals a bare number can kill it. Every
 *  signal here is therefore preceded by a fresh identity check. */

const fixtures: RealProcessFixture[] = []

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

/** A real process that outlives the test unless something kills it, tagged with
 *  the fixture directory so the fixture's own sweep can find it. */
function liveProcess(scratch: RealProcessFixture): number {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 30_000)"], {
    cwd: scratch.dir,
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  child.unref()
  return child.pid
}

describe("real process fixture identity", () => {
  test("identifies a live process by pid, group and creation time", () => {
    const scratch = fixture("identity")
    const pid = scratch.guard(liveProcess(scratch))

    const identity = identifyProcess(pid)

    expect(identity?.pid).toBe(pid)
    expect(identity?.identity).toContain(String(pid))
    expect(identifyProcess(0x7fffffff)).toBeUndefined()
  })

  test("refuses to signal a pid whose recorded identity no longer holds it", async () => {
    const scratch = fixture("recycled")
    const pid = scratch.guard(liveProcess(scratch))
    const identity = identifyProcess(pid)
    if (!identity) throw new Error("the process under test was not identifiable")

    killIdentifiedProcess({ ...identity, identity: "a process this pid never was" })
    await Bun.sleep(50)

    expect(processAlive(pid)).toBe(true)
  })

  test("signals the pid it recorded once the identity still matches", async () => {
    const scratch = fixture("matched")
    const pid = scratch.guard(liveProcess(scratch))
    const identity = identifyProcess(pid)
    if (!identity) throw new Error("the process under test was not identifiable")

    killIdentifiedProcess(identity)

    await scratch.waitForGone(pid)
    expect(processAlive(pid)).toBe(false)
  })
})

describe("harness process sweep", () => {
  const MARKER = { FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1" }

  function sleeper(scratch: RealProcessFixture, options: { readonly env?: { readonly [name: string]: string }; readonly args?: readonly string[] }): number {
    // The runner may itself run under a harness; a process the test means to
    // leave unmarked must not inherit its marker.
    const { FLYWHEEL_INTERNAL_RELEASE_HARNESS: _inherited, ...environment } = process.env
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 30_000)", ...(options.args ?? [])], {
      cwd: scratch.dir,
      env: { ...environment, ...options.env },
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    child.unref()
    return scratch.guard(child.pid)
  }

  async function eventually(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error("the process table never showed the expected processes")
      await Bun.sleep(25)
    }
  }

  test("finds a harness process by its marker and its run root after the run directory is gone, and nothing else", async () => {
    const scratch = fixture("harness-sweep")
    const root = path.join(scratch.dir, "run-gone")
    fs.mkdirSync(root)
    // A service a harness run started: the run root is only in its home.
    const service = sleeper(scratch, { env: { ...MARKER, HOME: path.join(root, "candidate-home") } })
    // A gate process found by the binary it runs from under the root.
    const installed = sleeper(scratch, { env: MARKER, args: [path.join(root, "candidate", "flywheel")] })
    // Another run's service, siblings that only share a string prefix, and a
    // process without the marker that names the root in its command line, as
    // a user's own service never carries it.
    const otherRun = sleeper(scratch, { env: { ...MARKER, HOME: path.join(scratch.dir, "run-other", "candidate-home") } })
    const prefixSibling = sleeper(scratch, { env: { ...MARKER, HOME: `${root}3.ps1` }, args: [`${root}3.ps1`] })
    const spaceSibling = sleeper(scratch, { env: { ...MARKER, HOME: `${root} other` }, args: [path.join(`${root} other`, "c.ts")] })
    const unmarked = sleeper(scratch, { args: [path.join(root, "b.ts")] })
    // Another run's gate removed the run directory.
    fs.rmSync(root, { recursive: true, force: true })

    await eventually(() => harnessProcesses(root).length >= 2)

    expect(harnessProcesses(root).map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([service, installed].sort((a, b) => a - b))

    expect(stopHarnessProcesses([root], 5_000)).toEqual([])
    await scratch.waitForGone(service)
    await scratch.waitForGone(installed)
    for (const survivor of [otherRun, prefixSibling, spaceSibling, unmarked]) expect(processAlive(survivor)).toBe(true)
  })
})
