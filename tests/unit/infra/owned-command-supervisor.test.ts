import { existsSync, rmSync, writeFileSync } from "node:fs"
import { basename, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, spyOn, test } from "bun:test"

import { lockCommandSupervisorEntry } from "../../../src/infra/command-supervisor-entry.js"
import { Log } from "../../../src/infra/log.js"
import { ownUnixContainer, type ManagedContainer } from "../../../src/infra/process-container.js"
import { commandSupervisorArgv, parseCommandSupervisorArgv } from "../../../src/infra/owned-command-policy.js"
import {
  OWNERSHIP_REFUSED_EXIT_CODE,
  ownGroupSignals,
  runCommandSupervisor,
  superviseCommand,
  type CommandSupervisorHost,
  type SupervisedTarget,
  type SupervisorPlatform,
} from "../../../src/infra/owned-command-supervisor.js"
import { platformProbe } from "./_supervisor-platform-probe.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { snapshotFixture } from "../../helpers/source-snapshot-fixture.js"

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "")

const POLICY = { lifetime: "guarded", killGraceMs: 20, guardianPid: 4242, guardianIdentity: "4242 4242 Mon Jan 1 00:00:00 2024", container: { kind: "process-group" }, priority: "background" } as const

interface SupervisorProbe {
  readonly host: CommandSupervisorHost
  readonly signals: string[]
  /** Which view each signal went to: the group alone, or everything the
   *  command started. */
  readonly reached: string[]
  readonly started: string[]
  /** Ends the payload, as its own exit or under a signal it took. */
  exitTarget(code: number | null, signal: NodeJS.Signals | null): void
  emptyContainer(): void
  requestStop(): void
  end(): void
  release(): void
  waitForSignals(count: number): Promise<void>
}

/** A container without processes: the test says what the container still holds
 *  and what the payload did, so the supervisor's decisions are observed without
 *  spawning anything. */
function supervisorProbe(options: {
  readonly admitted?: boolean
  readonly priorityEstablished?: boolean
  /** Descendants left in the container after the payload exits, and the signal
   *  that finally removes them. */
  readonly descendants?: number
  readonly descendantsTake?: "SIGTERM" | "SIGKILL" | "nothing"
} = {}): SupervisorProbe {
  const signals: string[] = []
  const signalWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = []
  const started: string[] = []
  let targetExited = false
  let exitCode: number | null = null
  let signalCode: NodeJS.Signals | null = null
  let settleTarget: () => void = () => {}
  const exited = new Promise<void>((resolve) => { settleTarget = resolve })
  let descendants = options.descendants ?? 0
  const takes = options.descendantsTake ?? "SIGTERM"
  type Request = Awaited<ReturnType<CommandSupervisorHost["nextRequest"]>>
  const requests: Request[] = []
  const waiters: Array<(request: Request) => void> = []
  const request = (value: Request): void => {
    const waiter = waiters.shift()
    if (waiter) waiter(value)
    else requests.push(value)
  }

  const target: SupervisedTarget = {
    exited,
    get exitCode() { return exitCode },
    get signalCode() { return signalCode },
    usage: () => undefined,
  }
  const reached: string[] = []
  const container = (view: "container" | "ending"): ManagedContainer => ({
    signal(signal) {
      reached.push(view)
      signals.push(signal)
      for (let index = signalWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = signalWaiters[index]
        if (waiter === undefined || signals.length < waiter.count) continue
        signalWaiters.splice(index, 1)
        waiter.resolve()
      }
      if (!targetExited) return
      if (takes !== "nothing" && (signal === "SIGKILL" || (signal === "SIGTERM" && takes === "SIGTERM"))) descendants = 0
    },
    populated: () => !targetExited || descendants > 0,
  })

  return {
    signals,
    reached,
    started,
    exitTarget(code, signal) {
      exitCode = code
      signalCode = signal
      targetExited = true
      settleTarget()
    },
    emptyContainer() {
      descendants = 0
    },
    requestStop: () => { request({ kind: "stop", cause: { reason: "stop requested" } }) },
    end: () => { request({ kind: "end", cause: { reason: "controller channel ended" } }) },
    release: () => { request({ kind: "release" }) },
    waitForSignals(count) {
      if (signals.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => { signalWaiters.push({ count, resolve }) })
    },
    host: {
      admission: () => Promise.resolve(options.admitted ?? true),
      establishPriority: () => options.priorityEstablished ?? true,
      nextRequest: () => {
        const ready = requests.shift()
        return ready === undefined
          ? new Promise<Request>((resolve) => { waiters.push(resolve) })
          : Promise.resolve(ready)
      },
      start() {
        started.push("target")
        return target
      },
      container: container("container"),
      ending: container("ending"),
      sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    },
  }
}

