import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Log } from "../../../src/infra/log.js"
import { privateTemporaryRootName } from "../../../src/infra/private-temporary-root.js"
import { connectOwnedProcessBridge, serveOwnedProcessBridge } from "../../../src/infra/owned-process-bridge.js"
import { ownedProcessBackend, type OwnedProcessBackend } from "../../../src/infra/owned-subprocess-backend.js"
import { watchContainerTerminations } from "../../../src/infra/process-container.js"
import { createProcessDiagnosticReader } from "../../../src/infra/process-diagnostic-reader.js"
import { createLauncherScope, createProcessSupervisor, type ProcessSupervisorOptions } from "../../../src/infra/process-supervisor.js"
import { containerHolds, createRealProcessFixture, FORCED_END, processAlive, type RealProcessFixture, type TaggedProcess } from "../../helpers/real-process-fixture.js"
type AcquisitionPhase = Parameters<NonNullable<ProcessSupervisorOptions["barrier"]>>[0]
import { payloadThatExits, payloadThatRunsForever } from "../../helpers/payload.js"
import { MUTE_GUARDIAN, stubGuardian } from "../../helpers/stub-guardian.js"

const TARGET = fileURLToPath(new URL("../../fixtures/owned-process-target.ts", import.meta.url))
const SUPERVISOR_MODULE = new URL("../../../src/infra/process-supervisor.ts", import.meta.url).href
const GUARDIAN_MODULE = fileURLToPath(new URL("../../../src/infra/process-guardian.ts", import.meta.url))

/** A guardian that reaches readiness and then refuses every adoption. It
 *  proves the barrier without depending on how a real guardian decides. */
const REFUSING_GUARDIAN = stubGuardian(`reply({ kind: "rejected", id: frame.id, reason: "at-capacity" })`)

/** A guardian that acknowledges ownership and then dies, which is a crash of
 *  the one process every owned container depends on. */
const DYING_GUARDIAN = stubGuardian(`reply({ kind: "adopted", id: frame.id, token: frame.token }); setTimeout(() => process.exit(1), 300)`)

/** A guardian that leases nothing and answers nothing, which is what a guardian
 *  that died mid-adoption looks like to the launcher. */
const SILENT_GUARDIAN = stubGuardian("")

/** A guardian whose first process fails before the handshake and whose every
 *  later process behaves, so a supervisor that cached the first failure would
 *  never see the second answer. The first process writes its pid to `marker`,
 *  then does `failure`. */
function guardianThatFailsItsFirstStart(marker: string, failure: string): string {
  return stubGuardian(
    `reply({ kind: "adopted", id: frame.id, token: frame.token })`,
    `if (!(await Bun.file(${JSON.stringify(marker)}).exists())) { await Bun.write(${JSON.stringify(marker)}, String(process.pid)); ${failure} }`,
  )
}

const fixtures: RealProcessFixture[] = []

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

/** How long a barrier, and then the settlement that follows a host's death, is
 *  given. Both are hard bounds: nothing here waits on a duration, so an
 *  overrun is a failure rather than a slow machine. */
const BARRIER_TIMEOUT_MS = 20_000

/** A host that runs the real supervisor, the real guardian and the real
 *  command supervisor, and stalls forever at `phase` once it has written the
 *  evidence that says it arrived there.
 *
 *  The scratch directory travels to the guardian as an argument the guardian
 *  ignores. It is already part of the payload argv, so one unique string finds
 *  every process of this acquisition in the process table. */
function barrierHostSource(phase: AcquisitionPhase, scratch: RealProcessFixture, marker: string): string {
  return [
    `import { createProcessSupervisor } from ${JSON.stringify(SUPERVISOR_MODULE)}`,
    `const dir = ${JSON.stringify(scratch.dir)}`,
    `const supervisor = createProcessSupervisor({`,
    `  guardianCommand: [${JSON.stringify(process.execPath)}, ${JSON.stringify(GUARDIAN_MODULE)}, dir],`,
    `  barrier: async (at) => {`,
    `    if (at !== ${JSON.stringify(phase)}) return`,
    `    await Bun.write(dir + "/reached", at)`,
    `    await new Promise(() => {})`,
    `  },`,
    `})`,
    `await supervisor.spawnOwned([${JSON.stringify(process.execPath)}, ${JSON.stringify(TARGET)}, ${JSON.stringify(marker)}, "--stubborn", "--grandchild"])`,
    `await new Promise(() => {})`,
  ].join("\n")
}

