import { afterAll, afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { FFIType } from "bun:ffi"

import { readOutcomeRecord, type OutcomeRecordRead } from "../../../src/infra/command-handover.js"
import { bindLibc } from "../../../src/infra/libc.js"
import { accountServeDir } from "../../../src/infra/paths.js"
import { createLauncherScope, createProcessSupervisor, type ProcessSupervisor } from "../../../src/infra/process-supervisor.js"
import { createRealProcessFixture, processAlive, type RealProcessFixture } from "../../helpers/real-process-fixture.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

const SUPERVISOR_MODULE = new URL("../../../src/infra/process-supervisor.ts", import.meta.url).href
const HANDOVER_MODULE = new URL("../../../src/infra/command-handover.ts", import.meta.url).href
const GUARDIAN_MODULE = fileURLToPath(new URL("../../../src/infra/process-guardian.ts", import.meta.url))

/** The account whose service directory holds each handed-over command's
 *  channel. A Unix socket path is bounded (104 bytes on macOS), and the
 *  temporary directory a test process is given is too deep for one, so the
 *  account lives in a short directory of its own. Windows names a pipe, which
 *  has no such bound. */
const ACCOUNT = fs.realpathSync(fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-handover-")))
const USER_DATA_ROOT = path.join(ACCOUNT, ".flywheel")
fs.mkdirSync(accountServeDir(USER_DATA_ROOT, "dev"), { recursive: true, mode: 0o700 })
afterAll(() => { fs.rmSync(ACCOUNT, { recursive: true, force: true }) })

/** Every step here is bounded, so a stalled step fails instead of waiting. */
const STEP_MS = 10_000

const fixtures: RealProcessFixture[] = []
afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

/** What owner A leaves behind for owner B: the command as a later owner names
 *  it, and A's own guardian. */
interface HandedOver {
  readonly token: string
  readonly pid: number
  readonly channel: string
  readonly recordPath: string
  readonly guardianPid: number
}

/** Owner A in a process of its own: it launches `payload` for handover, hands
 *  it over, writes what B needs, disposes its supervisor, and ends. The
 *  fixture directory is an argument its guardian ignores, so every process of
 *  this owner carries the fixture's tag. */
async function handOverFromAnotherProcess(scratch: RealProcessFixture, payload: readonly string[]): Promise<HandedOver> {
  const recordPath = scratch.file("command.outcome.json")
  const report = scratch.file("handed-over.json")
  const source = [
    `import { createProcessSupervisor } from ${JSON.stringify(SUPERVISOR_MODULE)}`,
    `import { handoverChannelAddress } from ${JSON.stringify(HANDOVER_MODULE)}`,
    `const supervisor = createProcessSupervisor({ guardianCommand: [${JSON.stringify(process.execPath)}, ${JSON.stringify(GUARDIAN_MODULE)}, ${JSON.stringify(scratch.dir)}] })`,
    `const owned = await supervisor.spawnOwned(${JSON.stringify(payload)}, { handover: true })`,
    `const channel = handoverChannelAddress({ userDataRoot: ${JSON.stringify(USER_DATA_ROOT)}, lane: "dev", token: owned.token })`,
    `const answer = await owned.handOver({ channel, recordPath: ${JSON.stringify(recordPath)}, userDataRoot: ${JSON.stringify(USER_DATA_ROOT)} })`,
    `if (answer.kind !== "handed_over") throw new Error("handover answered " + answer.kind)`,
    `const guardianPid = await supervisor.guardian.pid()`,
    `await supervisor.dispose()`,
    `await Bun.write(${JSON.stringify(report)}, JSON.stringify({ token: owned.token, pid: owned.pid, channel, recordPath: ${JSON.stringify(recordPath)}, guardianPid }))`,
  ].join("\n")
  const owner = Bun.spawn([process.execPath, "-e", source], { stdout: "ignore", stderr: "pipe", windowsHide: true })
  scratch.guard(owner.pid)
  // A must end on its own: a launcher that kept waiting for a command it
  // handed over would hold the old build's executor alive.
  const ended = await Promise.race([owner.exited, Bun.sleep(STEP_MS).then(() => "still running" as const)])
  if (ended !== 0) throw new Error(`owner A did not end cleanly (${String(ended)}): ${await new Response(owner.stderr).text()}`)
  const handedOver: HandedOver = JSON.parse(await scratch.waitForFile(report))
  scratch.guard(handedOver.pid)
  return handedOver
}

function ownerB(scratch: RealProcessFixture): ProcessSupervisor {
  return createProcessSupervisor({ guardianCommand: [process.execPath, GUARDIAN_MODULE, scratch.dir] })
}

const libc = bindLibc({ getsid: { args: [FFIType.i32], returns: FFIType.i32 } })

describe.skipIf(process.platform === "win32")("a handed-over command", () => {
  test("outlives its first owner, its guardian and its process, and a second owner adopts, stops, and reads it", async () => {
    const scratch = fixture("handover-adopt")
    const handedOver = await handOverFromAnotherProcess(scratch, ["/bin/sh", "-c", `sleep 60; echo ${scratch.dir}`])
    const b = ownerB(scratch)
    const scope = createLauncherScope(b)

    try {
      await scratch.waitForGone(handedOver.guardianPid, STEP_MS)
      expect(processAlive(handedOver.pid)).toBe(true)
      // The supervisor leads its own session, so nothing that ends its first
      // owner's session reaches it.
      expect(libc?.getsid(handedOver.pid)).toBe(handedOver.pid)
      // The record names the supervisor's own group, as a later owner reads it.
      expect(readOutcomeRecord(handedOver.recordPath)).toEqual({ kind: "record", record: { version: 1, handedOverAtMs: expect.any(Number), supervisorIdentity: expect.stringMatching(new RegExp(`^${handedOver.pid} ${handedOver.pid} `)) } })

      const answer = await scope.adoptOwned(adoptable(handedOver))
      if (answer.kind !== "adopted") throw new Error(`expected an adoption, got ${answer.kind}`)
      const exit = await Promise.race([answer.owned.terminate(), Bun.sleep(STEP_MS).then(() => undefined)])

      expect(exit).toEqual({ code: null, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" })
      const recorded: OutcomeRecordRead = readOutcomeRecord(handedOver.recordPath)
      expect(recorded).toMatchObject({ kind: "record", record: { outcome: { code: exit?.code ?? null, signal: exit?.signal ?? null, deadlineExpired: false } } })
      await scratch.waitForGone(handedOver.pid, STEP_MS)
    } finally {
      await scope.close()
      await b.dispose()
    }
  }, 40_000)

  test("keeps a command that ends on the end of its stdin running after its first owner ends", async () => {
    const scratch = fixture("handover-stdin")
    const ended = scratch.file("ended")
    const handedOver = await handOverFromAnotherProcess(scratch, ["/bin/sh", "-c", `cat >/dev/null; echo ended > ${ended}`])
    const b = ownerB(scratch)
    const scope = createLauncherScope(b)

    try {
      await scratch.waitForGone(handedOver.guardianPid, STEP_MS)
      await Bun.sleep(300)

      expect(fs.existsSync(ended)).toBe(false)
      expect(processAlive(handedOver.pid)).toBe(true)

      const answer = await scope.adoptOwned(adoptable(handedOver))
      if (answer.kind !== "adopted") throw new Error(`expected an adoption, got ${answer.kind}`)
      await answer.owned.terminate()
    } finally {
      await scope.close()
      await b.dispose()
    }
  }, 40_000)

  test("answers ended with the recorded exit code when the command ended before the second owner came", async () => {
    const scratch = fixture("handover-ended")
    const go = scratch.file("go")
    const handedOver = await handOverFromAnotherProcess(scratch, ["/bin/sh", "-c", `while [ ! -f ${go} ]; do sleep 0.05; done; exit 7`])
    const b = ownerB(scratch)

    try {
      fs.writeFileSync(go, "")
      await scratch.waitForGone(handedOver.pid, STEP_MS)

      const answer = await b.adoptOwned(adoptable(handedOver))

      expect(answer).toMatchObject({ kind: "ended", record: { kind: "record", record: { outcome: { code: 7, signal: null, deadlineExpired: false } } } })
    } finally {
      await b.dispose()
    }
  }, 40_000)

  test("ends what a supervisor killed while it held the command left running before the second owner answers ended", async () => {
    const scratch = fixture("handover-orphan")
    const handedOver = await handOverFromAnotherProcess(scratch, ["/bin/sh", "-c", `sleep 60; echo ${scratch.dir}`])
    const b = ownerB(scratch)

    try {
      await scratch.waitForGone(handedOver.guardianPid, STEP_MS)
      // The supervisor alone dies, as to the out-of-memory killer; its
      // payload runs on in the group the supervisor led.
      process.kill(handedOver.pid, "SIGKILL")
      await scratch.waitForGone(handedOver.pid, STEP_MS)
      expect(groupRuns(handedOver.pid)).toBe(true)

      const answer = await b.adoptOwned(adoptable(handedOver))

      expect(answer).toMatchObject({ kind: "ended", record: { kind: "record", record: { version: 1 } } })
      expect(answer.kind === "ended" && answer.record.kind === "record" ? answer.record.record.outcome : "no record").toBeUndefined()
      expect(groupRuns(handedOver.pid)).toBe(false)
    } finally {
      await b.dispose()
    }
  }, 40_000)
})

/** What owner B needs to adopt the command A handed over: A's report, and
 *  the account that the handover word to give it back names. */
function adoptable(handedOver: HandedOver) {
  return { token: handedOver.token, pid: handedOver.pid, channel: handedOver.channel, recordPath: handedOver.recordPath, userDataRoot: USER_DATA_ROOT }
}

/** Whether process group `pgid` still holds a process. */
function groupRuns(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

// Probe P2's part that a test can hold: until this runs on a Windows host,
// the Windows handover is proven only by the unit tests on fakes.
describe.skipIf(process.platform !== "win32")("a handed-over command on Windows", () => {
  test("outlives the process that launched it, and a second owner adopts and stops it", async () => {
    const scratch = fixture("handover-windows")
    const handedOver = await handOverFromAnotherProcess(scratch, ["cmd.exe", "/c", "ping -n 60 127.0.0.1 >nul"])
    const b = ownerB(scratch)
    const scope = createLauncherScope(b)

    try {
      await scratch.waitForGone(handedOver.guardianPid, STEP_MS)
      // The first owner and its guardian are gone; the supervisor and its job,
      // which it holds open, carry the command.
      expect(processAlive(handedOver.pid)).toBe(true)

      const answer = await scope.adoptOwned(adoptable(handedOver))
      if (answer.kind !== "adopted") throw new Error(`expected an adoption, got ${answer.kind}`)
      await Promise.race([answer.owned.terminate(), Bun.sleep(STEP_MS)])
      await scratch.waitForGone(handedOver.pid, STEP_MS)
    } finally {
      await scope.close()
      await b.dispose()
    }
  }, 40_000)
})
