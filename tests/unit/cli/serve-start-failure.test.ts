import { describe, expect, jest, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { createFatalExit, fatalExitCode } from "../../../src/cli/fatal-exit.js"
import { runServe } from "../../../src/cli/serve.js"
import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { Log } from "../../../src/infra/log.js"
import { accountServeSocketPath, accountServeStartLockPath, accountServeStartRecordPath } from "../../../src/infra/paths.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { ServeLifetime } from "../../../src/orchestration/app-service/serve-lifetime.js"
import { confirmServiceStart } from "../../../src/orchestration/update/service-start.js"
import { ServeStartupFailure } from "../../../src/protocol/serve-handshake.js"
import { countStart, IDLE_SERVE, shortAccountHomes, startRecordText, unusedLauncher, waitFor } from "./_serve-fixtures.js"

// A serve run in this test process serves the lane of this process's executable.
const lane = serveLaneFor(process.execPath)
const MINUTE = 60_000
const accountHome = shortAccountHomes()
/** The park that the start which parks first records. */
const FIRST_PARK = { since: expect.any(Number), lastAt: expect.any(Number), starts: 1 }

/** A failing streak as a case seeds it into the start record. */
interface SeededStreak {
  readonly since: number
  readonly lastAt: number
  readonly starts: number
  readonly cause: string
  readonly causeKind: "thrown" | "refused" | "clears-itself"
  readonly parked?: { readonly since: number; readonly lastAt: number; readonly starts: number }
}

/** A park that began ten minutes ago, after an hour of failed starts. */
function parkedStreak(causeKind: SeededStreak["causeKind"]): (now: number) => SeededStreak {
  return (now) => ({ since: now - 60 * MINUTE, lastAt: now - 10 * MINUTE, starts: 5, cause: "an earlier failure", causeKind, parked: { since: now - 10 * MINUTE, lastAt: now - 10 * MINUTE, starts: 1 } })
}

/** An account whose lane has a failing streak, and a counted start that
 *  begins now, as the service manager's next restart or a client's start
 *  request runs. By default the streak has failed for three minutes over five
 *  starts, the latest five seconds ago. */
async function failingAccount(streak = (now: number): SeededStreak => ({ since: now - 3 * MINUTE, lastAt: now - 5_000, starts: 5, cause: "an earlier failure", causeKind: "thrown" })) {
  const { root, accountHome: home, userDataRoot } = accountHome("fw-serve-failing-")
  const recordPath = accountServeStartRecordPath(userDataRoot)
  fs.mkdirSync(path.dirname(recordPath), { recursive: true })
  const failing = streak(Date.now())
  fs.writeFileSync(recordPath, JSON.stringify({ version: 2, failing }))
  await countStart(userDataRoot)
  return { directories: { executionCwd: root, projectRoot: root, accountHome: home, userDataRoot }, userDataRoot, failing }
}

describe("a start whose lane keeps failing", () => {
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("parks when its address refuses this user, and records the refusal", async () => {
    const { directories, userDataRoot } = await failingAccount()
    const socketPath = accountServeSocketPath(userDataRoot, lane)
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    // A live listener whose path this user may not connect to.
    const listener = Bun.listen({ unix: socketPath, socket: { data() {} } })
    fs.chmodSync(socketPath, 0o000)
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const warn = spyOn(Log.create({ service: "service-start-record" }), "warn")
    const manager = createPersistentProcessManager()
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], directories, unusedLauncher(), manager, false, IDLE_SERVE)
      expect(warn.mock.calls.filter(([message]) => String(message).includes("parks"))).toEqual([[expect.any(String), { starts: 6, failingMs: expect.any(Number), refusal: "address-access" }]])
    } finally {
      manager.releaseAll()
      write.mockRestore()
      warn.mockRestore()
      listener.stop(true)
    }
    expect(exitCode).toBe(SERVE_EXIT.parked)
    const recorded = JSON.parse(startRecordText(userDataRoot))
    expect(recorded).toEqual({
      version: 2,
      failing: { since: expect.any(Number), lastAt: expect.any(Number), starts: 6, cause: expect.stringContaining("EACCES"), causeKind: "refused", refusal: { kind: "address-access", path: socketPath, code: "EACCES" }, parked: FIRST_PARK },
    })
    // A client shows the recorded cause, and nothing asks again once the
    // start parks, so the cause states only what refused it.
    expect(recorded.failing.cause).not.toContain("asks again")
  }, 15_000)

  test("never parks while an empty claim holds its start lock, because the claim clears itself", async () => {
    const { directories, userDataRoot } = await failingAccount()
    const lockPath = accountServeStartLockPath(userDataRoot, lane)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const holder = { pid: 2_147_483_647, owner: "gone" }
    fs.writeFileSync(lockPath, JSON.stringify(holder))
    const claimPath = `${lockPath}.reclaim.${createHash("sha256").update(holder.owner).digest("hex")}`
    fs.writeFileSync(claimPath, "")
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], directories, unusedLauncher(), createPersistentProcessManager(), false, { startLockBaseDelayMs: 1 })
    } finally {
      write.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.restart)
    expect(JSON.parse(startRecordText(userDataRoot))).toEqual({
      version: 2,
      failing: { since: expect.any(Number), lastAt: expect.any(Number), starts: 6, cause: expect.stringContaining("is empty"), causeKind: "clears-itself", refusal: { kind: "claim-settling", path: claimPath } },
    })
  })

  // No acquisition removes an occupant that is not a holder's record, so it
  // keeps the lock until a person removes it.
  test.each([
    ["a foreign object", "foreign object", (lockPath: string) => { fs.mkdirSync(lockPath) }],
    ["a file that is not a lock record", "holds bytes that are not a lock record", (lockPath: string) => { fs.writeFileSync(lockPath, "not a record") }],
  ])("parks when %s sits at its start lock", async (_occupant, cause, occupy) => {
    const { directories, userDataRoot } = await failingAccount()
    const lockPath = accountServeStartLockPath(userDataRoot, lane)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    occupy(lockPath)
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], directories, unusedLauncher(), createPersistentProcessManager(), false, { startLockBaseDelayMs: 1 })
    } finally {
      write.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(JSON.parse(startRecordText(userDataRoot)).failing).toEqual({ since: expect.any(Number), lastAt: expect.any(Number), starts: 6, cause: expect.stringContaining(cause), causeKind: "refused", parked: FIRST_PARK })
    // Only a person clears it, so the cause names the file.
    expect(JSON.parse(startRecordText(userDataRoot)).failing.cause).toContain(lockPath)
  })
})