describe("owned command supervisor argv", () => {
  test("round-trips the policy and the payload it supervises", () => {
    const argv = commandSupervisorArgv(["bash", "--login", "--", "-c"], POLICY)

    expect(parseCommandSupervisorArgv(argv)).toEqual({ ...POLICY, command: ["bash", "--login", "--", "-c"] })
  })

  test("round-trips strict natural-exit settlement", () => {
    const policy = { ...POLICY, onPayloadExit: "end-descendants" } as const
    expect(parseCommandSupervisorArgv(commandSupervisorArgv(["true"], policy))).toEqual({ ...policy, command: ["true"] })
  })

  test("round-trips a stop hold", () => {
    const policy = { ...POLICY, stopHold: { path: join(sep, "config", ".oauth_refresh.lock"), boundMs: 35_000 } } as const
    expect(parseCommandSupervisorArgv(commandSupervisorArgv(["claude"], policy))).toEqual({ ...policy, command: ["claude"] })
  })

  test("round-trips EOF stdin independently of handover", () => {
    const policy = { ...POLICY, stdin: "ignore", handover: true } as const
    expect(parseCommandSupervisorArgv(commandSupervisorArgv(["grep", "pattern"], policy))).toEqual({
      ...policy, command: ["grep", "pattern"],
    })
  })

  test("round-trips persistent lifetime without a guardian", () => {
    const policy = { lifetime: "persistent", killGraceMs: 20, container: { kind: "process-group" } } as const

    const parsed = parseCommandSupervisorArgv(commandSupervisorArgv(["sleep", "1"], policy))

    expect(parsed).toEqual({ ...policy, command: ["sleep", "1"] })
    expect(parsed).not.toHaveProperty("guardianPid")
    expect(parsed).not.toHaveProperty("guardianIdentity")
  })

  test("keeps normal priority absent from the supervisor contract", () => {
    const policy = { lifetime: "guarded", killGraceMs: 20, guardianPid: 4242, guardianIdentity: "identity", container: { kind: "process-group" } } as const
    const argv = commandSupervisorArgv(["true"], policy)

    expect(argv).not.toContain("--background-priority")
    expect(parseCommandSupervisorArgv(argv)).toEqual({ ...policy, command: ["true"] })
  })

  test("refuses persistent Windows job ownership", () => {
    const argv = [
      process.execPath, "supervisor.ts", "--lifetime", "persistent",
      "--kill-grace-ms", "20", "--container", "job:token", "--", "sleep", "1",
    ]

    expect(() => parseCommandSupervisorArgv(argv)).toThrow("requires a process-group")
  })

  test("re-enters a source Bun through its stable Linux process identity", () => {
    const originalPlatform = process.platform
    const originalExecPath = process.execPath
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true })
      process.execPath = "/opt/flywheel-bun/bin/bun"

      expect(commandSupervisorArgv(["true"], POLICY)[0]).toBe("/proc/self/exe")
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
      process.execPath = originalExecPath
    }
  })

  test("refuses an invocation Flywheel could not have produced", () => {
    expect(() => parseCommandSupervisorArgv(["bun", "supervisor.ts", "--kill-grace-ms", "5", "--"])).toThrow(/command/)
    expect(() => parseCommandSupervisorArgv(["bun", "supervisor.ts", "--", "sleep", "1"])).toThrow(/kill-grace-ms/)
    expect(() => parseCommandSupervisorArgv(["bun", "s.ts", "--lifetime", "guarded", "--kill-grace-ms", "5", "--container", "process-group", "--", "sleep"])).toThrow(/guardian-pid/)
    expect(() => parseCommandSupervisorArgv(["bun", "s.ts", "--lifetime", "guarded", "--kill-grace-ms", "5", "--guardian-pid", "9", "--container", "process-group", "--", "sleep"])).toThrow(/guardian-identity/)
  })
})

