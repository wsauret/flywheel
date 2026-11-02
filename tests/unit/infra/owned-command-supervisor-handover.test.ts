import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { encodeSupervisorWord, readOutcomeRecord, type CommandHandover, type OutcomeRecordRead } from "../../../src/infra/command-handover.js"
import {
  commandSupervisorArgv,
  parseCommandSupervisorArgv,
  type CommandSupervisorArgv,
} from "../../../src/infra/owned-command-policy.js"
import { superviseCommand } from "../../../src/infra/owned-command-supervisor.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { platformProbe, SUPERVISOR_IDENTITY, type PlatformProbe } from "./_supervisor-platform-probe.js"

const temporary = temporaryDirectories()

const LAUNCHER_GUARDIAN = { pid: 4242, identity: "4242 4242 1758800000.000001" }
const SUCCESSOR_GUARDIAN = { pid: 5151, identity: "5151 5151 1758800100.000001" }
const CHANNEL = "/scratch/a/.flywheel/serve/h0123456789"
const USER_DATA_ROOT = "/scratch/a/.flywheel"

function policy(handover: boolean): CommandSupervisorArgv {
  return {
    lifetime: "guarded",
    killGraceMs: 20,
    guardianPid: LAUNCHER_GUARDIAN.pid,
    guardianIdentity: LAUNCHER_GUARDIAN.identity,
    container: { kind: "process-group" },
    command: ["sleep", "60"],
    ...(handover ? { handover: true as const } : {}),
  }
}

function handoverWord(recordPath: string, extra: Partial<CommandHandover> = {}): string {
  return encodeSupervisorWord({ kind: "handover", handover: { channel: CHANNEL, recordPath, userDataRoot: USER_DATA_ROOT, ...extra } })
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held")
    await Bun.sleep(2)
  }
}

/** Runs a `--handover` supervisor, admits it, and hands it over. Answers once
 *  the acknowledgement record exists. */
async function handedOver(probe: PlatformProbe, extra: Partial<CommandHandover> = {}) {
  const recordPath = join(temporary("supervisor-handover-"), "command.outcome.json")
  const run = superviseCommand(policy(true), probe.platform)
  probe.say("go")
  probe.say(handoverWord(recordPath, extra))
  await until(() => existsSync(recordPath))
  return { run, recordPath }
}

async function settle(run: Promise<unknown>): Promise<"settled" | "running"> {
  return await Promise.race([run.then(() => "settled" as const), Bun.sleep(30).then(() => "running" as const)])
}

describe("handover argv", () => {
  test("round-trips a launch that may be handed over, and a job whose members' children leave it", () => {
    const { command, ...handover } = policy(true)
    const breakaway: CommandSupervisorArgv = {
      lifetime: "guarded",
      killGraceMs: 20,
      guardianPid: LAUNCHER_GUARDIAN.pid,
      guardianIdentity: LAUNCHER_GUARDIAN.identity,
      container: { kind: "job", token: "owned:executor", childrenBreakAway: true },
      command: ["flywheel.exe", "--internal-role=project-executor"],
    }

    expect(parseCommandSupervisorArgv(commandSupervisorArgv(command, handover))).toEqual(policy(true))
    expect(parseCommandSupervisorArgv(commandSupervisorArgv(breakaway.command, breakaway))).toEqual(breakaway)
  })

  test("refuses a handover flag on a persistent supervisor, and a breakaway flag without a job", () => {
    const persistent = commandSupervisorArgv(["sleep", "1"], { lifetime: "persistent", killGraceMs: 20, container: { kind: "process-group" } })
    const withFlag = (argv: readonly string[], flag: string): string[] => [...argv.slice(0, argv.indexOf("--")), flag, ...argv.slice(argv.indexOf("--"))]

    expect(() => parseCommandSupervisorArgv(withFlag(persistent, "--handover"))).toThrow(/cannot be handed over/)
    expect(() => parseCommandSupervisorArgv(withFlag(commandSupervisorArgv(["sleep", "1"], policy(false)), "--children-break-away"))).toThrow(/only with a job/)
  })
})

