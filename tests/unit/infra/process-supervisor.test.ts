import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { handoverChannelAddress, writeOutcomeRecord, type CommandHandover } from "../../../src/infra/command-handover.js"
import type { HandoverAcknowledgement } from "../../../src/infra/owned-command-control.js"
import type { OwnedExitStatus, OwnedProcessBackend } from "../../../src/infra/owned-subprocess-backend.js"
import type { OwnedProcess, OwnedProcessExit, OwnershipSettlement } from "../../../src/infra/owned-subprocess.js"
import { createLauncherScope, createProcessSupervisor, type GuardianLease, type ProcessSupervisor } from "../../../src/infra/process-supervisor.js"
import { proveProcessEnded } from "../../../src/infra/prove-process-ended.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporary = temporaryDirectories()

/** No case here adopts through a bare spawn capability. */
const adoptOwned: ProcessSupervisor["adoptOwned"] = () => Promise.reject(new Error("this scope adopts nothing"))

/** A container the test settles by hand, so a close can be observed against a
 *  container that is still running, one that ended cleanly, and one whose
 *  release the guardian never answered. Termination joins the first call, the
 *  way a real container's does. */
interface FakeOwned extends OwnedProcess {
  settle(ownership: OwnershipSettlement): void
}

function fakeOwned(pid: number, terminated: number[]): FakeOwned {
  let settle: (exit: OwnedProcessExit) => void = () => {}
  const exited = new Promise<OwnedProcessExit>((resolve) => { settle = resolve })
  let terminating = false
  return {
    pid,
    token: `owned:${pid}`,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    exited,
    terminate() {
      if (!terminating) {
        terminating = true
        terminated.push(pid)
      }
      return exited
    },
    settle(ownership) {
      settle({ code: 0, signal: null, statusOf: "payload", ownership })
    },
  }
}

function scopeProbe(closeDeadlineMs = 20) {
  const terminated: number[] = []
  const containers: FakeOwned[] = []
  let nextPid = 100
  const scope = createLauncherScope({
    spawnOwned: async () => {
      const owned = fakeOwned(++nextPid, terminated)
      containers.push(owned)
      return await Promise.resolve(owned)
    },
    adoptOwned,
  }, closeDeadlineMs)
  const container = (index: number): FakeOwned => {
    const found = containers[index]
    if (!found) throw new Error(`container ${index} was never launched`)
    return found
  }
  return { scope, terminated, container }
}

test("launcher priority is inherited and cannot be widened by a nested scope", async () => {
  const priorities: Array<string | undefined> = []
  const scope = createLauncherScope({
    spawnOwned: async (_command, options) => {
      priorities.push(options?.priority)
      return fakeOwned(101 + priorities.length, [])
    },
    adoptOwned,
  })
  const background = scope.open({ priority: "background" })

  await background.spawnOwned(["first"])
  await background.open().spawnOwned(["second"])
  await scope.spawnOwned(["control"])

  expect(priorities).toEqual(["background", "background", undefined])
})