describe("a start of a parked lane that a foreign object at its start lock refuses", () => {
  const REFUSED = "the account service start was refused"
  const PARKS_AGAIN = "the account service start parks again: its lane stays parked until a start serves"

  test.each([
    ["repeats the latest failure's cause kind and refusal kind, so it writes both of its records at DEBUG", "refused", "debug"],
    ["changes the condition from a thrown failure, so it writes both of its records at WARN", "thrown", "warn"],
  ] as const)("%s", async (_case, latest, level) => {
    const { directories, userDataRoot } = await failingAccount(parkedStreak(latest))
    fs.mkdirSync(accountServeStartLockPath(userDataRoot, lane), { recursive: true })
    const loggers = [Log.create({ service: "serve" }), Log.create({ service: "service-start-record" })]
    const warn = loggers.map((logger) => spyOn(logger, "warn"))
    const debug = loggers.map((logger) => spyOn(logger, "debug"))
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const messages = (spies: typeof warn) => spies.flatMap((spy) => spy.mock.calls.map(([message]) => String(message))).filter((message) => message === REFUSED || message === PARKS_AGAIN)
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], directories, unusedLauncher(), createPersistentProcessManager(), false, { startLockBaseDelayMs: 1 })
      expect({ warn: messages(warn), debug: messages(debug) }).toEqual(level === "warn" ? { warn: [REFUSED, PARKS_AGAIN], debug: [] } : { warn: [], debug: [REFUSED, PARKS_AGAIN] })
    } finally {
      for (const spy of [...warn, ...debug, write]) spy.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(JSON.parse(startRecordText(userDataRoot)).failing).toMatchObject({ starts: 6, causeKind: "refused", parked: { starts: 2 } })
  })
})

