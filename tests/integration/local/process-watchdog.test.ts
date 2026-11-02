import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { watchContainerTerminations } from "../../../src/infra/process-container.js"
import { createProcessDiagnosticReader } from "../../../src/infra/process-diagnostic-reader.js"
import { lingerAfter } from "../../helpers/process-linger.js"

const moduleUrl = new URL("../../../src/infra/process-watchdog.ts", import.meta.url).href
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-process-watchdog-"))

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe("process watchdog", () => {
  test("SIGKILLs the process when the application event loop is permanently wedged", async () => {
    const source = [
      `import { createProcessWatchdog } from ${JSON.stringify(moduleUrl)}`,
      "const watchdog = createProcessWatchdog({ hardExitMs: 50 })",
      "watchdog.arm()",
      "while (true) {}",
    ].join(";")
    const child = Bun.spawn([process.execPath, "-e", source], {
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    })
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(2_000).then(() => null),
    ])
    if (exitCode === null) child.kill(9)

    expect(exitCode).not.toBeNull()
    expect(exitCode).not.toBe(0)
  }, 3_000)

  test("records its termination decision for the container's owner before the hard-exit kill", async () => {
    // The child names this process as the leader of its container, as a
    // project executor names its command supervisor.
    const source = [
      `import { createProcessWatchdog } from ${JSON.stringify(moduleUrl)}`,
      "const watchdog = createProcessWatchdog({ parentPid: 0, containerPid: process.ppid, hardExitMs: 300 })",
      `watchdog.arm("account stop")`,
      "while (true) {}",
    ].join(";")
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "ignore", stderr: "pipe", windowsHide: true })
    const exitCode = await Promise.race([child.exited, Bun.sleep(2_000).then(() => null)])
    if (exitCode === null) child.kill(9)
    const terminations = watchContainerTerminations(process.pid)
    try {
      const read = createProcessDiagnosticReader((_line, record) => { if (record) terminations.read(record.payload) })
      read(`${await new Response(child.stderr).text()}\n`)

      expect(exitCode).not.toBeNull()
      expect(exitCode).not.toBe(0)
      expect(terminations.last()).toMatchObject({
        senderPid: child.pid, container: process.pid, target: child.pid, signal: "SIGKILL",
        reason: "shutdown bound expired", evidence: { boundMs: 300, armedBy: "account stop" },
      })
    } finally {
      terminations.dispose()
    }
  }, 3_000)

  test("disposing an armed watchdog cancels its hard-exit clock", async () => {
    const sentinel = path.join(TMP, "armed-dispose")
    const source = [
      `import { createProcessWatchdog } from ${JSON.stringify(moduleUrl)}`,
      `import { writeFileSync } from "node:fs"`,
      "const watchdog = createProcessWatchdog({ hardExitMs: 200 })",
      "watchdog.arm()",
      "await Bun.sleep(50)",
      "await watchdog.dispose()",
      "await Bun.sleep(300)",
      `writeFileSync(${JSON.stringify(sentinel)}, "alive")`,
    ].join(";")
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "ignore", stderr: "pipe", windowsHide: true })

    expect(await child.exited).toBe(0)
    expect(fs.readFileSync(sentinel, "utf8")).toBe("alive")
  }, 3_000)

  test("disposing an unarmed watchdog joins its idle hard-exit clock", async () => {
    const sentinel = path.join(TMP, "unarmed-dispose")
    const source = [
      `import { createProcessWatchdog } from ${JSON.stringify(moduleUrl)}`,
      `import { writeFileSync } from "node:fs"`,
      "const watchdog = createProcessWatchdog({ hardExitMs: 200 })",
      "await watchdog.dispose()",
      `writeFileSync(${JSON.stringify(sentinel)}, "disposed")`,
    ].join(";")
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "ignore", stderr: "pipe", windowsHide: true })

    expect(await child.exited).toBe(0)
    expect(fs.readFileSync(sentinel, "utf8")).toBe("disposed")
  }, 3_000)

  // A project executor and the account service dispose their watchdog last
  // and then end by returning, so a dispose that leaves its 500 ms
  // acknowledgement bound armed makes every stop of either that much longer.
  test("disposing holds its process open no longer than the dispose", async () => {
    const setup = [
      `import { createProcessWatchdog } from ${JSON.stringify(moduleUrl)}`,
      "const watchdog = createProcessWatchdog({ parentPid: 0, hardExitMs: 30_000 })",
    ].join("\n")

    const { lingerMs } = await lingerAfter(setup, "watchdog.dispose()")

    expect(lingerMs).toBeLessThan(250)
  }, 3_000)

  test("parent death notifies the main thread so a healthy process exits gracefully", async () => {
    const sentinel = path.join(TMP, "graceful-exit")
    const childSource = [
      `import { createProcessWatchdog } from ${JSON.stringify(moduleUrl)}`,
      `import { writeFileSync } from "node:fs"`,
      "createProcessWatchdog({",
      `  onParentDeath: () => { writeFileSync(${JSON.stringify(sentinel)}, "graceful"); process.exit(0) },`,
      "  hardExitMs: 30_000,",
      "})",
      "setInterval(() => {}, 1_000)",
    ].join("\n")
    // Detached, because the scenario is a process that outlives its parent and
    // only a detached child can be one on Windows: an ordinary child there is
    // put in the parent's job object and the kernel ends it with the parent, so
    // the watchdog would have nothing left to notice.
    const parentSource = [
      `Bun.spawn([${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(childSource)}], { stdout: "ignore", stderr: "ignore", detached: true, windowsHide: true })`,
      "await Bun.sleep(300)",
      "process.exit(0)",
    ].join("\n")
    const parent = Bun.spawn([process.execPath, "-e", parentSource], { stdout: "ignore", stderr: "ignore", windowsHide: true })
    await parent.exited

    // The parent-liveness poll runs every 2s, so this waits for the graceful
    // path to happen at all rather than for it to happen within some number of
    // polls: three of them was a latency budget this case never meant to state,
    // and a machine running the whole tier misses one. The 30s hard-exit
    // deadline is the bound that matters, and this stays under it.
    const deadline = Date.now() + 20_000
    while (!fs.existsSync(sentinel)) {
      if (Date.now() > deadline) throw new Error("graceful parent-death exit never ran")
      await Bun.sleep(100)
    }
    expect(fs.readFileSync(sentinel, "utf8")).toBe("graceful")
  }, 30_000)
})