/** Runs a real acquisition up to `phase` and records every identity that
 *  exists there. Independent cleanup is armed for each one before the test
 *  asserts anything, so a failed expectation still ends what was started. */
async function stallAt(
  phase: AcquisitionPhase,
  scratch: RealProcessFixture,
  marker: string,
): Promise<{ readonly host: ReturnType<typeof Bun.spawn>; readonly identities: readonly TaggedProcess[] }> {
  const host = Bun.spawn([process.execPath, "-e", barrierHostSource(phase, scratch, marker)], { stdout: "ignore", stderr: "pipe", windowsHide: true })
  await scratch.waitForFile(scratch.file("reached"), BARRIER_TIMEOUT_MS)
  if (phase === "target-running") {
    // Admission is what this barrier follows; the payload's own marker is what
    // proves it reached exec, and the descendant proves the container holds a
    // member the payload never waits for.
    await scratch.waitForFile(marker, BARRIER_TIMEOUT_MS)
    await scratch.waitForFile(`${marker}.grandchild`, BARRIER_TIMEOUT_MS)
  }
  const identities = scratch.tagged().filter((entry) => entry.pid !== host.pid)
  for (const entry of identities) scratch.guard(entry.pid)
  return { host, identities }
}

/** Kills the host and reports what still carries this fixture's tag once every
 *  recorded identity is gone. */
async function remainsAfterHostKill(
  host: ReturnType<typeof Bun.spawn>,
  scratch: RealProcessFixture,
  identities: readonly TaggedProcess[],
): Promise<readonly TaggedProcess[]> {
  host.kill("SIGKILL")
  await host.exited
  for (const entry of identities) await scratch.waitForGone(entry.pid, BARRIER_TIMEOUT_MS)
  return scratch.tagged().filter((entry) => entry.pid !== host.pid)
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

/** The guardian ledger's records of `token`, in this process's temporary
 *  directory, which every guardian this file starts inherits. */
function leaseRecords(token: string): readonly string[] {
  const root = join(tmpdir(), privateTemporaryRootName("flywheel-leases"))
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith(`${encodeURIComponent(token)}.`)) : []
}

describe("owned subprocess ownership barrier", () => {
  test.skipIf(process.platform === "win32")("establishes background priority before the payload starts", async () => {
    const scratch = fixture("owned-background-priority")
    const marker = scratch.file("priority")
    const supervisor = createProcessSupervisor()
    const scope = createLauncherScope(supervisor).open({ priority: "background" })
    const source = `const result = await Bun.$\`ps -o ni= -p \${process.pid}\`.quiet(); await Bun.write(${JSON.stringify(marker)}, result.text().trim())`

    try {
      const owned = await scope.spawnOwned([process.execPath, "-e", source])
      expect(await owned.exited).toEqual({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" })
      expect(Number(await Bun.file(marker).text())).toBeGreaterThanOrEqual(10)
    } finally {
      await scope.close()
      await supervisor.dispose()
    }
  }, 15_000)

  test("a payload never runs when the guardian refuses ownership", async () => {
    const scratch = fixture("owned-refused")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({
      guardianCommand: [process.execPath, "-e", REFUSING_GUARDIAN],
      acknowledgeTimeoutMs: 4_000,
    })

    try {
      await expect(supervisor.spawnOwned([process.execPath, TARGET, marker])).rejects.toThrow(/refused ownership/)
      // The barrier holds the payload before exec, so the marker cannot appear
      // later either; give the refused container time to prove that.
      await Bun.sleep(300)

      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await supervisor.dispose()
    }
  }, 15_000)

  test("a payload runs inside the container ownership was acknowledged for", async () => {
    const scratch = fixture("owned-admitted")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor()

    try {
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker])
      scratch.guard(owned.pid)
      const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker)))

      // The pid Flywheel owns is the container's, and the payload is a member of
      // it: that is what keeps the owned pid meaningful for the container's whole
      // life rather than only while the payload leads it.
      expect(containerHolds(owned, payloadPid)).toBe(true)
    } finally {
      await supervisor.dispose()
    }
  }, 15_000)
})