describe("launcher scope closure", () => {
  test("proves settlement when it holds nothing", async () => {
    const probe = scopeProbe()

    expect(await probe.scope.close()).toEqual({ settled: true })
  })

  test("reports what it still holds past its deadline, and keeps holding it", async () => {
    const probe = scopeProbe()
    const owned = await probe.scope.spawnOwned(["sleep", "60"])

    expect(await probe.scope.close()).toEqual({
      settled: false,
      reason: expect.stringContaining(String(owned.pid)),
    })
    // Ownership did not end with the deadline: asking again while the container
    // is still running must not turn into a quiet success.
    expect(await probe.scope.close()).toEqual({
      settled: false,
      reason: expect.stringContaining(String(owned.pid)),
    })

    probe.container(0).settle("surrendered")

    expect(await probe.scope.close()).toEqual({ settled: true })
    // One request per container, however many times settlement was asked for.
    expect(probe.terminated).toEqual([owned.pid])
  })

  test("does not prove settlement while a container is still being acquired", async () => {
    const terminated: number[] = []
    let admit: (owned: FakeOwned) => void = () => {}
    const acquiring = new Promise<FakeOwned>((resolve) => { admit = resolve })
    const scope = createLauncherScope({ spawnOwned: () => acquiring, adoptOwned }, 5_000)
    const launching = scope.spawnOwned(["sleep", "60"])
    // The close begins while the container is still starting: it is held by
    // nobody yet, and an answer now would prove a settlement this container is
    // about to break.
    const closing = scope.close()
    let proven = false
    void closing.then(() => { proven = true })

    const owned = fakeOwned(101, terminated)
    admit(owned)
    await Bun.sleep(0)

    expect(terminated).toEqual([101])
    expect(proven).toBe(false)

    owned.settle("surrendered")

    await expect(launching).rejects.toThrow("launcher scope is closed")
    expect(await closing).toEqual({ settled: true })
  })

  test("reports a container that exited without surrendering ownership", async () => {
    const probe = scopeProbe(5_000)
    const owned = await probe.scope.spawnOwned(["true"])
    probe.container(0).settle("unacknowledged")

    expect(await probe.scope.close()).toEqual({
      settled: false,
      reason: expect.stringContaining(String(owned.pid)),
    })
  })

  test("does not prove settlement while a nested scope still holds a container", async () => {
    const probe = scopeProbe()
    const nested = probe.scope.open()
    const owned = await nested.spawnOwned(["sleep", "60"])

    expect(await probe.scope.close()).toEqual({
      settled: false,
      reason: expect.stringContaining(String(owned.pid)),
    })
    // The nested scope is still this scope's, so asking again re-checks it
    // rather than reporting a settlement its child never proved.
    expect(await probe.scope.close()).toEqual({
      settled: false,
      reason: expect.stringContaining(String(owned.pid)),
    })

    probe.container(0).settle("surrendered")

    expect(await probe.scope.close()).toEqual({ settled: true })
  })

  test("forgets a nested scope once that scope proved its own settlement, so a long-lived parent does not accumulate closed scopes", async () => {
    const probe = scopeProbe()
    const nested = probe.scope.open()
    await nested.spawnOwned(["sleep", "60"])
    probe.container(0).settle("surrendered")
    expect(await nested.close()).toEqual({ settled: true })
    let reached = 0
    nested.close = () => { reached += 1; return Promise.resolve({ settled: true }) }

    expect(await probe.scope.close()).toEqual({ settled: true })
    expect(reached).toBe(0)
  })

  test("waits a held container's stop hold beyond the close deadline, also from a parent scope", async () => {
    const probe = scopeProbe(20)
    const stopHold = { path: join(temporary("stop-hold-"), ".oauth_refresh.lock"), boundMs: 200 }
    await probe.scope.open().spawnOwned(["claude"], { stopHold })
    // The container settles past the close deadline but inside the hold.
    setTimeout(() => { probe.container(0).settle("surrendered") }, 60)

    expect(await probe.scope.close()).toEqual({ settled: true })
  })

  test("refuses every later launch from the moment a close begins", async () => {
    const probe = scopeProbe()
    const owned = await probe.scope.spawnOwned(["sleep", "60"])
    const closing = probe.scope.close()

    await expect(probe.scope.spawnOwned(["sleep", "60"])).rejects.toThrow("launcher scope is closed")
    probe.container(0).settle("surrendered")
    expect(await closing).toEqual({ settled: true })
    await expect(probe.scope.spawnOwned(["sleep", "60"])).rejects.toThrow("launcher scope is closed")
    expect(probe.terminated).toEqual([owned.pid])
  })
})

describe("ending a process this supervisor owns", () => {
  test("waits for the kill of an overdue process to land before it answers", async () => {
    const signals: string[] = []
    let exit: () => void = () => {}
    const exited = new Promise<void>((resolve) => { exit = resolve })
    let ended = false
    void exited.then(() => { ended = true })

    const unproven = await proveProcessEnded({
      pid: 101,
      exited,
      kill: (signal) => {
        signals.push(signal)
        setTimeout(exit, 5)
      },
    }, 1, 1_000)

    expect(signals).toEqual(["SIGKILL"])
    // The kill is a request, so the answer waits for the exit it asked for
    // instead of reporting the request as the result.
    expect(ended).toBe(true)
    expect(unproven).toBeUndefined()
  })

  test("reports a process that outlived its kill instead of implying it ended", async () => {
    const signals: string[] = []

    const unproven = await proveProcessEnded({
      pid: 102,
      exited: new Promise<void>(() => {}),
      kill: (signal) => { signals.push(signal) },
    }, 1, 5)

    expect(signals).toEqual(["SIGKILL"])
    expect(unproven).toContain("kill")
  })
})