describe("a start of a parked lane that listens", () => {
  test("keeps the park through its listen, and ends it with one record when it stops by its own exit path within its first minute", async () => {
    const { directories, userDataRoot, failing: seeded } = await failingAccount(parkedStreak("thrown"))
    // The lifetime's graces run only when the case ends them, so the case
    // reads the record between the listen and the stop.
    const graces = new Set<() => void>()
    const setTimer = (fire: () => void): (() => void) => {
      graces.add(fire)
      return () => { graces.delete(fire) }
    }
    // The probation minute runs only when the case ends it, and this case
    // ends the start before it does.
    const probation = new Set<() => void>()
    const schedule = (served: () => void): (() => void) => {
      probation.add(served)
      return () => { probation.delete(served) }
    }
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    })
    const info = spyOn(Log.create({ service: "service-start-record" }), "info")
    const manager = createPersistentProcessManager()
    const ended = (message: unknown) => message === "the account service serves after its lane parked"
    let exitCode: number | undefined
    try {
      const serving = runServe([], directories, unusedLauncher(), manager, false, { ...IDLE_SERVE, serveLifetime: () => new ServeLifetime({ resident: false, setTimer }), probation: schedule })
      void serving.then((code) => { exitCode = code })
      await waitFor(() => output.some((chunk) => chunk.includes('"flywheel":"serve.listening"')))
      expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2, failing: seeded })
      expect(info.mock.calls.filter(([message]) => ended(message))).toEqual([])
      expect(probation.size).toBe(1)

      // Nothing holds the serve, so it retires as unheld once its graces end.
      await waitFor(() => {
        for (const grace of graces) {
          graces.delete(grace)
          grace()
        }
        return exitCode !== undefined
      })
      expect(info.mock.calls.filter(([message]) => ended(message))).toEqual([[expect.any(String), { parkedStarts: 1, parkedForMs: expect.any(Number), causeKind: "thrown" }]])
      // The stop ended the probation, so its minute never fires.
      expect(probation.size).toBe(0)
    } finally {
      manager.releaseAll()
      write.mockRestore()
      info.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2 })
  }, 15_000)
})

