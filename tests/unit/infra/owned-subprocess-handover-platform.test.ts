import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { createOwnedProcessBackend, type ProcessGroupHost } from "../../../src/infra/owned-subprocess-backend.js"
import { decodeSupervisorWord, writeOutcomeRecord, type CommandHandover } from "../../../src/infra/command-handover.js"
import { serveLines, type LineConnection } from "../../../src/infra/line-channel.js"
import { windowsContainerName } from "../../../src/infra/owned-command-supervisor.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { fakePid } from "../../helpers/fake-pid.js"
import { acknowledgeOnceSaid, GUARDIAN_IDENTITY, GUARDIAN_KERNEL, handoverTo, POLICY, recordingHost, RUNNING, type FakeKernel } from "./_owned-subprocess-platform-fixtures.js"

const temporary = temporaryDirectories()

describe("handing over a unix launch", () => {
  const writes = (calls: readonly string[]): string[] => calls.filter((call) => call.startsWith("write 9 ")).map((call) => String(JSON.parse(call.slice("write 9 ".length))))

  test("tells only a handover-capable supervisor that it may be handed over", () => {
    const recorded = recordingHost(GUARDIAN_KERNEL)
    const backend = createOwnedProcessBackend(recorded.posix)

    backend.launch(["sleep", "1"], POLICY)
    backend.launch(["sleep", "1"], { ...POLICY, handover: true })

    expect(recorded.spawns[0]?.argv).not.toContain("--handover")
    expect(recorded.spawns[1]?.argv).toContain("--handover")
  })

  test("says the word on the control descriptor and lets go of the container once the supervisor acknowledges it", async () => {
    const recorded = recordingHost(GUARDIAN_KERNEL, { supervisorRuns: true })
    const launch = createOwnedProcessBackend(recorded.posix).launch(["sleep", "1"], { ...POLICY, handover: true })
    launch.admit()
    const handover = handoverTo(temporary("platform-handover-"), "/scratch/a/.flywheel/serve/h-0123456789abcdef.sock")
    let settled = false
    void launch.child.exited.then(() => { settled = true })
    // A holder reading the supervisor's output, as the shell runtime does.
    const read = launch.child.stdout?.getReader().read()

    const [acknowledgement] = await Promise.all([launch.handOver(handover, 1_000), acknowledgeOnceSaid(() => writes(recorded.calls), handover)])

    expect(acknowledgement).toBe("acknowledged")
    expect(writes(recorded.calls).map((word) => decodeSupervisorWord(word.trim()))).toEqual([{ kind: "go" }, { kind: "handover", handover }])
    // The channel's end is the supervisor's release, and this process no
    // longer waits for a container it does not own.
    expect(recorded.calls.slice(-2)).toEqual(["close 9", "unref"])
    // A pipe this process reads would keep it running until the supervisor
    // closes it, so the holder's read ends as the pipe's end.
    expect(await read).toEqual({ done: true, value: undefined })
    recorded.exitSupervisor()
    await Bun.sleep(10)
    // Its exit belongs to its next owner, so it never settles here, and this
    // side sends the container nothing.
    expect(settled).toBe(false)
    expect(recorded.calls.filter((call) => call.startsWith("kill") || call.startsWith("group"))).toEqual([])
  })

  test("keeps a launch the supervisor never acknowledged", async () => {
    const recorded = recordingHost(GUARDIAN_KERNEL, { supervisorRuns: true })
    const launch = createOwnedProcessBackend(recorded.posix).launch(["sleep", "1"], { ...POLICY, handover: true })
    launch.admit()

    expect(await launch.handOver(handoverTo(temporary("platform-handover-"), "/h.sock"), 20)).toBe("unacknowledged")

    expect(recorded.calls).not.toContain("close 9")
    launch.stop()
    expect(writes(recorded.calls).at(-1)).toBe("stop\n")
  })

  test("reports a supervisor that exited before it acknowledged, and settles it as ever", async () => {
    const recorded = recordingHost(GUARDIAN_KERNEL, { supervisorRuns: true, groupGone: true })
    const launch = createOwnedProcessBackend(recorded.posix).launch(["sleep", "1"], { ...POLICY, handover: true })
    launch.admit()

    const answer = launch.handOver(handoverTo(temporary("platform-handover-"), "/h.sock"), 1_000)
    recorded.exitSupervisor()

    expect(await answer).toBe("exited")
    expect(await launch.child.exited).toEqual({ code: null, signal: null, statusOf: "payload" })
  })
})