const USER_DATA_ROOT = "/scratch/a/.flywheel"

describe("handing over an owned command", () => {
  const request = (channel = "/scratch/a/.flywheel/serve/h0123456789") => ({ channel, recordPath: join(temporary("owned-handover-"), "command.outcome.json"), userDataRoot: USER_DATA_ROOT })

  test("offers a handover only to a launch that asked for one", async () => {
    const harness = handoverHarness()

    expect((await harness.scope.spawnOwned(["sleep", "60"])).handOver).toBeUndefined()
    expect((await harness.scope.spawnOwned(["sleep", "60"], { handover: true })).handOver).toBeDefined()
  })

  test("releases the guardian's lease once the supervisor acknowledges, and no scope close reaches the command after", async () => {
    const harness = handoverHarness()
    const owned = await harness.scope.spawnOwned(["sleep", "60"], { handover: true })
    const channel = handoverChannelAddress({ userDataRoot: USER_DATA_ROOT, lane: "dev", token: owned.token })

    expect(await owned.handOver?.(request(channel))).toEqual({ kind: "handed_over" })

    expect(harness.events).toEqual([
      "launch for handover",
      `lease adopt ${owned.token} 101`,
      "admit",
      `handover ${channel}`,
      `lease release ${owned.token}`,
    ])
    expect(await harness.scope.close()).toEqual({ settled: true })
    expect(harness.events).not.toContain("stop 101")
  })

  test("answers the ordinary settlement of a supervisor that exited first", async () => {
    const harness = handoverHarness({ acknowledgement: "exited" })
    const owned = await harness.scope.spawnOwned(["true"], { handover: true })

    expect(await owned.handOver?.(request())).toEqual({ kind: "exited", exit: { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" } })
  })

  test("keeps owning a command whose supervisor never acknowledged", async () => {
    const harness = handoverHarness({ acknowledgement: "unacknowledged" })
    const owned = await harness.scope.spawnOwned(["sleep", "60"], { handover: true })

    expect(await owned.handOver?.(request())).toEqual({ kind: "unacknowledged" })

    expect(harness.events).not.toContain(`lease release ${owned.token}`)
    expect(await harness.scope.close()).toEqual({ settled: true })
    expect(harness.events).toContain("stop 101")
  })
})

/** Containers and a guardian as bookkeeping, in one order of events, so a
 *  handover and an adoption are observed step by step. `acknowledgement` is
 *  what a launch's supervisor makes of the handover word; `served` is what a
 *  handed-over supervisor answers a later owner; `lease` is what the guardian
 *  answers an adoption's lease; `unservedEmpty` is whether a container nothing
 *  serves is proven empty. */
function handoverHarness(script: {
  readonly acknowledgement?: HandoverAcknowledgement
  readonly served?: "nothing" | "adopted" | "refused" | "gone"
  readonly lease?: "adopted" | "token-retired" | "not-a-container" | "silent"
  readonly unservedEmpty?: boolean
} = {}) {
  const events: string[] = []
  const exits: Array<(status: OwnedExitStatus) => void> = []
  const container = (pid: number) => {
    let settle: (status: OwnedExitStatus) => void = () => {}
    const exited = new Promise<OwnedExitStatus>((resolve) => { settle = resolve })
    exits.push(settle)
    return {
      pid,
      child: { stdin: undefined, stdout: undefined, stderr: undefined, exited },
      stop: () => {
        events.push(`stop ${pid}`)
        settle({ code: null, signal: "SIGTERM", statusOf: "payload" })
      },
      handOver: (handover: CommandHandover) => {
        events.push(`handover ${handover.channel}`)
        if (script.acknowledgement === "exited") settle({ code: 0, signal: null, statusOf: "payload" })
        return Promise.resolve(script.acknowledgement ?? "acknowledged")
      },
    }
  }
  const backend: OwnedProcessBackend = {
    launch(_command, options) {
      events.push(options.handover === true ? "launch for handover" : "launch")
      return { ...container(101), admit: () => { events.push("admit") } }
    },
    async reach(command) {
      events.push(`reach ${command.channel}`)
      if (script.served === "nothing") return undefined
      return {
        close: () => { events.push("close channel") },
        handBack: (word) => { events.push(`hand back ${word.channel}`) },
        async adopt(guardianPid) {
          events.push(`adopt word ${guardianPid}`)
          if (script.served === "refused") return { kind: "refused" }
          if (script.served === "gone") return { kind: "gone" }
          return { kind: "adopted", container: container(command.pid) }
        },
      }
    },
    async emptyUnserved(command, identity) {
      events.push(`empty unserved ${command.pid} ${identity ?? "none"}`)
      return script.unservedEmpty !== false
    },
    container: () => ({ signal: () => {}, populated: () => false }),
    ending: () => ({ signal: () => {}, populated: () => false }),
    inspect: () => ({ kind: "absent" }),
    forget: () => {},
  }
  const lease: GuardianLease = {
    request: (command) => {
      events.push(command.kind === "adopt" ? `lease adopt ${command.token} ${command.pid}` : `lease release ${command.token}`)
      if (command.kind === "release") return Promise.resolve({ kind: "released", token: command.token })
      const answer = script.lease ?? "adopted"
      if (answer === "silent") return new Promise(() => {})
      return Promise.resolve(answer === "adopted" ? { kind: "adopted", token: command.token } : { kind: "rejected", reason: answer })
    },
    pid: () => Promise.resolve(4242),
  }
  const supervisor = createProcessSupervisor({ lease, backend, acknowledgeTimeoutMs: 50 })
  return { events, scope: createLauncherScope(supervisor), exit: (index: number, status: OwnedExitStatus) => { exits[index]?.(status) } }
}

test("declares a launch's stop hold to its container and to the guardian's lease", async () => {
  const declared: unknown[] = []
  const stopHold = { path: join(temporary("stop-hold-"), ".oauth_refresh.lock"), boundMs: 35_000 }
  const backend: OwnedProcessBackend = {
    launch(_command, options) {
      declared.push({ launch: options.stopHold })
      let settle: (status: OwnedExitStatus) => void = () => {}
      const exited = new Promise<OwnedExitStatus>((resolve) => { settle = resolve })
      return { pid: 101, child: { stdin: undefined, stdout: undefined, stderr: undefined, exited }, admit: () => {}, stop: () => { settle({ code: 0, signal: null, statusOf: "payload" }) }, handOver: () => Promise.resolve("unacknowledged") }
    },
    reach: () => Promise.resolve(undefined),
    emptyUnserved: () => Promise.resolve(true),
    container: () => ({ signal: () => {}, populated: () => false }),
    ending: () => ({ signal: () => {}, populated: () => false }),
    inspect: () => ({ kind: "absent" }),
    forget: () => {},
  }
  const lease: GuardianLease = {
    request: (command) => {
      if (command.kind === "adopt") declared.push({ lease: command.stopHold })
      return Promise.resolve(command.kind === "adopt" ? { kind: "adopted", token: command.token } : { kind: "released", token: command.token })
    },
    pid: () => Promise.resolve(4242),
  }
  const owned = await createProcessSupervisor({ lease, backend }).spawnOwned(["claude"], { stopHold })
  await owned.terminate()

  expect(declared).toEqual([{ launch: stopHold }, { lease: stopHold }])
})

describe("adopting a handed-over command", () => {
  const TOKEN = "owned:handed-over"
  const reference = (recordPath: string) => ({ token: TOKEN, pid: 7070, channel: "/scratch/a/.flywheel/serve-dev/h0123456789", recordPath, userDataRoot: USER_DATA_ROOT })
  const recordPath = (): string => join(temporary("owned-adoption-"), "command.outcome.json")
  const ended = { version: 1, handedOverAtMs: 1, supervisorIdentity: "7070|1", outcome: { code: 3, signal: null, deadlineExpired: false, endedAtMs: 2 } } as const

  test("answers ended with the record once what the supervisor left is ended, when nothing serves the channel, and never asks the guardian", async () => {
    const harness = handoverHarness({ served: "nothing" })
    const path = recordPath()
    writeOutcomeRecord(path, ended)

    expect(await harness.scope.adoptOwned(reference(path))).toEqual({ kind: "ended", record: { kind: "record", record: ended } })
    expect(harness.events).toEqual([`reach ${reference(path).channel}`, "empty unserved 7070 7070|1"])
  })

  test("fails an adoption, and ends nothing, when a supervisor that may still run does not answer its channel", async () => {
    const harness = handoverHarness({ served: "nothing", unservedEmpty: false })

    await expect(harness.scope.adoptOwned(reference(recordPath()))).rejects.toThrow("may still run")
    expect(harness.events).toEqual([`reach ${reference("").channel}`, "empty unserved 7070 none"])
  })

  test("reports a record this release cannot read as it is, and ends nothing for it, when nothing serves the channel", async () => {
    const harness = handoverHarness({ served: "nothing" })
    const path = recordPath()
    await Bun.write(path, JSON.stringify({ version: 2, handedOverAtMs: 1 }))

    expect(await harness.scope.adoptOwned(reference(path))).toEqual({ kind: "ended", record: { kind: "unreadable", reason: "the record has version 2" } })
    expect(harness.events).toEqual([`reach ${reference(path).channel}`])
  })

  test("tells the supervisor its guardian first, and leases the container only once the supervisor answered", async () => {
    const harness = handoverHarness({ served: "adopted" })
    const ref = reference(recordPath())

    const answer = await harness.scope.adoptOwned(ref)

    if (answer.kind !== "adopted") throw new Error(`expected an adoption, got ${answer.kind}`)
    expect(answer.owned).toMatchObject({ pid: 7070, token: TOKEN })
    expect(harness.events).toEqual([`reach ${ref.channel}`, "adopt word 4242", `lease adopt ${TOKEN} 7070`])
    // The adopting scope holds it like a command it launched: its close ends
    // it, and the lease is released once it has.
    expect(await harness.scope.close()).toEqual({ settled: true })
    expect(harness.events.slice(3)).toEqual(["stop 7070", `lease release ${TOKEN}`])
  })

  test("leaves a supervisor that refused the adopt word alone: no lease, and nothing ended", async () => {
    const harness = handoverHarness({ served: "refused" })
    const ref = reference(recordPath())

    expect(await harness.scope.adoptOwned(ref)).toEqual({ kind: "refused" })
    expect(harness.events).toEqual([`reach ${ref.channel}`, "adopt word 4242"])
  })

  test("gives the command back to its supervisor when the guardian refuses the lease, and releases no other owner's lease", async () => {
    const harness = handoverHarness({ served: "adopted", lease: "token-retired" })
    const ref = reference(recordPath())

    await expect(harness.scope.adoptOwned(ref)).rejects.toThrow("token-retired")
    expect(harness.events).toEqual([`reach ${ref.channel}`, "adopt word 4242", `lease adopt ${TOKEN} 7070`, `hand back ${ref.channel}`])
  })

  test("gives the command back when the lease does not answer in time, and sends the release that compensates a late lease", async () => {
    const harness = handoverHarness({ served: "adopted", lease: "silent" })
    const ref = reference(recordPath())

    await expect(harness.scope.adoptOwned(ref)).rejects.toThrow()
    expect(harness.events).toEqual([`reach ${ref.channel}`, "adopt word 4242", `lease adopt ${TOKEN} 7070`, `hand back ${ref.channel}`, `lease release ${TOKEN}`])
  })

  test("settles a command whose supervisor ended after it answered, once its container settles", async () => {
    const harness = handoverHarness({ served: "adopted", lease: "not-a-container" })
    const path = recordPath()
    writeOutcomeRecord(path, ended)

    const answer = harness.scope.adoptOwned(reference(path))
    await Bun.sleep(1)
    harness.exit(0, { code: 3, signal: null, statusOf: "payload" })

    expect(await answer).toEqual({ kind: "ended", record: { kind: "record", record: ended } })
    expect(harness.events).not.toContain(`hand back ${reference(path).channel}`)
  })

  test("settles a command whose supervisor ended before it answered, once what it left is ended", async () => {
    const harness = handoverHarness({ served: "gone" })
    const path = recordPath()
    writeOutcomeRecord(path, ended)

    expect(await harness.scope.adoptOwned(reference(path))).toEqual({ kind: "ended", record: { kind: "record", record: ended } })
    expect(harness.events).toEqual([`reach ${reference(path).channel}`, "adopt word 4242", "empty unserved 7070 7070|1"])
  })
})
