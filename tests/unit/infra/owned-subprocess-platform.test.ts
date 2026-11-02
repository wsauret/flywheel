import { describe, expect, test } from "bun:test"

import { commandSupervisorEntry } from "../../../src/infra/command-supervisor-entry.js"
import { createOwnedProcessBackend } from "../../../src/infra/owned-subprocess-backend.js"
import { runInheritedCommand } from "../../../src/infra/inherited-command.js"
import { enableStrictDescendantSettlement, STRICT_DESCENDANT_SETTLEMENT_VARIABLE } from "../../../src/infra/container-mark.js"
import { decodeSupervisorWord } from "../../../src/infra/command-handover.js"
import { parseCommandSupervisorArgv } from "../../../src/infra/owned-command-policy.js"
import { windowsContainerName, windowsControlChannelName } from "../../../src/infra/owned-command-supervisor.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { fakePid } from "../../helpers/fake-pid.js"
import { Log } from "../../../src/infra/log.js"
import type { DebugLogRecordInput } from "../../../src/infra/debug-log.js"
import { acknowledgeOnceSaid, GUARDIAN_IDENTITY, GUARDIAN_KERNEL, handoverTo, POLICY, recordingHost, RUNNING } from "./_owned-subprocess-platform-fixtures.js"

const temporary = temporaryDirectories()

/** The container reference these cases address, on a platform that reads the
 *  pid half of it. */
const REF = { pid: fakePid(0), token: "owned:test" }

/** The process a scripted group listing names besides its leader. */
const MEMBER = fakePid(1)

const GUARDIAN_PROBE = "query 999"

test("inherited commands retain the current container and drain bounded output before returning exit metadata", async () => {
  let drained = false
  let chunk = 0
  const end = Promise.withResolvers<number>()
  const output = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunk++ < 2) controller.enqueue(new TextEncoder().encode("abc"))
      else {
        controller.close()
        drained = true
      }
    },
  })
  let settled = false
  const pending = runInheritedCommand(["/git", "status"], { output: "capture", maxOutputBytes: 3 }, (command, options) => {
    expect(command).toEqual(["/git", "status"])
    expect(options).toEqual({ stdin: "inherit", stdout: "pipe", stderr: "pipe", detached: false, windowsHide: true })
    return { stdout: output, stderr: undefined, exited: end.promise, signalCode: "SIGTERM" }
  })
  void pending.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  end.resolve(143)
  const result = await pending
  expect(drained).toBe(true)
  expect(result).toEqual({ exitCode: 143, signalCode: "SIGTERM", stdout: "abc", stderr: "", stdoutTruncated: true, stderrTruncated: false })
})

test("inherited delegation preserves explicit cwd/env and inherits standard handles", async () => {
  const env = { PATH: "/guard:/bin", OWNED_CONTAINER: "existing" }
  const result = await runInheritedCommand(["/git", "log"], { output: "inherit", cwd: "/repository", env }, (_command, options) => {
    expect(options).toEqual({ cwd: "/repository", env, stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: false, windowsHide: true })
    expect(options.env).toBe(env)
    return { stdout: undefined, stderr: undefined, exited: Promise.resolve(0), signalCode: null }
  })
  expect(result.exitCode).toBe(0)
})

test("inherited delegation reports a signal with no name as the shell's exit code", async () => {
  // Bun reports a Linux real-time signal such as 35 by its number, and its
  // exited promise resolves to 128 and that number.
  const result = await runInheritedCommand(["/git", "log"], { output: "inherit" }, () => ({ stdout: undefined, stderr: undefined, exited: Promise.resolve(163), signalCode: 35 }))
  expect(result).toMatchObject({ exitCode: 163, signalCode: null })
})