describe("reaching a handed-over command", () => {
  const TOKEN = "owned:handed-over"

  /** A channel served the way a handed-over supervisor serves one: it holds
   *  one controller at a time and answers each adopt with `answer`. */
  function supervisorChannel(answer: "adopted" | `refused ${string}` | "hang up" | "busy" | "late") {
    const dir = temporary("reach-")
    const address = process.platform === "win32"
      ? String.raw`\\.\pipe\Flywheel.handover-test.${crypto.randomUUID()}`
      : join(dir, "h.sock")
    const heard: string[] = []
    let controller: LineConnection | undefined
    const server = serveLines(address, (connection) => {
      if (answer === "busy") {
        connection.close()
        return
      }
      controller = connection
      void (async () => {
        for (let line = await connection.next(); line !== undefined; line = await connection.next()) {
          heard.push(line)
          if (decodeSupervisorWord(line).kind !== "adopt" && !line.startsWith("adopt")) continue
          if (answer === "hang up") {
            connection.close()
            server.stop()
          } else if (answer === "late") {
            setTimeout(() => { connection.say("adopted") }, 20)
          } else {
            connection.say(answer)
          }
        }
      })()
    })
    return { address, heard, recordPath: join(dir, "command.outcome.json"), end: () => { server.stop() }, controller: () => controller }
  }

  const kernel = (): FakeKernel => ({ query: (pid) => (pid === 999 ? RUNNING(999, 999) : { kind: "absent" }), group: () => [] })
  /** The handover word that gives the command back to its supervisor. */
  const handBack = (channel: { readonly address: string; readonly recordPath: string }): CommandHandover => ({ channel: channel.address, recordPath: channel.recordPath, userDataRoot: "/scratch/a/.flywheel" })

  test("finds nothing when nothing serves the channel: the supervisor is gone", async () => {
    const backend = createOwnedProcessBackend(recordingHost(kernel()).posix)

    expect(await backend.reach({ token: TOKEN, pid: 4242, channel: join(temporary("reach-"), "h.sock"), recordPath: "/scratch/none" }, 20)).toBeUndefined()
  })

  test("adopts through the channel, and reads the exit from the record once the channel ends and the container is empty", async () => {
    const channel = supervisorChannel("adopted")
    const recorded = recordingHost(kernel())
    const reached = await createOwnedProcessBackend(recorded.posix).reach({ token: TOKEN, pid: 4242, channel: channel.address, recordPath: channel.recordPath }, 20)

    const adoption = await reached?.adopt(999, 1_000, handBack(channel))

    if (adoption?.kind !== "adopted") throw new Error(`expected an adoption, got ${adoption?.kind}`)
    // The supervisor watches the guardian this side read, not a bare pid.
    expect(channel.heard.map((line) => decodeSupervisorWord(line))).toEqual([{ kind: "adopt", adoption: { guardianPid: 999, guardianIdentity: GUARDIAN_IDENTITY } }])
    adoption.container.stop()
    await until(() => channel.heard.length === 2)
    expect(channel.heard[1]).toBe("stop")
    writeOutcomeRecord(channel.recordPath, { version: 1, handedOverAtMs: 1, outcome: { code: 3, signal: null, deadlineExpired: false, endedAtMs: 2 } })
    channel.end()
    expect(await adoption.container.child.exited).toEqual({ code: 3, signal: null, statusOf: "payload" })
    expect(recorded.calls).toContain("group 4242")
  })

  test("hands an adopted command over again on its channel and closes that channel once acknowledged", async () => {
    const channel = supervisorChannel("adopted")
    const reached = await createOwnedProcessBackend(recordingHost(kernel()).posix).reach({ token: TOKEN, pid: 4242, channel: channel.address, recordPath: channel.recordPath }, 20)
    const adoption = await reached?.adopt(999, 1_000, handBack(channel))
    if (adoption?.kind !== "adopted") throw new Error("expected an adoption")
    const handover = { channel: channel.address, recordPath: channel.recordPath, userDataRoot: "/scratch/a/.flywheel" }

    const [acknowledgement] = await Promise.all([adoption.container.handOver(handover, 1_000), acknowledgeOnceSaid(() => channel.heard, handover)])

    expect(acknowledgement).toBe("acknowledged")
    await channel.controller()?.ended
    channel.end()
  })

  test("reports a supervisor that refused the adopt version, and closes the channel it holds", async () => {
    const channel = supervisorChannel(`refused {"versions":[1]}`)
    const reached = await createOwnedProcessBackend(recordingHost(kernel()).posix).reach({ token: TOKEN, pid: 4242, channel: channel.address, recordPath: channel.recordPath }, 20)

    expect(await reached?.adopt(999, 1_000, handBack(channel))).toEqual({ kind: "refused" })

    // The supervisor's one controller slot is free again for a later owner.
    await channel.controller()?.ended
    channel.end()
  })

  test("reports a supervisor that ended before it answered as gone, and touches nothing of its container", async () => {
    const channel = supervisorChannel("hang up")
    const recorded = recordingHost(kernel())
    const reached = await createOwnedProcessBackend(recorded.posix).reach({ token: TOKEN, pid: 4242, channel: channel.address, recordPath: channel.recordPath }, 20)

    expect(await reached?.adopt(999, 1_000, handBack(channel))).toEqual({ kind: "gone" })
    expect(recorded.calls.filter((call) => call.includes("4242"))).toEqual([])
  })

  test("gives back an adoption the supervisor answered after the bound, so it never watches a guardian that holds no lease of it", async () => {
    const channel = supervisorChannel("late")
    const reached = await createOwnedProcessBackend(recordingHost(kernel()).posix).reach({ token: TOKEN, pid: 4242, channel: channel.address, recordPath: channel.recordPath }, 20)

    await expect(reached?.adopt(999, 5, handBack(channel)) ?? Promise.resolve()).rejects.toThrow()

    await until(() => channel.heard.length === 2)
    expect(decodeSupervisorWord(channel.heard[1] ?? "")).toEqual({ kind: "handover", handover: handBack(channel) })
    await channel.controller()?.ended
    channel.end()
  })

  test("gives an adopted command back with the handover word and closes the channel", async () => {
    const channel = supervisorChannel("adopted")
    const reached = await createOwnedProcessBackend(recordingHost(kernel()).posix).reach({ token: TOKEN, pid: 4242, channel: channel.address, recordPath: channel.recordPath }, 20)
    await reached?.adopt(999, 1_000, handBack(channel))

    reached?.handBack(handBack(channel))

    await until(() => channel.heard.length === 2)
    expect(decodeSupervisorWord(channel.heard[1] ?? "")).toEqual({ kind: "handover", handover: handBack(channel) })
    await channel.controller()?.ended
    channel.end()
  })

  test("refuses to act on a command another owner controls, and touches nothing of it", async () => {
    const channel = supervisorChannel("busy")
    const recorded = recordingHost(kernel())
    const reached = await createOwnedProcessBackend(recorded.posix).reach({ token: TOKEN, pid: 4242, channel: channel.address, recordPath: channel.recordPath }, 20)

    await expect(reached?.adopt(999, 1_000, handBack(channel)) ?? Promise.resolve()).rejects.toThrow(/another owner controls/)
    expect(recorded.calls.filter((call) => call.includes("4242"))).toEqual([])
    channel.end()
  })
})