describe("command supervisor entry lock", () => {
  test("a packaged binary has nothing to lock", async () => {
    const originalExecPath = process.execPath
    try {
      process.execPath = "/usr/local/bin/flywheel"

      expect(await lockCommandSupervisorEntry()).toEqual({ kind: "packaged" })
    } finally {
      process.execPath = originalExecPath
    }
  })

  test("locks launches onto a snapshot the working tree can no longer change", async () => {
    const lock = await lockCommandSupervisorEntry()

    if (lock.kind !== "locked") throw new Error(`expected a locked entry, got ${lock.kind}`)
    // The snapshot lives in the checkout's build cache, never in TMPDIR, and
    // its name is a hash of its content, so every process shares one file.
    expect(lock.path.startsWith(join(repoRoot, "node_modules", ".cache", "flywheel") + sep)).toBe(true)
    expect(basename(lock.path)).toMatch(/^owned-command-supervisor-[0-9a-f]{16}\.js$/)
    expect(existsSync(lock.path)).toBe(true)
    expect(commandSupervisorArgv(["true"], POLICY)[1]).toBe(lock.path)
    // Repeated locks join the first: one snapshot per process.
    expect(await lockCommandSupervisorEntry()).toEqual(lock)
  })

  const temporaryDirectory = temporaryDirectories()

  test("a dev service that runs from a source snapshot bundles into its checkout's build cache, outside every snapshot", async () => {
    const fixture = snapshotFixture(temporaryDirectory("flywheel-snapshot-supervisor-"), ["src/infra/command-supervisor-entry.ts", "src/infra/owned-command-supervisor.ts"], { lazyImports: true })
    const snapshotted = await fixture.importFromSnapshot<typeof import("../../../src/infra/command-supervisor-entry.js")>("src/infra/command-supervisor-entry.ts")

    const lock = await snapshotted.lockCommandSupervisorEntry()

    if (lock.kind !== "locked") throw new Error(`expected a locked entry, got ${JSON.stringify(lock)}`)
    expect(lock.path).toBe(join(fixture.checkout, "node_modules", ".cache", "flywheel", basename(lock.path)))
  })
})

describe("own group TERM", () => {
  const group = () => {
    const sent: string[] = []
    const stops: string[] = []
    const own = ownGroupSignals({ signal: (signal) => { sent.push(signal) }, populated: () => true }, () => { stops.push("stop") })
    return { own, sent, stops }
  }

  test("reads the TERM this supervisor sent its own group as part of its escalation, not as a stop", () => {
    const { own, sent, stops } = group()

    own.container.signal("SIGTERM", { reason: "test" })
    own.onTerm()

    expect(sent).toEqual(["SIGTERM"])
    expect(stops).toEqual([])
  })

  test("reads every other TERM as a stop request", () => {
    const { own, stops } = group()

    own.onTerm()
    own.container.signal("SIGTERM", { reason: "test" })
    own.onTerm()
    own.onTerm()
    own.container.signal("SIGKILL", { reason: "test" })
    own.onTerm()

    expect(stops).toEqual(["stop", "stop", "stop"])
  })

  test("keeps one mark, because at most one TERM of its own is outstanding at a time", () => {
    // Each escalation sends one TERM and yields to the event loop, where that
    // TERM is answered, before any later escalation can send another.
    const { own, stops } = group()

    own.container.signal("SIGTERM", { reason: "test" })
    own.onTerm()
    own.container.signal("SIGTERM", { reason: "test" })
    own.onTerm()
    own.onTerm()

    expect(stops).toEqual(["stop"])
  })
})