describe("payload stdin policy", () => {
  test.each(["posix", "windows"] as const)("carries strict natural-exit settlement through the %s launch", (platform) => {
    const probe = recordingHost(GUARDIAN_KERNEL)
    createOwnedProcessBackend(probe[platform]).launch(["true"], { ...POLICY, onPayloadExit: "end-descendants" })
    expect(parseCommandSupervisorArgv(probe.spawns[0]!.argv)).toMatchObject({ onPayloadExit: "end-descendants" })
  })
  test.each(["posix", "windows"] as const)("does not weaken inherited strict settlement with an explicit %s environment", (platform) => {
    const previous = process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE]
    try {
      enableStrictDescendantSettlement()
      const probe = recordingHost(GUARDIAN_KERNEL)
      createOwnedProcessBackend(probe[platform]).launch(["true"], { ...POLICY, env: { PATH: "/bin" } })
      const spawn = probe.spawns[0]!
      expect(parseCommandSupervisorArgv(spawn.argv)).toMatchObject({ onPayloadExit: "end-descendants" })
      expect(spawn.options.env?.[STRICT_DESCENDANT_SETTLEMENT_VARIABLE]).toBeDefined()
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, STRICT_DESCENDANT_SETTLEMENT_VARIABLE)
      else process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE] = previous
    }
  })
  test.each(["posix", "windows"] as const)("carries EOF stdin through the %s launch while retaining handover", (platform) => {
    const recorded = recordingHost(GUARDIAN_KERNEL)
    createOwnedProcessBackend(recorded[platform]).launch(["grep", "pattern"], { ...POLICY, handover: true, stdin: "ignore" })
    expect(parseCommandSupervisorArgv(recorded.spawns[0]!.argv)).toMatchObject({
      command: ["grep", "pattern"], handover: true, stdin: "ignore",
    })
  })
})

describe("supervisor diagnostics", () => {
  test.each([
    { platform: "posix", strict: false }, { platform: "windows", strict: false },
    { platform: "posix", strict: true }, { platform: "windows", strict: true },
  ] as const)("drains $platform diagnostics before closing control and settling exit (strict: $strict)", async ({ platform, strict }) => {
    let writer!: ReadableStreamDefaultController<Uint8Array>
    const diagnostics = new ReadableStream<Uint8Array>({ start(controller) { writer = controller } })
    const fake = recordingHost(GUARDIAN_KERNEL, { exitCode: 3, diagnostics })
    const backend = createOwnedProcessBackend(fake[platform])
    const observed: string[] = []
    const records: DebugLogRecordInput[] = []
    await Log.init({ level: "DEBUG", forward: (record) => { records.push(record) } })
    try {
    const launch = backend.launch(["payload"], {
      ...POLICY,
      ...(strict ? { onPayloadExit: "end-descendants" as const } : {}),
      diagnostics: { context: { projectId: "project", generation: 1 }, observe: (record) => { observed.push(String(record.payload.message)) } },
    })
    let settled = false
    void launch.child.exited.then(() => { settled = true })
    launch.admit()
    launch.stop()
    await Bun.sleep(1)
    expect(settled).toBe(false)
    expect(fake.calls).not.toContain("close 9")
    if (platform === "windows") expect(fake.closedAfter[0]).toBeInstanceOf(Promise)
    const payload = { service: "process-termination", message: "final record", senderPid: 700, container: 4242, target: "windows job members", signal: "SIGTERM", reason: "stop requested", caller: "original caller" }
    writer.enqueue(new TextEncoder().encode(JSON.stringify({ type: "log.debug", ts: 123, payload }) + "\n"))
    writer.close()
    expect(await launch.child.exited).toMatchObject({ code: 3 })
    expect(observed).toEqual(["final record"])
    expect(records.filter((record) => record.type === "log.debug")).toEqual([
      { type: "log.debug", payload: { ...payload, sourceTs: 123, supervisorPid: 4242, projectId: "project", generation: 1, ...(strict ? { onPayloadExit: "end-descendants" } : {}) } },
    ])
    if (platform === "posix") expect(fake.calls.filter((call) => call === "close 9")).toHaveLength(1)
    else {
      await fake.closedAfter[0]
      expect(fake.closedAfter).toHaveLength(2)
      expect(fake.closedAfter[1]).toBeUndefined()
    }
    } finally {
      await Log.closeGlobal()
    }
  })
})