describe("eager guardian start", () => {
  test("a guardian started ahead of the first launch is the one that launch leases into", async () => {
    const supervisor = createProcessSupervisor()

    try {
      await supervisor.start()
      const pid = await supervisor.guardian.pid()
      const owned = await supervisor.spawnOwned(payloadThatExits())

      expect(await owned.exited).toEqual({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" })
      expect(await supervisor.guardian.pid()).toBe(pid)
    } finally {
      await supervisor.dispose()
    }
  }, 15_000)

  test("a guardian started for a launch that never came is ended by disposal", async () => {
    const supervisor = createProcessSupervisor()
    await supervisor.start()
    const pid = await supervisor.guardian.pid()
    expect(processAlive(pid)).toBe(true)

    await supervisor.dispose()

    expect(processAlive(pid)).toBe(false)
  }, 15_000)

  // A first guardian that never answers is killed at the handshake deadline,
  // so the kernel reports its exit after the first launch has started a fresh
  // guardian. That exit ends nothing of the guardian that did become ready.
  test.each([
    ["exits before the handshake", "process.exit(1)"],
    ["never answers the handshake", "setInterval(() => {}, 1_000); await new Promise(() => {})"],
  ])("a failed eager start is not cached: the first launch starts a fresh guardian (the first %s)", async (_first, failure) => {
    const scratch = fixture("owned-eager-retry")
    const firstStart = scratch.file("first-start")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({
      acknowledgeTimeoutMs: 4_000,
      guardianCommand: [process.execPath, "-e", guardianThatFailsItsFirstStart(firstStart, failure), firstStart],
    })
    const guardians = (): readonly number[] => scratch.tagged().filter((entry) => entry.command.includes(firstStart)).map((entry) => entry.pid)
    const log = Log.create({ service: "process-supervisor" })
    const warn = spyOn(log, "warn")
    const info = spyOn(log, "info")

    try {
      await expect(supervisor.start()).rejects.toThrow(/never became ready/)

      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker])
      scratch.guard(owned.pid)
      const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
      const pid = await supervisor.guardian.pid()
      await scratch.waitForGone(Number(await Bun.file(firstStart).text()), 15_000)

      expect(processAlive(payloadPid)).toBe(true)
      expect(await supervisor.guardian.pid()).toBe(pid)
      expect(guardians()).toEqual([pid])
      // A guardian that never became ready held nothing and replaced nothing:
      // its failed handshake is the one record of its end.
      expect(warn.mock.calls.filter(([message]) => message === "the process guardian ended; ending the containers it held")).toEqual([])
      const started = info.mock.calls.filter(([message]) => message === "guardian started").map(([, record]) => record)
      expect(started).toEqual([expect.objectContaining({ guardianPid: pid })])
      expect(started.filter((record) => typeof record === "object" && record !== null && "replaces" in record)).toEqual([])
    } finally {
      warn.mockRestore()
      info.mockRestore()
      await supervisor.dispose()
    }
  }, 30_000)
})

