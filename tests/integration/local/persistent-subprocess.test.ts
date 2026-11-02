import { afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { existsSync, mkdirSync, rmSync } from "node:fs"

import { sweepPersistentSpools, type PersistentSpool } from "../../../src/infra/persistent-spool.js"
import { launchPersistentSubprocess } from "../../../src/infra/persistent-subprocess.js"
import { lingerAfter, sourceModule } from "../../helpers/process-linger.js"
import { createRealProcessFixture, processAlive, type RealProcessFixture } from "../../helpers/real-process-fixture.js"

const TARGET = fileURLToPath(new URL("../../fixtures/persistent-process-target.ts", import.meta.url))
const fixtures: RealProcessFixture[] = []
const retainedSpools = new Set<string>()

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
  for (const directory of retainedSpools) rmSync(directory, { recursive: true, force: true })
  retainedSpools.clear()
})

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

/** The fixture's argv for one mode. The owner is the process whose exit ends
 *  everything the fixture starts; it is this test process unless a test names
 *  another. */
function target(mode: string, scratch: RealProcessFixture, owner = process.pid): string[] {
  return [process.execPath, TARGET, mode, scratch.dir, String(owner)]
}

async function pidFrom(scratch: RealProcessFixture, name: string): Promise<number> {
  return scratch.guard(Number((await scratch.waitForFile(scratch.file(name), 10_000)).trim()))
}

function retain(spool: PersistentSpool): void {
  retainedSpools.add(spool.directory)
}

interface ParsedLaunch {
  readonly pid: number
  readonly spool: PersistentSpool
}

/** What a launcher mode launched, with every process the fixture wrote
 *  guarded: the supervisor (the payload itself on Windows) and the payload's
 *  descendant. */
async function launchedBy(scratch: RealProcessFixture): Promise<ParsedLaunch & { readonly descendantPid: number }> {
  const launch = parseLaunch(await scratch.waitForFile(scratch.file("launch.json"), 10_000))
  retain(launch.spool)
  return { pid: scratch.guard(launch.pid), spool: launch.spool, descendantPid: await pidFrom(scratch, "descendant.pid") }
}

function parseLaunch(contents: string): ParsedLaunch {
  const value: unknown = JSON.parse(contents)
  if (typeof value !== "object" || value === null || !("pid" in value) || !("spool" in value)) throw new Error("launcher metadata is invalid")
  const spool = value.spool
  if (typeof value.pid !== "number" || typeof spool !== "object" || spool === null
    || !("directory" in spool) || typeof spool.directory !== "string"
    || !("stdoutPath" in spool) || typeof spool.stdoutPath !== "string"
    || !("stderrPath" in spool) || typeof spool.stderrPath !== "string") throw new Error("launcher metadata is invalid")
  return { pid: value.pid, spool: { directory: spool.directory, stdoutPath: spool.stdoutPath, stderrPath: spool.stderrPath } }
}

async function waitForExit(child: ReturnType<typeof Bun.spawn>, timeoutMs = 5_000): Promise<number> {
  return Promise.race([
    child.exited,
    Bun.sleep(timeoutMs).then(() => { throw new Error(`launcher did not exit within ${timeoutMs}ms`) }),
  ])
}