describe("unix process-group container", () => {
  test("launches the payload under a per-command supervisor in a fresh group", () => {
    const recorded = recordingHost(GUARDIAN_KERNEL)
    const backend = createOwnedProcessBackend(recorded.posix)

    const launch = backend.launch(["node", "server.js"], { ...POLICY, cwd: "/work" })

    expect(recorded.spawns[0]?.argv.at(1)).toMatch(/owned-command-supervisor|--internal-role=command-supervisor/)
    expect(recorded.spawns[0]?.argv).toContain("--guardian-pid")
    // The container watches the guardian this launch was cleared against, not
    // whatever process later holds that pid.
    expect(recorded.spawns[0]?.argv).toContain("--guardian-identity")
    expect(recorded.spawns[0]?.argv).toContain(GUARDIAN_IDENTITY)
    expect(recorded.spawns[0]?.argv).toContain("--background-priority")
    expect(recorded.spawns[0]?.argv.slice(-3)).toEqual(["--", "node", "server.js"])
    expect(recorded.spawns[0]?.options).toMatchObject({ detached: true, control: true, cwd: "/work" })
    // Every process the command starts inherits the launch's mark, which is
    // how ending the command reaches one that left the group.
    expect(recorded.spawns[0]?.options.env?.FLYWHEEL_CONTAINER).toBe(POLICY.token)
    expect(launch.pid).toBe(4242)
    expect(recorded.calls).toEqual([GUARDIAN_PROBE])
  })

  test("asks once, and refuses with the truth when the guardian's identity does not answer", () => {
    // A query that did not answer proves nothing about the guardian, so the
    // refusal may not say it is gone. Nothing is kept, so the next launch asks
    // again and launches once the kernel answers.
    let answers = false
    const recorded = recordingHost({ query: () => (answers ? RUNNING(999, 999) : { kind: "unavailable" }) })
    const backend = createOwnedProcessBackend(recorded.posix)

    expect(() => backend.launch(["sleep", "1"], POLICY)).toThrow(/guardian could not be identified/)
    expect(recorded.calls).toEqual([GUARDIAN_PROBE])
    expect(recorded.spawns).toEqual([])
    answers = true
    expect(backend.launch(["sleep", "1"], POLICY).pid).toBe(4242)
    expect(recorded.spawns[0]?.argv).toContain(GUARDIAN_IDENTITY)
  })

  test("refuses to launch a container no guardian is left to backstop", () => {
    const gone = recordingHost({})

    expect(() => createOwnedProcessBackend(gone.posix).launch(["sleep", "1"], POLICY)).toThrow(/guardian is not running/)
    expect(gone.spawns).toEqual([])
  })

  test("backstops on a guardian that does not lead its own group", () => {
    // The guardian is a backstop, not a container: whether it leads a group
    // says nothing about whether it is alive to keep the promise.
    const led = recordingHost({ query: () => RUNNING(999, 17) })

    const launch = createOwnedProcessBackend(led.posix).launch(["sleep", "1"], POLICY)

    expect(launch.pid).toBe(4242)
    expect(led.spawns[0]?.argv).toContain("999 17 7")
  })

  test("admits the payload only by answering the control channel", () => {
    const recorded = recordingHost(GUARDIAN_KERNEL)
    const backend = createOwnedProcessBackend(recorded.posix)

    backend.launch(["sleep", "1"], POLICY).admit()

    expect(recorded.calls).toEqual([GUARDIAN_PROBE, 'write 9 "go\\n"'])
  })

  test("stopping is one request on the same channel, before or after admission", async () => {
    const refused = recordingHost(GUARDIAN_KERNEL, { groupGone: true })
    const stopped = recordingHost(GUARDIAN_KERNEL, { groupGone: true })

    const pending = createOwnedProcessBackend(refused.posix).launch(["sleep", "1"], POLICY)
    pending.stop()
    const admitted = createOwnedProcessBackend(stopped.posix).launch(["sleep", "1"], POLICY)
    admitted.admit()
    admitted.stop()
    admitted.stop()
    await Promise.all([pending.child.exited, admitted.child.exited])

    // Never a signal from this side: TERM, grace and KILL belong to the
    // container's own supervisor.
    expect(refused.calls).toEqual([GUARDIAN_PROBE, 'write 9 "stop\\n"', "close 9"])
    expect(stopped.calls).toEqual([GUARDIAN_PROBE, 'write 9 "go\\n"', 'write 9 "stop\\n"', "close 9"])
  })

  test("an end at once empties the whole group from this side, with no grace and no wait for the supervisor to run", async () => {
    // The supervisor never runs, so only this side can empty its group.
    const recorded = recordingHost({
      query: (pid) => RUNNING(pid, pid === 999 ? 999 : 4242),
      group: () => (recorded.calls.includes("kill SIGKILL -4242") ? [] : [MEMBER]),
    }, { supervisorRuns: true })
    const launch = createOwnedProcessBackend(recorded.posix).launch(["sleep", "1"], { ...POLICY, killGraceMs: 60_000 })
    launch.admit()

    launch.stop({ reason: "was stopped before it was ready" })
    for (let turn = 0; turn < 50 && !recorded.calls.includes("kill SIGKILL -4242"); turn++) await Bun.sleep(1)

    expect(recorded.calls.filter((call) => call.startsWith("write") || call.startsWith("kill"))).toEqual(['write 9 "go\\n"', 'write 9 "stop\\n"', "kill SIGTERM -4242", "kill SIGKILL -4242"])
    recorded.exitSupervisor()
    await launch.child.exited
  })

  test("closes a settled control descriptor once and never writes after closure", async () => {
    const recorded = recordingHost(GUARDIAN_KERNEL, { groupGone: true })
    const launch = createOwnedProcessBackend(recorded.posix).launch(["sleep", "1"], POLICY)

    launch.stop()
    launch.stop()
    await launch.child.exited
    launch.admit()

    expect(recorded.calls.filter((call) => call === "close 9")).toHaveLength(1)
    expect(recorded.calls.filter((call) => call.startsWith("write 9"))).toEqual(['write 9 "stop\\n"'])
  })

  test("settles a supervisor's exit on a group the kernel no longer holds without listing it", async () => {
    // The common settlement: the supervisor emptied its container before it
    // exited, so one syscall proves it.
    const recorded = recordingHost(GUARDIAN_KERNEL, { groupGone: true })

    // The container was empty at the exit, so the status is the payload's own.
    expect(await createOwnedProcessBackend(recorded.posix).launch(["sleep", "1"], POLICY).child.exited).toEqual({ code: null, signal: null, statusOf: "payload" })

    expect(recorded.calls).toEqual([GUARDIAN_PROBE, "close 9"])
  })

  test("ends a group its supervisor left populated before the exit settles", async () => {
    // A supervisor killed from outside runs no escalation, so its payload is
    // still in the group. The member here ignores TERM, so only the kill this
    // side sends can empty the group the exit waits on.
    const recorded = recordingHost({
      query: (pid) => RUNNING(pid, pid === 999 ? 999 : 4242),
      group: () => (recorded.calls.includes("kill SIGKILL -4242") ? [] : [MEMBER]),
    })

    // The supervisor's exit status is its own death, not the payload's.
    expect((await createOwnedProcessBackend(recorded.posix).launch(["sleep", "1"], { ...POLICY, killGraceMs: 25 }).child.exited).statusOf).toBe("supervisor")

    expect(recorded.calls.filter((call) => call.startsWith("kill"))).toEqual(["kill SIGTERM -4242", "kill SIGKILL -4242"])
  })

  test("addresses the container as a whole group, never the leader alone", () => {
    const recorded = recordingHost({ query: (pid) => RUNNING(pid, REF.pid), group: () => [REF.pid, MEMBER] })
    const backend = createOwnedProcessBackend(recorded.posix)

    const container = backend.container(REF)

    expect(container.populated()).toBe(true)
    container.signal("SIGTERM", { reason: "test" })
    expect(recorded.calls).toEqual([`group ${REF.pid}`, `query ${REF.pid}`, `query ${MEMBER}`, `kill SIGTERM -${REF.pid}`])
  })

  test("reports an empty container when every member is an unreaped exit", () => {
    // The listing still names a process that exited and waits to be reaped. It
    // runs nothing and holds nothing, so a container of them is released.
    const recorded = recordingHost({ group: () => [REF.pid, MEMBER] })

    expect(createOwnedProcessBackend(recorded.posix).container(REF).populated()).toBe(false)
  })

  test("reports an empty container only when the kernel proves nothing is left in the group", () => {
    const recorded = recordingHost({ group: () => [] })

    expect(createOwnedProcessBackend(recorded.posix).container(REF).populated()).toBe(false)
  })

  test("keeps a container owned when the membership listing proves nothing", () => {
    // A listing that did not answer is not evidence of emptiness. An owner
    // that read it as one would hand back a lease over live processes.
    const recorded = recordingHost({ group: () => undefined })

    expect(createOwnedProcessBackend(recorded.posix).container(REF).populated()).toBe(true)
  })

  test("keeps a container owned when a member's query proves nothing", () => {
    const recorded = recordingHost({ query: () => ({ kind: "unavailable" }), group: () => [REF.pid, MEMBER] })

    expect(createOwnedProcessBackend(recorded.posix).container(REF).populated()).toBe(true)
  })

  test("tells a container it leads apart from one it does not, from a pid it holds nothing about", () => {
    const leader = createOwnedProcessBackend(recordingHost({ query: () => RUNNING(REF.pid, REF.pid) }).posix)
    const member = createOwnedProcessBackend(recordingHost({ query: () => RUNNING(REF.pid, 17) }).posix)
    const gone = createOwnedProcessBackend(recordingHost({}).posix)
    const unanswered = createOwnedProcessBackend(recordingHost({ query: () => ({ kind: "unavailable" }) }).posix)

    expect(leader.inspect(REF)).toEqual({ kind: "container", identity: `${REF.pid} ${REF.pid} 7` })
    // A live process at the pid that leads no group proves the container gone.
    expect(member.inspect(REF)).toEqual({ kind: "other" })
    // A pid nobody holds is an absence, and a query that did not answer is
    // not. The guardian may clean up after the first and must not signal on
    // the second.
    expect(gone.inspect(REF)).toEqual({ kind: "absent" })
    expect(unanswered.inspect(REF)).toEqual({ kind: "unproven" })
  })
})

