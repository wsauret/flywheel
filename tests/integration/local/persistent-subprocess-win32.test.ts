import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { windowsProcessIdentity } from "../../../src/infra/process-container.js"
import { launchPersistentSubprocess, type PersistentSubprocess } from "../../../src/infra/persistent-subprocess.js"
import { createRealProcessFixture } from "../../helpers/real-process-fixture.js"

const TARGET = fileURLToPath(new URL("../../fixtures/persistent-process-target.ts", import.meta.url))

test.skipIf(process.platform !== "win32")("stops a persistent Windows tree without accepting a root-only settlement", async () => {
  const fixture = createRealProcessFixture("persistent-win32")
  const directory = fixture.dir
  let persistent: PersistentSubprocess | undefined

  let ticks = 0
  const ticker = setInterval(() => { ticks += 1 }, 1)
  try {
    persistent = await launchPersistentSubprocess([process.execPath, TARGET, "payload", directory, String(process.pid)])
    const rootPid = fixture.guard(persistent.pid)
    expect(ticks).toBeGreaterThan(0)
    const descendantPid = fixture.guard(await waitForPid(join(directory, "descendant.pid")))
    const ticksBeforeStop = ticks
    const settlement = await persistent.stop()
    // The event loop kept turning across the stop, so nothing here blocked it.
    expect(ticks).toBeGreaterThan(ticksBeforeStop)
    // Both words are truthful, and which one arrives is a matter of timing:
    // "terminated" is a container proved empty, and "unsettled" is one this side
    // could not prove empty, which is what a descendant still holding it looks
    // like. Asserting the word made this case a race on that timing. The
    // invariant it exists for is narrower and always checkable: a settlement is
    // never claimed on the root alone, so a claim of termination is held against
    // the descendant at the moment the claim was made.
    if (settlement === "terminated") expect(windowsProcessIdentity(descendantPid).kind).toBe("absent")
    await waitForGone(rootPid)
    await waitForGone(descendantPid)
    expect(windowsProcessIdentity(rootPid).kind).toBe("absent")
    expect(windowsProcessIdentity(descendantPid).kind).toBe("absent")
  } finally {
    clearInterval(ticker)
    try {
      fixture.cleanup()
    } finally {
      if (persistent) {
        await persistent.exited
        persistent.release()
        expect(existsSync(persistent.spool.directory)).toBe(false)
      }
    }
  }
  // Longer than the two ten-second waits above allow, so a real hang fails with
  // the diagnostic this case wrote rather than being cut short by the default
  // five-second bound while a sibling file is launching processes of its own.
}, 30_000)

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const pid = Number(readFileSync(path, "utf8").trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch {
      // The target writes its marker after the process has started.
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await Bun.sleep(10)
  }
}

async function waitForGone(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (windowsProcessIdentity(pid).kind === "absent") return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for process ${pid}`)
    await Bun.sleep(10)
  }
}