describe("a supervisor handed over by its launcher", () => {
  test("stops watching its guardian and acknowledges only once it holds the command alone", async () => {
    const probe = platformProbe()

    const { recordPath } = await handedOver(probe)

    // The record names the supervisor's container, so a later owner tells
    // this supervisor apart from a process that takes its pid.
    expect(readOutcomeRecord(recordPath)).toEqual({ kind: "record", record: { version: 1, handedOverAtMs: expect.any(Number), supervisorIdentity: SUPERVISOR_IDENTITY } })
    expect(probe.events).toEqual([
      `watch ${LAUNCHER_GUARDIAN.pid}`,
      "start held",
      `cancel ${LAUNCHER_GUARDIAN.pid}`,
      `serve ${CHANNEL}`,
      `register ${USER_DATA_ROOT}`,
      "suppress",
    ])
  })

  test("reads the end of the launcher's channel as a release: the payload runs on and nothing escalates", async () => {
    const probe = platformProbe()
    const { run } = await handedOver(probe)

    probe.endLauncher()
    // The launcher's guardian is gone too, and its watch no longer counts.
    probe.loseGuardian(LAUNCHER_GUARDIAN.pid)

    expect(await settle(run)).toBe("running")
    expect(probe.signals).toEqual([])
    probe.exitTarget(0, null)
    expect(await run).toEqual({ code: 0, signal: null })
  })

  test("records the payload's outcome before it reports the status", async () => {
    const probe = platformProbe()
    const { run, recordPath } = await handedOver(probe)
    probe.endLauncher()

    probe.exitTarget(3, null)
    await run

    expect(readOutcomeRecord(recordPath)).toMatchObject({ kind: "record", record: { supervisorIdentity: SUPERVISOR_IDENTITY, outcome: { code: 3, signal: null, deadlineExpired: false } } })
    // The registration is held for the supervisor's whole life, and ends with it.
    expect(probe.events.filter((event) => event.startsWith("register"))).toHaveLength(1)
    expect(probe.events.at(-1)).toBe("withdraw")
  })

  test("ends its container at the recorded deadline and says so in the record", async () => {
    const probe = platformProbe()
    const { run, recordPath } = await handedOver(probe, { deadlineAtMs: Date.now() + 20 })
    probe.endLauncher()

    expect(await run).toEqual({ code: null, signal: "SIGTERM" })

    expect(probe.decisions).toEqual([{ signal: "SIGTERM", cause: { reason: "handover deadline passed" } }])
    expect(readOutcomeRecord(recordPath)).toMatchObject({ kind: "record", record: { outcome: { signal: "SIGTERM", deadlineExpired: true } } })
  })

  test("a launch without --handover ignores the handover word", async () => {
    const probe = platformProbe()
    const recordPath = join(temporary("supervisor-handover-"), "command.outcome.json")
    const run = superviseCommand(policy(false), probe.platform)
    probe.say("go")

    probe.say(handoverWord(recordPath))
    probe.endLauncher()

    // The end of the channel is still the launcher leaving a guarded
    // container, so the container ends.
    expect(await run).toEqual({ code: null, signal: "SIGTERM" })
    expect(existsSync(recordPath)).toBe(false)
    expect(probe.events).toEqual([`watch ${LAUNCHER_GUARDIAN.pid}`, "start inherit", `cancel ${LAUNCHER_GUARDIAN.pid}`])
  })
})