describe("persistent subprocess host contract", () => {
  test.skipIf(process.platform === "win32")("reports an immediate payload exit through supervisor settlement", async () => {
    const scratch = fixture("persistent-immediate")
    const child = await launchPersistentSubprocess(target("immediate", scratch))
    retain(child.spool)
    scratch.guard(child.pid)

    expect(await child.exited).toBe(23)
    await scratch.waitForGone(child.pid)
    expect(scratch.tagged()).toEqual([])
  })

  test("spools ongoing output, bounds live reads, and stops the full process session", async () => {
    const scratch = fixture("persistent-live")
    const child = await launchPersistentSubprocess(target("payload", scratch))
    retain(child.spool)
    const pid = scratch.guard(child.pid)
    const descendantPid = await pidFrom(scratch, "descendant.pid")

    const firstStdout = await scratch.waitForFileContaining(child.spool.stdoutPath, "stdout-")
    const firstStderr = await scratch.waitForFileContaining(child.spool.stderrPath, "stderr-")
    expect(firstStdout).toContain("stdout-")
    expect(firstStderr).toContain("stderr-")

    const bounded = child.read("stdout", 0, 7)
    expect(bounded.data.byteLength).toBe(7)
    expect(bounded.nextOffset).toBe(7)
    const later = await scratch.waitForFileContaining(child.spool.stdoutPath, "stdout-")
    await Bun.sleep(60)
    expect((await Bun.file(child.spool.stdoutPath).text()).length).toBeGreaterThan(later.length)

    await child.stop()
    await scratch.waitForGone(pid, 10_000)
    await scratch.waitForGone(descendantPid, 10_000)
    expect(scratch.tagged()).toEqual([])
  }, 20_000)

  // The account service and the commands that launch it end by returning, so
  // a stop that leaves its grace timer armed holds them open for about 5 s.
  test("a stop holds its launcher's process open no longer than the stop", async () => {
    const scratch = fixture("persistent-stop-linger")
    const setup = [
      `import { launchPersistentSubprocess } from ${JSON.stringify(sourceModule("infra/persistent-subprocess.ts"))}`,
      // The launcher is the payload's owner, so nothing the launch starts outlives it.
      `const child = await launchPersistentSubprocess([process.execPath, ${JSON.stringify(TARGET)}, "payload", ${JSON.stringify(scratch.dir)}, String(process.pid)])`,
    ].join("\n")

    const { answer, lingerMs } = await lingerAfter(setup, "child.stop().finally(() => { child.release() })")

    expect(answer).toBe("terminated")
    expect(lingerMs).toBeLessThan(2_000)
  }, 20_000)

  test("released process survives normal launcher exit without retaining its event loop", async () => {
    const scratch = fixture("persistent-release")
    const launcher = Bun.spawn(target("launch-exit", scratch), { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true })
    const { pid, spool } = await launchedBy(scratch)

    expect(await waitForExit(launcher)).toBe(0)
    expect(processAlive(pid)).toBe(true)
    expect(await scratch.waitForFileContaining(spool.stdoutPath, "stdout-")).toContain("stdout-")
  }, 20_000)

  // A launcher that shuts down on a signal is a POSIX launcher. Windows
  // delivers no SIGTERM: the kill terminates the process outright, so the
  // graceful path this case is about never runs there. What Windows does state
  // is the case above, where the launcher exits on its own terms.
  test.skipIf(process.platform === "win32")("released process survives graceful SIGTERM of its launcher", async () => {
    const scratch = fixture("persistent-sigterm")
    const launcher = Bun.spawn(target("launch-sigterm", scratch), { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true })
    const { pid, spool } = await launchedBy(scratch)
    await scratch.waitForFile(scratch.file("launcher-ready"), 10_000)

    launcher.kill("SIGTERM")
    expect(await waitForExit(launcher)).toBe(0)
    expect(processAlive(pid)).toBe(true)
    expect(await scratch.waitForFileContaining(spool.stderrPath, "stderr-")).toContain("stderr-")
  }, 20_000)

  test.skipIf(process.platform === "win32")("released process survives SIGKILL of its launcher", async () => {
    const scratch = fixture("persistent-sigkill")
    const launcher = Bun.spawn(target("launch-sigkill", scratch), { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true })
    const { pid, spool } = await launchedBy(scratch)
    await scratch.waitForFile(scratch.file("launcher-ready"), 10_000)

    launcher.kill("SIGKILL")
    await waitForExit(launcher)
    expect(processAlive(pid)).toBe(true)
    expect(await scratch.waitForFileContaining(spool.stdoutPath, "stdout-")).toContain("stdout-")
  }, 20_000)

  test("a released spool is removed once its writer exits, by the launcher that sees the exit", async () => {
    const scratch = fixture("persistent-spool-exit")
    const child = await launchPersistentSubprocess(target("immediate", scratch))
    retain(child.spool)
    scratch.guard(child.pid)
    child.release()

    await child.exited
    await Bun.sleep(0)
    expect(existsSync(child.spool.directory)).toBe(false)
  })

  test.skipIf(process.platform === "win32")("a spool whose launcher was killed stays while its writer runs, and a sweep removes it once the writer is gone", async () => {
    const scratch = fixture("persistent-spool-sweep")
    const temporary = scratch.file("tmp")
    mkdirSync(temporary)
    const launcher = Bun.spawn(target("launch-sigkill", scratch), {
      env: { ...process.env, TMPDIR: temporary },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    })
    const { pid, spool, descendantPid } = await launchedBy(scratch)
    await scratch.waitForFile(scratch.file("launcher-ready"), 10_000)
    launcher.kill("SIGKILL")
    await waitForExit(launcher)

    await sweepPersistentSpools({ temporary })
    expect(existsSync(spool.directory)).toBe(true)

    // The supervisor leads the group its payload and the payload's child run in.
    process.kill(-pid, "SIGKILL")
    await scratch.waitForGone(pid, 10_000)
    await scratch.waitForGone(descendantPid, 10_000)
    await sweepPersistentSpools({ temporary })
    expect(existsSync(spool.directory)).toBe(false)
  }, 20_000)

  // A released payload has nobody to end it, so a test runner killed before
  // its cleanup runs would leave the payload and its descendant writing
  // forever. The fixture ends everything it starts with its owner. Every
  // other case here names this test process, which is why they cannot show
  // the owner's exit; a stand-in owner can.
  test("the fixture's payload and its descendant end once their owner is gone", async () => {
    const scratch = fixture("persistent-owner")
    const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true })
    scratch.guard(owner.pid)
    const child = await launchPersistentSubprocess(target("payload", scratch, owner.pid))
    retain(child.spool)
    scratch.guard(child.pid)
    const payloadPid = await pidFrom(scratch, "payload.pid")
    const descendantPid = await pidFrom(scratch, "descendant.pid")

    owner.kill()
    await owner.exited
    await Promise.all([scratch.waitForGone(payloadPid, 5_000), scratch.waitForGone(descendantPid, 5_000)])
    expect(await child.exited).toBe(0)
    expect(scratch.tagged()).toEqual([])
  }, 20_000)
})