describe("windows job object container", () => {
  const TOKEN = "owned:11111111-2222-3333-4444-555555555555"
  const LAUNCH = { ...POLICY, token: TOKEN }

  test("launches a supervisor that holds the payload, not the payload itself", () => {
    const recorded = recordingHost()
    const backend = createOwnedProcessBackend(recorded.windows)

    backend.launch(["node.exe", "server.js"], LAUNCH)

    const argv = recorded.spawns[0]?.argv ?? []
    // The supervisor's own entry, which is `process.execPath` on Windows. This
    // case simulates Windows on every host, and Linux re-enters through
    // /proc/self/exe.
    expect(argv.at(0)).toBe(commandSupervisorEntry()[0])
    // The container it was put in, and the guardian it depends on, both named
    // at the launch rather than discovered later.
    expect(argv).toContain(`job:${TOKEN}`)
    expect(argv).toContain("--guardian-identity")
    expect(argv).toContain("999|999")
    expect(argv).toContain("--background-priority")
    expect(argv.slice(-3)).toEqual(["--", "node.exe", "server.js"])
    // No inherited descriptor: the control channel is a named pipe, named by
    // the same token as the container.
    expect(recorded.spawns[0]?.options).toMatchObject({ detached: false, control: false })
    expect(recorded.channels).toEqual([windowsControlChannelName(TOKEN)])
  })

  // The runtime puts a child it starts without `detached` in a job of its own
  // that ends its members when this process exits. A launch whose end must
  // outlive this process stays out of that job: one that may be handed over,
  // and one whose stop hold its supervisor must carry past this exit.
  test.each([
    ["may be handed over", { handover: true }],
    ["declares a stop hold", { stopHold: { path: String.raw`C:\scratch\.oauth_refresh.lock`, boundMs: 35_000 } }],
  ] as const)("launches a supervisor that %s outside the job this process keeps for its children", (_name, launch) => {
    const recorded = recordingHost()

    createOwnedProcessBackend(recorded.windows).launch(["node.exe", "server.js"], { ...LAUNCH, ...launch })

    expect(recorded.spawns[0]?.options).toMatchObject({ detached: true, control: false })
    expect(recorded.jobs.order).toContain("admit 4242")
  })

  test("tells the supervisor to run only once ownership is settled", () => {
    const recorded = recordingHost()
    const launch = createOwnedProcessBackend(recorded.windows).launch(["node.exe", "server.js"], LAUNCH)

    // Spawned and contained, and told nothing: this is the moment ownership is
    // being decided, and the payload has not run.
    expect(recorded.said).toEqual([])

    launch.admit()
    launch.admit()

    // One admission however often it is asked for, so a repeated call cannot
    // start a second payload.
    expect(recorded.said).toEqual(["go"])
  })

  test("tells the supervisor to stop instead of admitting it when ownership is refused", () => {
    const recorded = recordingHost()
    const launch = createOwnedProcessBackend(recorded.windows).launch(["node.exe", "server.js"], LAUNCH)

    launch.stop()
    launch.admit()

    // Stopping is final: an admission that arrives afterwards is not obeyed,
    // so a refused launch can never run its payload.
    expect(recorded.said).toEqual(["stop", "<closed>"])
  })

  test("creates the container before the payload, under the launch's own token", () => {
    const recorded = recordingHost()
    createOwnedProcessBackend(recorded.windows).launch(["node.exe", "server.js"], LAUNCH)

    const container = recorded.jobs.created.get(windowsContainerName(TOKEN))
    expect(container).toBeDefined()
    // Created first, so no moment exists where a running process has no
    // container to be ended through.
    expect(recorded.jobs.order).toEqual([`create ${windowsContainerName(TOKEN)}`, "admit 4242"])
    expect(container?.members).toEqual([4242])
  })

  test("refuses a launch whose container could not be created", () => {
    const recorded = recordingHost({}, { refuseCreate: true })

    expect(() => createOwnedProcessBackend(recorded.windows).launch(["node.exe", "x"], LAUNCH))
      .toThrow(/container for this launch could not be created/)
    // Nothing may run unowned, so the payload is never spawned at all.
    expect(recorded.spawns).toEqual([])
  })

  test("refuses to leave a running payload outside its container", () => {
    const recorded = recordingHost({}, { refuseAdmit: true })

    expect(() => createOwnedProcessBackend(recorded.windows).launch(["node.exe", "x"], LAUNCH))
      .toThrow(/may not run unowned/)
    expect(recorded.jobs.created.get(windowsContainerName(TOKEN))?.terminated).toBe(true)
  })

  test("refuses a launch whose guardian is already gone", () => {
    // The container watches the guardian this launch was cleared against, so a
    // guardian proven gone is a container nothing backstops.
    const recorded = recordingHost({}, { rows: [{ pid: 4242, parentPid: 1 }] })

    expect(() => createOwnedProcessBackend(recorded.windows).launch(["node.exe", "x"], LAUNCH))
      .toThrow(/guardian is not running/)
    expect(recorded.spawns).toEqual([])
  })

  test("refuses a launch whose guardian could not be read, without claiming it is gone", () => {
    const recorded = recordingHost({}, { tableUnreadable: true })

    expect(() => createOwnedProcessBackend(recorded.windows).launch(["node.exe", "x"], LAUNCH))
      .toThrow(/guardian could not be identified/)
    expect(recorded.spawns).toEqual([])
  })

  test("ends the container from one call instead of walking a tree", async () => {
    const recorded = recordingHost()

    createOwnedProcessBackend(recorded.windows).launch(["node.exe", "server.js"], LAUNCH).stop()
    await Bun.sleep(10)

    // No taskkill, and no listing: the container is a set the kernel keeps.
    expect(recorded.calls).toEqual([])
    expect(recorded.jobs.created.get(windowsContainerName(TOKEN))?.terminated).toBe(true)
  })

  test("settles a supervisor that was ended before it ever connected to its pipe", async () => {
    // Under load a background supervisor can wait for the processor until
    // its owner ends its job, so it never connects, and only its exit can
    // say that it never will.
    const recorded = recordingHost({}, { neverConnects: true })
    const launch = createOwnedProcessBackend(recorded.windows).launch(["node.exe", "server.js"], LAUNCH)

    launch.stop({ reason: "was stopped before it was ready" })
    const outcome = await Promise.race([launch.child.exited.then(() => "settled"), Bun.sleep(25).then(() => "still waiting")])

    expect(outcome).toBe("settled")
    expect(recorded.jobs.created.get(windowsContainerName(TOKEN))?.terminated).toBe(true)
  })

  test("settles on the container, never on a payload that exited before its descendants", async () => {
    // The payload exits at once; something it started outlives it. Settling on
    // the payload alone would release the container with members still in it.
    const recorded = recordingHost({}, { exitCode: 0, survivor: 4243 })

    const launch = createOwnedProcessBackend(recorded.windows).launch(["node.exe", "server.js"], { ...LAUNCH, killGraceMs: 25 })
    let settled = false
    void launch.child.exited.then(() => { settled = true })

    await Bun.sleep(5)
    expect(settled).toBe(false)

    expect(await launch.child.exited).toEqual({ code: 0, signal: null, statusOf: "supervisor" })

    expect(recorded.jobs.created.get(windowsContainerName(TOKEN))?.terminated).toBe(true)
  })

  test("reaches the container the launch created, by name alone", () => {
    // This is the guardian's position: it holds nothing from the launch and
    // knows only the token.
    const recorded = recordingHost()
    const backend = createOwnedProcessBackend(recorded.windows)
    backend.launch(["node.exe", "server.js"], LAUNCH)

    const ref = { pid: 4242, token: TOKEN }
    expect(backend.inspect(ref)).toEqual({ kind: "container", identity: TOKEN })
    expect(backend.container(ref).populated()).toBe(true)
  })

  test("names an unreachable container an absence, and keeps it owned anyway", () => {
    const recorded = recordingHost()
    const backend = createOwnedProcessBackend(recorded.windows)
    const ref = { pid: 4242, token: "owned:never-created" }

    expect(backend.inspect(ref)).toEqual({ kind: "absent" })
    // A container this side cannot reach is one it proved nothing about, so it
    // is never reported empty.
    expect(backend.container(ref).populated()).toBe(true)
    // A failed open holds nothing, so there is nothing to remember and the next
    // question asks again.
    expect(recorded.jobs.opened).toEqual([
      windowsContainerName("owned:never-created"),
      windowsContainerName("owned:never-created"),
    ])
  })

  test("proves nothing about a container it may not open, and keeps it owned", () => {
    // Access denied is not a container that was never created: it may still
    // hold processes, so the guardian refuses the adoption as unproven rather
    // than as not a container, and never reports it empty.
    const recorded = recordingHost({}, { openFailure: 5 })
    const backend = createOwnedProcessBackend(recorded.windows)
    const ref = { pid: 4242, token: TOKEN }

    expect(backend.inspect(ref)).toEqual({ kind: "unproven" })
    expect(backend.container(ref).populated()).toBe(true)
    // Nothing was opened, so nothing is held and the next question asks again.
    expect(recorded.jobs.opened).toEqual([windowsContainerName(TOKEN), windowsContainerName(TOKEN)])
  })

  test("holds one handle per container, however often it is asked about", () => {
    const recorded = recordingHost()
    const backend = createOwnedProcessBackend(recorded.windows)
    const ref = { pid: 4242, token: TOKEN }
    backend.launch(["node.exe", "server.js"], LAUNCH)

    backend.inspect(ref)
    backend.container(ref).populated()
    backend.inspect(ref)

    // Opening a handle per question would be a correctness bug: the container
    // dies with its last handle, so a probe could be the close that kills it.
    expect(recorded.jobs.opened).toEqual([])
    expect(recorded.jobs.created.get(windowsContainerName(TOKEN))?.closed).toBe(false)
  })

  test("releases the handle it held when the container is forgotten", () => {
    // The supervisor runs on: one that exited would leave a container this
    // side can no longer prove empty, retried for the rest of the process.
    const recorded = recordingHost({}, { supervisorRuns: true })
    const backend = createOwnedProcessBackend(recorded.windows)
    backend.launch(["node.exe", "server.js"], LAUNCH)

    backend.forget({ pid: 4242, token: TOKEN })

    expect(recorded.jobs.created.get(windowsContainerName(TOKEN))?.closed).toBe(true)
    // Forgetting what was never held is not an error.
    expect(() => backend.forget({ pid: 4242, token: "owned:never-held" })).not.toThrow()
  })

  test("hands a supervisor over on its named pipe, and closes its own job handle without ending the job", async () => {
    const recorded = recordingHost({}, { supervisorRuns: true })
    const launch = createOwnedProcessBackend(recorded.windows).launch(["node.exe", "server.js"], { ...LAUNCH, handover: true })
    launch.admit()
    // The supervisor opens the job itself when it starts and holds that
    // handle for its whole life.
    recorded.jobs.api.open(windowsContainerName(TOKEN))
    const handover = handoverTo(temporary("platform-handover-"), String.raw`\\.\pipe\Flywheel.handover.${TOKEN}`)

    const [acknowledgement] = await Promise.all([launch.handOver(handover, 1_000), acknowledgeOnceSaid(() => recorded.said, handover)])

    expect(acknowledgement).toBe("acknowledged")
    expect(recorded.spawns[0]?.argv).toContain("--handover")
    expect(recorded.said.map((word) => decodeSupervisorWord(word))).toEqual([{ kind: "go" }, { kind: "handover", handover }, { kind: "unknown", word: "<closed>" }])
    const job = recorded.jobs.created.get(windowsContainerName(TOKEN))
    // The launcher's handle is gone; the supervisor's still holds the job, so
    // the payload in it runs on.
    expect(recorded.jobs.order.filter((entry) => entry.startsWith("close"))).toEqual([`close ${windowsContainerName(TOKEN)}`])
    expect(job).toMatchObject({ terminated: false, closed: false, handles: 1, members: [4242] })
  })

  test("tells an executor's supervisor to let its job's children leave, and a command's supervisor to keep them", () => {
    const recorded = recordingHost()
    const backend = createOwnedProcessBackend(recorded.windows)

    backend.launch(["flywheel.exe", "--internal-role=project-executor"], { ...LAUNCH, token: "owned:executor", childrenBreakAway: true })
    backend.launch(["cmd.exe", "/c", "build"], { ...LAUNCH, token: "owned:command", handover: true })

    // Both jobs keep their children at creation. A job that already lets
    // them leave would not take the supervisor's payload either, so only the
    // supervisor lets them leave, once its payload runs inside the job.
    expect(recorded.jobs.created.get(windowsContainerName("owned:executor"))?.limits).toEqual({ priority: "background" })
    expect(recorded.jobs.created.get(windowsContainerName("owned:command"))?.limits).toEqual({ priority: "background" })
    expect(recorded.spawns[0]?.argv).toContain("--children-break-away")
    expect(recorded.spawns[1]?.argv).not.toContain("--children-break-away")
  })

  test("keeps a container owned when its membership cannot be read", () => {
    // The supervisor runs on: one that exited would leave a container whose
    // emptiness can never be read, retried for the rest of the process.
    const recorded = recordingHost({}, { unreadableMembership: true, supervisorRuns: true })
    const backend = createOwnedProcessBackend(recorded.windows)
    backend.launch(["node.exe", "server.js"], LAUNCH)

    expect(backend.container({ pid: 4242, token: TOKEN }).populated()).toBe(true)
  })
})