describe("ending what a handed-over supervisor left", () => {
  const COMMAND = { token: "owned:handed-over", pid: 4242, channel: "/scratch/h0123456789", recordPath: "/scratch/none" }
  const RECORDED = "4242 4242 7"

  test("ends the group a supervisor that is gone left populated, and proves it empty", async () => {
    const member = fakePid(1)
    let members = [member]
    // The supervisor's pid is free; one process it started still runs in its group.
    const recorded = recordingHost({ query: (pid) => (pid === member && members.length > 0 ? RUNNING(member, 4242) : { kind: "absent" }), group: () => members })
    const host: ProcessGroupHost = { ...recorded.posix, signal: (pid, signal) => { recorded.calls.push(`kill ${signal} ${pid}`); members = [] } }

    expect(await createOwnedProcessBackend(host).emptyUnserved(COMMAND, RECORDED, 0)).toBe(true)

    expect(recorded.calls).toContain("kill SIGTERM -4242")
  })

  test("leaves the group of a supervisor that still leads it as it recorded, and proves nothing", async () => {
    const recorded = recordingHost({ query: () => RUNNING(4242, 4242), group: () => [5555] })

    expect(await createOwnedProcessBackend(recorded.posix).emptyUnserved(COMMAND, RECORDED, 0)).toBe(false)
    expect(recorded.calls.filter((call) => call.startsWith("kill"))).toEqual([])
  })

  test("ends nothing, and reports the supervisor's group gone, when its pid now leads a stranger's group or no group", async () => {
    const stranger = recordingHost({ query: () => ({ kind: "process", pgid: 4242, ppid: 1, identity: "4242 4242 8", start: "8" }), group: () => [6666] })
    const member = recordingHost({ query: () => RUNNING(4242, 17), group: () => [6666] })

    expect(await createOwnedProcessBackend(stranger.posix).emptyUnserved(COMMAND, RECORDED, 0)).toBe(true)
    expect(await createOwnedProcessBackend(member.posix).emptyUnserved(COMMAND, RECORDED, 0)).toBe(true)
    expect([...stranger.calls, ...member.calls].filter((call) => call.startsWith("kill"))).toEqual([])
  })

  test("ends nothing and proves nothing for a group whose leader no record names, or whose pid cannot be examined", async () => {
    const unrecorded = recordingHost({ query: () => RUNNING(4242, 4242), group: () => [5555] })
    const unexamined = recordingHost({ query: () => ({ kind: "unavailable" }), group: () => [5555] })

    expect(await createOwnedProcessBackend(unrecorded.posix).emptyUnserved(COMMAND, undefined, 0)).toBe(false)
    expect(await createOwnedProcessBackend(unexamined.posix).emptyUnserved(COMMAND, RECORDED, 0)).toBe(false)
    expect([...unrecorded.calls, ...unexamined.calls].filter((call) => call.startsWith("kill"))).toEqual([])
  })

  test("on Windows, reports a job that no longer opens empty, and closes the handle it opened on one that does", async () => {
    const recorded = recordingHost()
    const backend = createOwnedProcessBackend(recorded.windows)

    expect(await backend.emptyUnserved(COMMAND, undefined, 0)).toBe(true)
    const held = recorded.jobs.api.create(windowsContainerName(COMMAND.token))
    expect(await backend.emptyUnserved(COMMAND, undefined, 0)).toBe(false)

    expect(recorded.jobs.created.get(windowsContainerName(COMMAND.token))).toMatchObject({ handles: 1, closed: false })
    held?.close()
  })
})

async function until(condition: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 2_000; !condition(); await Bun.sleep(1)) {
    if (Date.now() > deadline) throw new Error("condition never held")
  }
}