describe("the entry's fatal path", () => {
  test("a malformed account configuration still listens and clears the lane's failing streak", async () => {
    const { directories, userDataRoot } = await failingAccount()
    fs.writeFileSync(path.join(userDataRoot, "flywheel.toml"), "[updates\n")
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    const manager = createPersistentProcessManager()
    try {
      expect(await runServe([], directories, unusedLauncher(), manager, false, IDLE_SERVE)).toBe(SERVE_EXIT.parked)
      expect(output.join("")).toContain('"flywheel":"serve.listening"')
      expect(fs.readFileSync(path.join(userDataRoot, "flywheel.toml"), "utf8")).toBe("[updates\n")
    } finally {
      manager.releaseAll()
      write.mockRestore()
      stderr.mockRestore()
    }
    expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2 })
  })

  test("adds a thrown start failure to the lane's streak, with the refusal inside the command runner's error, and parks when the streak persists", async () => {
    const { userDataRoot } = await failingAccount()
    const held = new ServeStartupFailure("Failed to start server. Is port 41000 in use?", { kind: "port-in-use", port: 41000 })
    const error = spyOn(Log.Default, "error")
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(await fatalExitCode(new Error(held.message, { cause: held }), "thrown")).toBe(SERVE_EXIT.parked)
      // The first park writes its fatal record in full, with how the failure
      // reached the entry and its detail.
      expect(error.mock.calls).toEqual([["fatal", { kind: "thrown", error: held.message, errorDetail: expect.objectContaining({ message: held.message, stack: expect.stringContaining(held.message), cause: expect.objectContaining({ name: "ServeStartupFailure" }) }) }]])
      // The service never listened, so the start failed.
      expect(stderr.mock.calls).toEqual([[`flywheel: failed to start: ${held.message}\n`]])
      expect(JSON.parse(startRecordText(userDataRoot)).failing).toEqual({ since: expect.any(Number), lastAt: expect.any(Number), starts: 6, cause: held.message, causeKind: "thrown", refusal: { kind: "port-in-use", port: 41000 }, parked: FIRST_PARK })
      // A process fails its start once; any later failure exits as any
      // command's does.
      expect(await fatalExitCode(new Error("a later failure"), "thrown")).toBe(1)
    } finally {
      error.mockRestore()
      stderr.mockRestore()
    }
  })

  test("parks a start after a park that fails again at once, and exits 0, however long after the park the start began", async () => {
    // A client's start request runs this start ten minutes after the lane parked.
    const { userDataRoot, failing: seeded } = await failingAccount(parkedStreak("thrown"))
    // Built at run time, so that no credential-shaped literal is in the source.
    const secret = `sk-${"a".repeat(48)}`
    const cause = "the account store cannot be opened with [redacted secret]"
    // It repeats the thrown failure that parked the lane, so its fatal record
    // is DEBUG, with the same fields as a first record.
    const error = spyOn(Log.Default, "error")
    const debug = spyOn(Log.Default, "debug")
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(await fatalExitCode(new Error(`the account store cannot be opened with ${secret}`), "thrown")).toBe(SERVE_EXIT.parked)
      expect(error).not.toHaveBeenCalled()
      expect(debug.mock.calls).toEqual([["fatal", { kind: "thrown", error: cause, errorDetail: expect.objectContaining({ name: "Error", message: cause, stack: expect.stringContaining(cause) }) }]])
      expect(JSON.stringify(debug.mock.calls)).not.toContain(secret)
    } finally {
      error.mockRestore()
      debug.mockRestore()
      stderr.mockRestore()
    }
    const { failing } = JSON.parse(startRecordText(userDataRoot))
    expect(failing).toEqual({ since: seeded.since, lastAt: expect.any(Number), starts: 6, cause, causeKind: "thrown", parked: { since: seeded.parked?.since, lastAt: failing.lastAt, starts: 2 } })
  })

  test("names a thrown failure after the service listened as a fatal failure, not as a failed start, also after its probation", async () => {
    await failingAccount()
    const probation = new Set<() => void>()
    confirmServiceStart({ schedule: (served) => { probation.add(served); return () => { probation.delete(served) } } })
    for (const served of probation) served()
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    const error = spyOn(Log.Default, "error")
    try {
      // The start served its minute, so the failure joins no streak.
      expect(await fatalExitCode(new Error("the hub stopped"), "thrown")).toBe(1)
      expect(stderr.mock.calls).toEqual([["flywheel: fatal thrown failure: the hub stopped\n"]])
    } finally {
      stderr.mockRestore()
      error.mockRestore()
    }
  })

  test("a failure that arrives while the first one ends exits with the code that the first one decided, and records and counts only the first", async () => {
    const { userDataRoot } = await failingAccount()
    const exits: number[] = []
    const entry = createFatalExit({ exit: (code) => { exits.push(code) } })
    const error = spyOn(Log.Default, "error")
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      // Two floating rejections in one tick: the first one's streak decision
      // parks the lane, so the second must not exit with the code that
      // restarts it.
      await Promise.all([
        entry.fatal(new Error("the account store cannot be opened"), "unhandled rejection"),
        entry.fatal(new Error("a floating rejection"), "unhandled rejection"),
      ])
      expect(exits).toEqual([SERVE_EXIT.parked, SERVE_EXIT.parked])
      expect(error.mock.calls.map(([message]) => message)).toEqual(["fatal"])
      expect(stderr.mock.calls).toEqual([["flywheel: fatal unhandled rejection: the account store cannot be opened\n"]])
    } finally {
      error.mockRestore()
      stderr.mockRestore()
    }
    expect(JSON.parse(startRecordText(userDataRoot)).failing).toMatchObject({ starts: 6, cause: "the account store cannot be opened", causeKind: "thrown", parked: FIRST_PARK })
  })

  test("a failure that arrives while the first one ends exits 1 when the first one decides nothing within a second", async () => {
    jest.useFakeTimers()
    try {
      const exits: number[] = []
      const entry = createFatalExit({ exit: (code) => { exits.push(code) }, decide: () => new Promise<number>(() => {}) })
      void entry.fatal(new Error("the account store cannot be opened"), "uncaught exception")
      const second = entry.fatal(new Error("a floating rejection"), "unhandled rejection")
      jest.advanceTimersByTime(999)
      await Promise.resolve()
      expect(exits).toEqual([])
      jest.advanceTimersByTime(1)
      await second
      expect(exits).toEqual([1])
    } finally {
      jest.useRealTimers()
    }
  })
})