describe("a handed-over supervisor adopted by a later owner", () => {
  async function adopted(probe: PlatformProbe, extra: Partial<CommandHandover> = {}) {
    const handed = await handedOver(probe, extra)
    probe.endLauncher()
    const peer = probe.connect()
    peer.send(encodeSupervisorWord({ kind: "adopt", adoption: { guardianPid: SUCCESSOR_GUARDIAN.pid, guardianIdentity: SUCCESSOR_GUARDIAN.identity } }))
    await until(() => peer.answers.length > 0)
    return { ...handed, peer }
  }

  test("watches the adopting owner's guardian and answers adopted", async () => {
    const probe = platformProbe()

    const { peer, run } = await adopted(probe)

    expect(peer.answers).toEqual(["adopted"])
    expect(probe.events.at(-1)).toBe(`watch ${SUCCESSOR_GUARDIAN.pid}`)
    // The new guardian is the backstop again: its loss ends the container.
    probe.loseGuardian(SUCCESSOR_GUARDIAN.pid)
    expect(await run).toEqual({ code: null, signal: "SIGTERM" })
  })

  test("ends the container when the adopting owner's channel ends", async () => {
    const probe = platformProbe()
    const { peer, run, recordPath } = await adopted(probe)

    peer.end()

    expect(await run).toEqual({ code: null, signal: "SIGTERM" })
    expect(readOutcomeRecord(recordPath)).toMatchObject({ kind: "record", record: { outcome: { signal: "SIGTERM", deadlineExpired: false } } })
  })

  test("leaves the deadline to the adopting owner", async () => {
    const probe = platformProbe()
    const { run } = await adopted(probe, { deadlineAtMs: Date.now() + 40 })

    await Bun.sleep(60)

    expect(await settle(run)).toBe("running")
    probe.exitTarget(0, null)
    await run
  })

  // An adopting owner keeps its channel open to see the end it asked for, so
  // its stop cannot be followed by the close a launcher's stop is.
  test("ends the container for the adopting owner's stop, retried until the container is empty", async () => {
    const probe = platformProbe({ stubborn: true })
    const { peer, run } = await adopted(probe)

    peer.send("stop")
    await until(() => probe.signals.length >= 4)

    // Its stop word is a controller's stop, whichever controller sent it.
    expect(probe.decisions.slice(0, 4)).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"].map((signal) => ({ signal, cause: { reason: "stop requested" } })))
    expect(await settle(run)).toBe("running")
    probe.exitTarget(null, "SIGKILL")
    expect(await run).toEqual({ code: null, signal: "SIGKILL" })
  })

  test("refuses a second connection while a controller holds the channel", async () => {
    const probe = platformProbe()
    const { run } = await adopted(probe)

    const second = probe.connect()
    second.send(encodeSupervisorWord({ kind: "adopt", adoption: { guardianPid: 6161, guardianIdentity: "6161 6161 1" } }))
    second.end()

    expect(second.closed()).toBe(true)
    expect(second.answers).toEqual([])
    expect(await settle(run)).toBe("running")
    expect(probe.events).not.toContain("watch 6161")
    probe.exitTarget(0, null)
    await run
  })

  test("answers an adopt of a version it does not speak with the versions it does", async () => {
    const probe = platformProbe()
    const { run } = await handedOver(probe)
    probe.endLauncher()
    const peer = probe.connect()

    peer.send(`adopt {"v":2,"guardianPid":5151,"guardianIdentity":"x","lease":"y"}`)
    await until(() => peer.answers.length > 0)

    expect(peer.answers).toEqual([`refused {"versions":[1]}`])
    // A refused peer is no controller, so its end changes nothing.
    peer.end()
    expect(await settle(run)).toBe("running")
    probe.exitTarget(0, null)
    await run
  })

  test("crosses a later replacement: the adopting owner hands it over again, and its end is a release", async () => {
    const probe = platformProbe()
    const { peer, run, recordPath } = await adopted(probe)
    const acknowledged = (): OutcomeRecordRead => readOutcomeRecord(recordPath)
    const first = acknowledged()

    await Bun.sleep(2)
    peer.send(handoverWord(recordPath))
    await until(() => {
      const read = acknowledged()
      return read.kind === "record" && first.kind === "record" && read.record.handedOverAtMs > first.record.handedOverAtMs
    })
    peer.end()

    expect(await settle(run)).toBe("running")
    expect(probe.signals).toEqual([])
    // One registration for the supervisor's whole life, however often it is
    // handed over.
    expect(probe.events.filter((event) => event.startsWith("register"))).toHaveLength(1)
    probe.exitTarget(0, null)
    await run
  })
})