describe("owned subprocess crash containment", () => {
  test("a host crash kills a payload tree that ignores SIGTERM", async () => {
    const scratch = fixture("owned-crash")
    const marker = scratch.file("payload-ran")
    const hostSource = [
      `import { createProcessSupervisor } from ${JSON.stringify(SUPERVISOR_MODULE)}`,
      `const supervisor = createProcessSupervisor()`,
      `await supervisor.spawnOwned([${JSON.stringify(process.execPath)}, ${JSON.stringify(TARGET)}, ${JSON.stringify(marker)}, "--stubborn", "--grandchild"])`,
      `await new Promise(() => {})`,
    ].join("\n")

    const host = Bun.spawn([process.execPath, "-e", hostSource], { stdout: "ignore", stderr: "pipe", windowsHide: true })
    const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
    const grandchildPid = scratch.guard(Number(await scratch.waitForFile(`${marker}.grandchild`, 15_000)))

    host.kill("SIGKILL")
    await host.exited
    await scratch.waitForGone(payloadPid, 15_000)
    await scratch.waitForGone(grandchildPid, 15_000)

    expect(processAlive(payloadPid)).toBe(false)
    expect(processAlive(grandchildPid)).toBe(false)
  }, 30_000)

  test("disposal sweeps what is still running and leaves settled containers alone", async () => {
    const scratch = fixture("owned-dispose")
    const supervisor = createProcessSupervisor()

    const settled = await supervisor.spawnOwned(payloadThatExits())
    const running = await supervisor.spawnOwned(payloadThatRunsForever())
    scratch.guard(running.pid)

    // Ownership is surrendered as part of the exit settlement, so by the time
    // this resolves the guardian no longer holds the settled container.
    expect(await settled.exited).toEqual({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" })

    await supervisor.dispose()
    await scratch.waitForGone(running.pid, 15_000)

    expect(processAlive(running.pid)).toBe(false)
  }, 30_000)

  test("a guardian that dies after acknowledging ownership takes the container with it", async () => {
    const scratch = fixture("owned-guardian-crash")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({ killGraceMs: 200, acknowledgeTimeoutMs: 4_000, guardianCommand: [process.execPath, "-e", DYING_GUARDIAN] })
    const events: unknown[] = []

    try {
      const guardianPid = await supervisor.guardian.pid()
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker, "--stubborn", "--grandchild"], { onGuardianLost: (loss) => { events.push(loss) } })
      void owned.exited.then(() => { events.push("container exited") })
      scratch.guard(owned.pid)
      const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
      const grandchildPid = scratch.guard(Number(await scratch.waitForFile(`${marker}.grandchild`, 15_000)))

      // Nothing else is asked to act: the guardian's death alone must end what
      // it was the backstop for, payload and descendant alike.
      await scratch.waitForGone(payloadPid, 20_000)
      await scratch.waitForGone(grandchildPid, 20_000)
      await owned.exited

      expect(processAlive(payloadPid)).toBe(false)
      expect(processAlive(grandchildPid)).toBe(false)
      // The launch's owner hears of the loss once, with the kernel's report of
      // the guardian's exit, before its container ends. The stub's channel
      // closes as it exits, so whether that failure came first is timing.
      expect(events).toEqual([expect.objectContaining({ guardianPid, code: 1 }), "container exited"])
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)

  test("a guardian that dies ends its leases, so what it held settles without its answer", async () => {
    const scratch = fixture("owned-guardian-ended-leases")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({ killGraceMs: 200, acknowledgeTimeoutMs: 4_000, guardianCommand: [process.execPath, "-e", DYING_GUARDIAN] })

    try {
      const generation = await supervisor.guardian.openGeneration()
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker, "--stubborn"])
      scratch.guard(owned.pid)

      // The container ends itself when the guardian dies. Nothing is left on
      // a kill list that died with the guardian, so the container's ownership
      // and the guardian's generation are both settled.
      expect((await owned.exited).ownership).toBe("surrendered")
      expect(await generation.close()).toEqual({ settled: true })
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)

  test("a guardian that is killed is replaced at the next launch", async () => {
    const scratch = fixture("owned-guardian-replaced")
    const first = scratch.file("first-payload")
    const second = scratch.file("second-payload")
    const supervisor = createProcessSupervisor({ killGraceMs: 200 })
    const log = Log.create({ service: "process-supervisor" })
    const warn = spyOn(log, "warn")
    const info = spyOn(log, "info")
    const guardians: number[] = []
    let disposed: unknown[] = []

    try {
      const killed = await supervisor.spawnOwned([process.execPath, TARGET, first])
      scratch.guard(killed.pid)
      const firstPayload = scratch.guard(Number(await scratch.waitForFile(first, 15_000)))
      const dead = scratch.guard(await supervisor.guardian.pid())
      guardians.push(dead)
      // The guardian recorded the lease before it answered the adoption, on
      // every platform that keeps a ledger.
      expect(leaseRecords(killed.token)).toEqual(process.platform === "win32" ? [] : [`${encodeURIComponent(killed.token)}.${dead}.json`])
      process.kill(dead, "SIGKILL")

      // The guardian's exit ended its leases, so what it held settles without
      // its answer, and nothing is left running. The release met the
      // guardian's end, so the host removed the record in its place.
      expect((await killed.exited).ownership).toBe("surrendered")
      await scratch.waitForGone(firstPayload, 15_000)
      expect(leaseRecords(killed.token)).toEqual([])

      // No restart of the host: the next launch starts a new guardian.
      const replacing = await supervisor.spawnOwned([process.execPath, TARGET, second])
      scratch.guard(replacing.pid)
      scratch.guard(Number(await scratch.waitForFile(second, 15_000)))
      const replacement = scratch.guard(await supervisor.guardian.pid())
      guardians.push(replacement)
      await supervisor.guardian.openGeneration()

      expect(replacement).not.toBe(dead)
      expect(warn.mock.calls.filter(([message]) => message === "the process guardian ended; ending the containers it held"))
        .toEqual([["the process guardian ended; ending the containers it held", expect.objectContaining({
          guardianPid: dead,
          // The kernel names the signal on POSIX; Windows has none and reports
          // the exit code of the forced end.
          ...(FORCED_END.signal === null ? { code: FORCED_END.code } : { signal: FORCED_END.signal }),
          containers: 1,
        })]])
      expect(info.mock.calls).toContainEqual(["guardian started", expect.objectContaining({ guardianPid: replacement, replaces: dead })])
    } finally {
      await supervisor.dispose()
      disposed = info.mock.calls.filter(([message]) => message === "the process guardian ended; ending the containers it held").map(([, record]) => record)
      warn.mockRestore()
      info.mockRestore()
    }
    expect(guardians.filter(processAlive)).toEqual([])
    // Disposal asked for the replacement's exit, and its channel ended only
    // because the guardian did, so the record names no channel failure.
    expect(disposed).toEqual([expect.objectContaining({ guardianPid: guardians[1] })])
    expect(disposed.filter((record) => typeof record === "object" && record !== null && "channel" in record)).toEqual([])
  }, 30_000)

  test("a launch through a Worker's bridge after the guardian is killed runs in the guardian that replaced it", async () => {
    const scratch = fixture("owned-guardian-bridged")
    const first = scratch.file("first-payload")
    const second = scratch.file("second-payload")
    const supervisor = createProcessSupervisor({ killGraceMs: 200 })
    // Both ends of one bridge that lives as long as the host, as the account's
    // maintenance Worker's does. The port stands in for that thread.
    const ports = new MessageChannel()
    const bridge = serveOwnedProcessBridge({ port: ports.port1, guardian: supervisor.guardian })
    const scope = connectOwnedProcessBridge({ port: ports.port2 }).launcher

    try {
      const killed = await scope.spawnOwned([process.execPath, TARGET, first])
      scratch.guard(killed.pid)
      const firstPayload = scratch.guard(Number(await scratch.waitForFile(first, 15_000)))
      const dead = scratch.guard(await supervisor.guardian.pid())
      process.kill(dead, "SIGKILL")
      await scratch.waitForGone(firstPayload, 15_000)

      const replacing = await scope.spawnOwned([process.execPath, TARGET, second])
      scratch.guard(replacing.pid)
      const secondPayload = scratch.guard(Number(await scratch.waitForFile(second, 15_000)))
      const replacement = scratch.guard(await supervisor.guardian.pid())

      expect(replacement).not.toBe(dead)
      expect(processAlive(secondPayload)).toBe(true)
    } finally {
      await bridge.close()
      await supervisor.dispose()
    }
  }, 30_000)

  test("a guardian that stops answering but lives holds its leases until its exit ends them", async () => {
    const scratch = fixture("owned-guardian-mute")
    const marker = scratch.file("payload-ran")
    const launchedFor: number[] = []
    const backend: OwnedProcessBackend = {
      ...ownedProcessBackend,
      launch: (command, options) => {
        launchedFor.push(options.guardianPid)
        return ownedProcessBackend.launch(command, options)
      },
    }
    const supervisor = createProcessSupervisor({ killGraceMs: 200, acknowledgeTimeoutMs: 4_000, backend, guardianCommand: [process.execPath, "-e", MUTE_GUARDIAN] })
    const log = Log.create({ service: "process-supervisor" })
    const info = spyOn(log, "info")

    try {
      const muted = await supervisor.guardian.pid()
      const generation = await supervisor.guardian.openGeneration()
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker])
      scratch.guard(owned.pid)
      const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
      // The channel ends 300 ms after the adoption, and the guardian lives one
      // second past that.
      await Bun.sleep(800)

      expect(processAlive(muted)).toBe(true)
      expect(processAlive(payloadPid)).toBe(true)
      // A launch meanwhile refuses with the channel's reason before any
      // container comes to depend on the guardian that is being ended.
      await expect(supervisor.spawnOwned(payloadThatRunsForever())).rejects.toThrow("guardian control channel ended")
      expect(launchedFor).toEqual([muted])

      // The guardian's exit ended its leases, so what it held settles without
      // its answer.
      expect((await owned.exited).ownership).toBe("surrendered")
      expect(await generation.close()).toEqual({ settled: true })
      expect(info.mock.calls).toContainEqual(["guardian generation closed", expect.objectContaining({ settled: true, guardianExited: true })])

      const next = await supervisor.spawnOwned(payloadThatRunsForever())
      scratch.guard(next.pid)
      expect(await supervisor.guardian.pid()).not.toBe(muted)
    } finally {
      info.mockRestore()
      await supervisor.dispose()
    }
  }, 30_000)

  test("a container ends itself when the guardian it depends on dies, with no launcher acting", async () => {
    const scratch = fixture("owned-guardian-watch")
    const marker = scratch.file("payload-ran")
    const guardian = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore", windowsHide: true })
    scratch.guard(guardian.pid)
    let terminations: ReturnType<typeof watchContainerTerminations> | undefined
    // Launched straight through the backend: no launcher-side supervisor exists
    // to notice anything, so only the container's own watch can act.
    const launch = ownedProcessBackend.launch(
      [process.execPath, TARGET, marker, "--stubborn", "--grandchild"],
      {
        killGraceMs: 300,
        guardianPid: guardian.pid,
        token: `owned:test-${crypto.randomUUID()}`,
        diagnostics: {
          observe(record, pid) {
            terminations ??= watchContainerTerminations(pid)
            terminations.read(record.payload)
          },
        },
      },
    )
    scratch.guard(launch.pid)
    // The private return carries supervisor decisions; stderr remains payload output.
    const decisions = terminations ?? watchContainerTerminations(launch.pid)
    terminations = decisions
    const read = createProcessDiagnosticReader((_text, record) => { if (record) decisions.read(record.payload) })
    const decoder = new TextDecoder()
    const drained = launch.child.stderr?.pipeTo(new WritableStream({
      write(bytes) { read(decoder.decode(bytes, { stream: true })) },
      close() { read(`${decoder.decode()}\n`) },
    }))
    try {
      launch.admit()
      const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
      const grandchildPid = scratch.guard(Number(await scratch.waitForFile(`${marker}.grandchild`, 15_000)))

      guardian.kill("SIGKILL")
      await guardian.exited
      await scratch.waitForGone(payloadPid, 20_000)
      await scratch.waitForGone(grandchildPid, 20_000)
      await launch.child.exited
      await drained

      expect(processAlive(payloadPid)).toBe(false)
      expect(processAlive(grandchildPid)).toBe(false)
      // The decision names the guardian proof that began the end, with the
      // guardian it proved gone.
      const decision = decisions.last()
      expect(decision?.reason).toMatch(/^guardian (exited|pid is free)$/)
      expect(decision?.evidence?.guardianPid).toBe(guardian.pid)
    } finally {
      decisions.dispose()
    }
  }, 30_000)

  test("a guardian that dies during the handshake never lets the payload run", async () => {
    const scratch = fixture("owned-guardian-silent")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({ acknowledgeTimeoutMs: 500, guardianCommand: [process.execPath, "-e", SILENT_GUARDIAN] })

    try {
      await expect(supervisor.spawnOwned([process.execPath, TARGET, marker])).rejects.toThrow()
      await Bun.sleep(500)

      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)
})

describe("owned subprocess acquisition barriers", () => {
  test("a host killed before it connects to the guardian leaves no acquisition behind", async () => {
    const scratch = fixture("owned-barrier-connect")
    const marker = scratch.file("payload-ran")
    const { host, identities } = await stallAt("before-guardian-connect", scratch, marker)

    expect(identities).toEqual([])
    expect(await Bun.file(marker).exists()).toBe(false)

    expect(await remainsAfterHostKill(host, scratch, identities)).toEqual([])
    expect(await Bun.file(marker).exists()).toBe(false)
  }, 60_000)

  test("a host killed after the guardian handshake leaves no guardian behind", async () => {
    const scratch = fixture("owned-barrier-lease")
    const marker = scratch.file("payload-ran")
    const { host, identities } = await stallAt("guardian-ready", scratch, marker)

    // The channel is authenticated and this host's generation is open, and
    // nothing else exists yet: one guardian, no container, and a payload that
    // has not been launched at all.
    expect(identities.map((entry) => entry.command.includes("process-guardian.ts"))).toEqual([true])
    expect(await Bun.file(marker).exists()).toBe(false)

    expect(await remainsAfterHostKill(host, scratch, identities)).toEqual([])
    expect(await Bun.file(marker).exists()).toBe(false)
  }, 60_000)

  test("a host killed after the lease is acknowledged but before admission never runs the payload", async () => {
    const scratch = fixture("owned-barrier-acknowledged")
    const marker = scratch.file("payload-ran")
    const { host, identities } = await stallAt("lease-acknowledged", scratch, marker)

    // The guardian owns this container, and the payload is still held before
    // exec: the one moment where ownership exists and the payload does not.
    expect(identities.length).toBe(2)
    expect(identities.some((entry) => entry.command.includes("owned-command-supervisor.ts"))).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(false)

    expect(await remainsAfterHostKill(host, scratch, identities)).toEqual([])
    expect(await Bun.file(marker).exists()).toBe(false)
  }, 60_000)

  test("a host killed after the container is launched but before ownership is acknowledged never runs the payload", async () => {
    const scratch = fixture("owned-barrier-launched")
    const marker = scratch.file("payload-ran")
    const { host, identities } = await stallAt("container-launched", scratch, marker)

    expect(identities.length).toBe(2)
    expect(identities.some((entry) => entry.command.includes("process-guardian.ts"))).toBe(true)
    expect(identities.some((entry) => entry.command.includes("owned-command-supervisor.ts"))).toBe(true)
    // The container exists, but its payload is still held before exec.
    expect(await Bun.file(marker).exists()).toBe(false)

    expect(await remainsAfterHostKill(host, scratch, identities)).toEqual([])
    expect(await Bun.file(marker).exists()).toBe(false)
  }, 60_000)

  test("a host killed after the payload is running leaves no container or descendant behind", async () => {
    const scratch = fixture("owned-barrier-running")
    const marker = scratch.file("payload-ran")
    const { host, identities } = await stallAt("target-running", scratch, marker)

    // Guardian, container supervisor, payload and the descendant the payload
    // started: everything an acknowledged acquisition holds.
    expect(identities.length).toBe(4)
    expect(await Bun.file(marker).exists()).toBe(true)

    expect(await remainsAfterHostKill(host, scratch, identities)).toEqual([])
  }, 60_000)
})