describe("owned command supervisor", () => {
  test.each([
    { handover: undefined, stdin: undefined, expected: "inherit" },
    { handover: true, stdin: undefined, expected: "held" },
    { handover: undefined, stdin: "ignore", expected: "ignore" },
    { handover: true, stdin: "ignore", expected: "ignore" },
  ] as const)("starts the payload with $expected stdin (handover: $handover)", async ({ handover, stdin, expected }) => {
    const probe = platformProbe()
    const parsed = parseCommandSupervisorArgv(commandSupervisorArgv(["grep", "pattern"], {
      ...POLICY,
      ...(handover === undefined ? {} : { handover }),
      ...(stdin === undefined ? {} : { stdin }),
    }))
    const run = superviseCommand(parsed, {
      ...probe.platform,
      start(mode) {
        const target = probe.platform.start(mode)
        probe.exitTarget(0, null)
        return target
      },
    })
    probe.say("go")
    expect(await run).toEqual({ code: 0, signal: null })
    expect(probe.events).toContain(`start ${expected}`)
  })

  describe("the record of what the payload used", () => {
    const ENGINE = String.raw`C:\Program Files\Flywheel\native\win32-x64\claude.exe`

    /** A start whose payload exits with `code` as soon as it runs. */
    function exitingWith(probe: ReturnType<typeof platformProbe>, code: number) {
      return (stdin: "inherit" | "held" | "ignore") => {
        const target = probe.platform.start(stdin)
        probe.exitTarget(code, null)
        return target
      }
    }

    /** Supervises `command` on `platform` until it settles, and returns every
     *  payload record the supervisor wrote. */
    async function payloadRecords(probe: ReturnType<typeof platformProbe>, platform: SupervisorPlatform, command: readonly string[], act: () => void = () => {}) {
      const debug = spyOn(Log.create({ service: "command-supervisor" }), "debug")
      try {
        const run = superviseCommand({ ...POLICY, command }, platform)
        probe.say("go")
        act()
        await run
        return debug.mock.calls.filter(([message]) => message === "payload exited")
      } finally {
        debug.mockRestore()
      }
    }

    test("records the payload's usage, wall time, and exit once, under its executable's name alone", async () => {
      const usage = { cpuUserMs: 1460.3, cpuSystemMs: 12.5, maxProcessRssBytes: 224_608_256 }
      const probe = platformProbe({ usage })

      const records = await payloadRecords(probe, { ...probe.platform, start: exitingWith(probe, 0) }, [ENGINE, "--append-system-prompt", "private prompt"])

      expect(records).toEqual([["payload exited", { kind: "claude", wallMs: expect.any(Number), ...usage, exitCode: 0 }]])
      expect(JSON.stringify(records)).not.toContain("private prompt")
      expect(JSON.stringify(records)).not.toContain("Program Files")
    })

    test("omits the usage a platform does not report, and names the signal a payload died of", async () => {
      const probe = platformProbe()

      const records = await payloadRecords(probe, probe.platform, ["/bin/bash", "/scratch/script.sh"], () => { probe.signalStop("SIGTERM") })

      expect(records).toEqual([["payload exited", { kind: "bash", wallMs: expect.any(Number), signal: "SIGTERM" }]])
    })
  })

  test("never starts the payload when ownership was refused", async () => {
    const probe = supervisorProbe({ admitted: false })

    const outcome = await runCommandSupervisor(probe.host, POLICY.killGraceMs)

    expect(probe.started).toEqual([])
    expect(probe.signals).toEqual([])
    expect(outcome).toEqual({ code: OWNERSHIP_REFUSED_EXIT_CODE, signal: null })
  })

  test("never starts the payload when required priority cannot be established", async () => {
    const probe = supervisorProbe({ priorityEstablished: false })

    const outcome = await runCommandSupervisor(probe.host, POLICY.killGraceMs)

    expect(probe.started).toEqual([])
    expect(outcome).toEqual({ code: OWNERSHIP_REFUSED_EXIT_CODE, signal: null })
  })

  test("settles as soon as the payload exits and leaves nothing behind", async () => {
    const probe = supervisorProbe()
    const run = runCommandSupervisor(probe.host, POLICY.killGraceMs)

    probe.exitTarget(0, null)

    expect(await run).toEqual({ code: 0, signal: null })
    expect(probe.signals).toEqual([])
  })

  test("empties the container when the payload exits while a descendant holds it", async () => {
    const probe = supervisorProbe({ descendants: 1 })
    const run = runCommandSupervisor(probe.host, POLICY.killGraceMs)

    probe.exitTarget(7, null)

    // The payload's own status is still what the launcher sees, but only after
    // the descendant that outlived it is gone.
    expect(await run).toEqual({ code: 7, signal: null })
    expect(probe.signals).toEqual(["SIGTERM"])
    // A payload that exits on its own takes along only its group: a process
    // it detached, such as a terminal multiplexer's server, keeps running.
    expect(probe.reached).toEqual(["container"])
  })

  test("escalates to SIGKILL for a descendant that ignores the grace", async () => {
    const probe = supervisorProbe({ descendants: 1, descendantsTake: "SIGKILL" })
    const run = runCommandSupervisor(probe.host, POLICY.killGraceMs)

    probe.exitTarget(0, null)

    expect(await run).toEqual({ code: 0, signal: null })
    expect(probe.signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("strict natural exit reaches detached descendants and preserves the payload status", async () => {
    const probe = supervisorProbe({ descendants: 1, descendantsTake: "SIGKILL" })
    const run = runCommandSupervisor(probe.host, POLICY.killGraceMs, "end-descendants")
    probe.exitTarget(7, "SIGINT")
    expect(await run).toEqual({ code: 7, signal: "SIGINT" })
    expect(probe.signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(probe.reached).toEqual(["ending", "ending"])
  })

  test("strict natural exit retries instead of waiting for another controller request", async () => {
    const probe = supervisorProbe({ descendants: 1, descendantsTake: "nothing" })
    const run = runCommandSupervisor(probe.host, 2, "end-descendants")
    probe.exitTarget(9, null)
    await probe.waitForSignals(6)
    probe.emptyContainer()
    expect(await run).toEqual({ code: 9, signal: null })
    expect(probe.reached.every((view) => view === "ending")).toBe(true)
  })

  test("release does not produce an immediate supervisor outcome", async () => {
    const probe = supervisorProbe()
    const run = runCommandSupervisor(probe.host, POLICY.killGraceMs)
    let settled = false
    void run.then(() => { settled = true })

    probe.release()
    await Bun.sleep(10)

    expect(settled).toBe(false)
    expect(probe.signals).toEqual([])

    probe.exitTarget(0, null)
    expect(await run).toEqual({ code: 0, signal: null })
  })

  test("released natural exit retries settlement until emptiness is proven", async () => {
    const probe = supervisorProbe({ descendants: 1, descendantsTake: "nothing" })
    const run = runCommandSupervisor(probe.host, POLICY.killGraceMs)
    let settled = false
    void run.then(() => { settled = true })
    probe.release()
    probe.exitTarget(0, null)
    await probe.waitForSignals(2)

    expect(settled).toBe(false)

    probe.emptyContainer()
    expect(await run).toEqual({ code: 0, signal: null })
  })

  test("guarded channel end retries settlement until emptiness is proven", async () => {
    const probe = supervisorProbe({ descendants: 1, descendantsTake: "nothing" })
    const run = runCommandSupervisor(probe.host, 2)

    try {
      probe.requestStop()
      probe.end()
      await probe.waitForSignals(6)
      expect(probe.signals.length).toBeGreaterThanOrEqual(6)
    } finally {
      probe.exitTarget(null, "SIGKILL")
      probe.emptyContainer()
      await run
    }
  })

  test("an emptying that stays unsettled records its first result once and the count of its repeats before the supervisor reports", async () => {
    const probe = supervisorProbe({ descendants: 1, descendantsTake: "nothing" })
    const warn = spyOn(Log.create({ service: "command-supervisor" }), "warn")
    try {
      const run = runCommandSupervisor(probe.host, 2)
      probe.end()
      // Three escalations began, so at least two ended unsettled.
      await probe.waitForSignals(6)
      probe.exitTarget(null, "SIGKILL")
      probe.emptyContainer()
      await run

      expect(warn.mock.calls).toEqual([
        ["the container was not proven empty; the supervisor keeps it and empties it again", { remaining: 1, mode: "ending", reason: "controller channel ended" }],
        ["the container was not proven empty again", { count: expect.any(Number), windowMs: expect.any(Number) }],
      ])
    } finally {
      warn.mockRestore()
    }
  })

  test("persistent release does not repeat an unsettled stop", async () => {
    const probe = supervisorProbe({ descendants: 1, descendantsTake: "nothing" })
    const run = runCommandSupervisor(probe.host, 2)

    try {
      probe.requestStop()
      await probe.waitForSignals(2)
      probe.release()

      const next = await Promise.race([
        run.then(() => "released" as const),
        probe.waitForSignals(4).then(() => "signaled" as const),
      ])
      expect(next).toBe("released")
      expect(await run).toEqual({ code: null, signal: null })
    } finally {
      probe.exitTarget(0, null)
      probe.emptyContainer()
      await run
    }
  })

  test("ends the container when control is lost while the payload still runs", async () => {
    const probe = supervisorProbe({ descendants: 1, descendantsTake: "SIGKILL" })
    const run = runCommandSupervisor(probe.host, POLICY.killGraceMs)

    probe.requestStop()
    await Bun.sleep(5)
    // The escalation is what removes the payload, and its death is reported as
    // the container's own status.
    probe.exitTarget(null, "SIGKILL")

    expect(await run).toEqual({ code: null, signal: "SIGKILL" })
    expect(probe.signals).toEqual(["SIGTERM", "SIGKILL"])
    // A stop ends everything the command started, also what left its group.
    expect(probe.reached).toEqual(["ending", "ending"])
  })
})

describe("the cause a supervisor's termination decision names", () => {
  const holdDirectory = temporaryDirectories()
  const GUARDIAN = POLICY.guardianIdentity
  const STRANGER = "4242 4242 Tue Jan 2 00:00:00 2024"

  /** Runs a supervisor over `probe`, admits it, and collects every record
   *  its log writes at INFO until it settles. */
  async function supervised(probe: ReturnType<typeof platformProbe>, act: () => void) {
    const info = spyOn(Log.create({ service: "command-supervisor" }), "info")
    try {
      const run = superviseCommand({ ...POLICY, command: ["sleep", "60"] }, probe.platform)
      probe.say("go")
      act()
      const outcome = await run
      return { outcome, messages: info.mock.calls.map(([message]) => message) }
    } finally {
      info.mockRestore()
    }
  }

  test("a guardian proof ends the container with the proof in its termination decision", async () => {
    const probe = platformProbe({ guardianReads: { alive: () => true, identify: () => ({ kind: "process", identity: STRANGER }) } })

    const { outcome, messages } = await supervised(probe, () => {})

    expect(outcome).toEqual({ code: null, signal: "SIGTERM" })
    expect(probe.decisions).toEqual([{
      signal: "SIGTERM",
      cause: { reason: "guardian identity mismatch", evidence: { guardianPid: 4242, expectedIdentity: GUARDIAN, actualIdentity: STRANGER, elapsedProbeMs: expect.any(Number) } },
    }])
    // The decision carries the proof once, so no record repeats it.
    expect(messages).not.toContain("guardian watch lost")
  })

  test("a stop signal names itself", async () => {
    const probe = platformProbe()

    const { messages } = await supervised(probe, () => { probe.signalStop("SIGTERM") })

    expect(probe.decisions).toEqual([{ signal: "SIGTERM", cause: { reason: "stop signal received", evidence: { signal: "SIGTERM" } } }])
    expect(messages).not.toContain("command supervisor termination trigger")
  })

  test("a guarded launcher's stop retries unanswered membership until recovery without controller EOF", async () => {
    const probe = platformProbe({ stubborn: true })
    const retry = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const signals: string[] = []
    let recovered = false
    const container = ownUnixContainer({
      groupExists: () => true,
      signal: (_pid, signal, _container, cause) => {
        signals.push(signal)
        expect(cause).toEqual({ reason: "stop requested" })
      },
      procfs: {
        listPids: () => recovered ? [] : undefined,
        readStat: () => ({ kind: "absent" }),
        readEnviron: () => ({ kind: "absent" }),
        bootId: () => ({ kind: "absent" }),
      },
    })
    const run = superviseCommand({ ...POLICY, killGraceMs: 2, command: ["sleep", "60"] }, {
      ...probe.platform,
      container,
      ending: container,
      sleep: (ms) => {
        if (ms <= 2) return probe.platform.sleep(ms)
        retry.resolve()
        return resume.promise
      },
    })
    probe.say("go")
    probe.say("stop")

    try {
      expect(await Promise.race([retry.promise.then(() => "retry"), Bun.sleep(30).then(() => "waiting")])).toBe("retry")
      expect(signals).toEqual(["SIGTERM"])
      expect(container.populated()).toBe(true)
      recovered = true
      resume.resolve()
      probe.exitTarget(null, "SIGKILL")
      expect(await run).toEqual({ code: null, signal: "SIGKILL" })
      expect(signals).toEqual(["SIGTERM"])
    } finally {
      recovered = true
      resume.resolve()
      probe.exitTarget(null, "SIGKILL")
      probe.endLauncher()
      await run
    }
  })

  test("a persistent launcher's stop stays bounded and its release leaves unsettled work alive", async () => {
    const probe = platformProbe({ stubborn: true })
    const unsettled = Promise.withResolvers<void>()
    const warn = spyOn(Log.create({ service: "command-supervisor" }), "warn").mockImplementation(() => { unsettled.resolve() })
    const run = superviseCommand({ lifetime: "persistent", killGraceMs: 2, container: POLICY.container, command: ["sleep", "60"] }, probe.platform)
    probe.say("go")
    probe.say("stop")
    try {
      await unsettled.promise
      expect(probe.signals).toEqual(["SIGTERM", "SIGKILL"])
      expect(await Promise.race([run.then(() => "settled"), Bun.sleep(10).then(() => "running")])).toBe("running")
      probe.endLauncher()
      expect(await run).toEqual({ code: null, signal: null })
      expect(probe.signals).toEqual(["SIGTERM", "SIGKILL"])
    } finally {
      probe.exitTarget(0, null)
      probe.endLauncher()
      await run
      warn.mockRestore()
    }
  })

  test("a launcher's stop sends nothing while the launch's stop hold stands", async () => {
    const hold = join(holdDirectory("stop-hold-"), ".oauth_refresh.lock")
    writeFileSync(hold, "")
    const probe = platformProbe()
    const run = superviseCommand({ ...POLICY, stopHold: { path: hold, boundMs: 35_000 }, command: ["claude"] }, probe.platform)
    probe.say("go")
    probe.say("stop")
    try {
      await Bun.sleep(50)
      expect(probe.decisions).toEqual([])
      rmSync(hold)
      expect(await run).toEqual({ code: null, signal: "SIGTERM" })
      expect(probe.decisions).toEqual([{ signal: "SIGTERM", cause: { reason: "stop requested", evidence: { stopHeldMs: expect.any(Number) } } }])
    } finally {
      rmSync(hold, { force: true })
      probe.exitTarget(null, "SIGKILL")
      await run
    }
  })

  test("the end of the controller channel names itself", async () => {
    const probe = platformProbe()

    await supervised(probe, () => { probe.endLauncher() })

    expect(probe.decisions).toEqual([{ signal: "SIGTERM", cause: { reason: "controller channel ended" } }])
  })
})
