import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { ProjectExecutorStartupError, projectExecutorCommand } from "../../../../src/orchestration/app-service/project-executor-client.js"
import { decodeProjectExecutorCommand } from "../../../../src/orchestration/app-service/project-executor-protocol.js"
import type { ExecutorWedgeProof } from "../../../../src/orchestration/app-service/executor-responsiveness.js"
import { createChatDefaultRefreshOwner } from "../../../../src/orchestration/app-service/model-assignment-admission.js"
import type { RuntimeChatDefault } from "../../../../src/protocol/app-service-types.js"
import { createLoginShellPath } from "../../../../src/infra/login-shell-path.js"
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../src/infra/owned-command.js"
import { closeExecutorFixtures, fixture } from "./_project-executor-fixture.js"

afterEach(closeExecutorFixtures)

const turnBlocker = { projectRoot: "/project", projectLabel: "project", sessionId: "s-1", reason: "turn" as const }

test("owned admission precedes readiness and exposes the runtime proxy without owning state", async () => {
  const chatDefaultStarted = Promise.withResolvers<void>()
  const retained = { kind: "model", model: "openai/gpt-5", effort: "medium" as const } satisfies RuntimeChatDefault
  const host = fixture({ chatDefault: retained, chatDefaultStarted: () => chatDefaultStarted.resolve(), stopSuccessorRows: { continuations: 2, handovers: 1 } })
  const client = host.acquire()
  const runtime = await client.ready
  expect(host.observations).toContain("start")
  expect(host.startDefaults).toEqual([retained])
  // Every command the executor launches is held by its own container alone,
  // so the executor's end never ends a command it handed over.
  expect(host.launch()).toEqual({ cwd: "/project/sub", priority: "background", childrenBreakAway: true })
  expect(typeof runtime.query).toBe("function")
  expect(typeof runtime.dispatch).toBe("function")
  await client.startChatDefault()
  await chatDefaultStarted.promise
  expect(host.observations).toContain("start_chat_default")
  // A stop after a planned replacement's cut carries the successor rows the executor counted.
  expect(await client.stop()).toEqual({ settled: true, successorRows: { continuations: 2, handovers: 1 } })
  expect(await client.closed).toMatchObject({ settled: true })
  expect(host.observations).toContain("guardian-close")
  expect(host.observations).not.toContain("worker-close")
  expect(host.observations.filter((item) => item.startsWith("dispose:"))).toHaveLength(4)
})

test("chat default refresh waits for start and coalesces bursts to one trailing resolution", async () => {
  const first = Promise.withResolvers<{ chat: { model: string; effort: "low" } }>()
  const second = Promise.withResolvers<{ chat: { model: string; effort: "high" } }>()
  const replacements = [first.promise, second.promise]
  let resolutions = 0
  const published: RuntimeChatDefault[] = []
  const failures: unknown[] = []
  const owner = createChatDefaultRefreshOwner({
    initial: { kind: "model", model: "openai/gpt-5", effort: "medium" },
    resolve: () => {
      resolutions++
      return replacements.shift()!
    },
    publish: (value) => { published.push(value) },
    onError: (error) => { failures.push(error) },
  })

  await owner.refresh()
  await owner.refresh()
  expect(resolutions).toBe(0)
  owner.start()
  expect(resolutions).toBe(1)
  const older = owner.refresh()
  const newer = owner.refresh()
  expect(resolutions).toBe(1)
  expect(owner.current()).toEqual({ kind: "model", model: "openai/gpt-5", effort: "medium" })
  first.resolve({ chat: { model: "google/gemini-2.5-pro", effort: "low" } })
  await Promise.resolve()
  expect(resolutions).toBe(2)
  second.resolve({ chat: { model: "anthropic/claude-sonnet-4", effort: "high" } })
  await Promise.all([older, newer])

  expect(owner.current()).toEqual({ kind: "model", model: "anthropic/claude-sonnet-4", effort: "high" })
  expect(published).toEqual([{ kind: "model", model: "anthropic/claude-sonnet-4", effort: "high" }])
  expect(failures).toEqual([])
})

test("chat default refresh publishes none instead of tier vocabulary", async () => {
  const published: RuntimeChatDefault[] = []
  const owner = createChatDefaultRefreshOwner({
    initial: { kind: "pending" },
    resolve: async () => ({ chat: { model: "powerful", effort: "high" } }),
    publish: (value) => { published.push(value) },
    onError: () => {},
  })

  owner.start()
  await owner.refresh()

  expect(owner.current()).toEqual({ kind: "none" })
  expect(published).toEqual([{ kind: "none" }])
})

test("chat default refresh does not publish an unchanged assignment", async () => {
  const published: RuntimeChatDefault[] = []
  const owner = createChatDefaultRefreshOwner({
    initial: { kind: "model", model: "openai/gpt-5", effort: "medium" },
    resolve: async () => ({ chat: { model: "openai/gpt-5", effort: "medium" } }),
    publish: (value) => { published.push(value) },
    onError: () => {},
  })

  owner.start()
  await owner.refresh()

  expect(published).toEqual([])
})

test("deferred chat default work starts explicitly and shutdown joins it without late publication", async () => {
  const resolution = Promise.withResolvers<{ chat: { model: string; effort: "medium" } }>()
  const entered = Promise.withResolvers<void>()
  const published: RuntimeChatDefault[] = []
  const owner = createChatDefaultRefreshOwner({
    initial: { kind: "pending" },
    resolve: () => {
      entered.resolve()
      return resolution.promise
    },
    publish: (value) => { published.push(value) },
    onError: () => {},
  })

  expect(published).toEqual([])
  owner.start()
  await entered.promise
  const disposal = owner.dispose()
  resolution.resolve({ chat: { model: "openai/gpt-5", effort: "medium" } })
  await disposal

  expect(published).toEqual([])
  expect(owner.current()).toEqual({ kind: "pending" })
})

test("failed chat default replacement reports the failure and keeps the prior value", async () => {
  const published: RuntimeChatDefault[] = []
  const failures: unknown[] = []
  const owner = createChatDefaultRefreshOwner({
    initial: { kind: "model", model: "openai/gpt-5", effort: "medium" },
    resolve: async () => { throw new Error("catalog unavailable") },
    publish: (value) => { published.push(value) },
    onError: (error) => { failures.push(error) },
  })

  owner.start()
  await owner.refresh()

  expect(owner.current()).toEqual({ kind: "model", model: "openai/gpt-5", effort: "medium" })
  expect(published).toEqual([])
  expect(failures).toHaveLength(1)
})

test("state acquisition failure joins container, guardian and endpoints", async () => {
  const host = fixture({ rejectState: true })
  await expect(host.acquire().ready).rejects.toThrow("state unavailable")
  expect(host.observations).not.toContain("start")
  expect(host.observations).toContain("terminate")
  expect(host.observations).toContain("guardian-close")
  expect(host.observations.filter((item) => item.startsWith("dispose:"))).toHaveLength(4)
})

test("account hard termination does not await executor JavaScript", async () => {
  const host = fixture({ wedged: true })
  const client = host.acquire()
  await client.ready
  expect(await client.terminate("the test ends it")).toEqual({ settled: true, cause: "the test ends it" })
  expect(host.observations).not.toContain("stop")
  expect(await client.terminate("the test ends it")).toEqual({ settled: true, cause: "the test ends it" })
  expect(host.observations.filter((item) => item === "terminate")).toHaveLength(1)
})

test("the replacement state goes down the lifecycle channel and blocker reports come up it", async () => {
  const host = fixture()
  const client = host.acquire()
  await client.ready
  const peer = host.lifecyclePeer()
  if (!peer) throw new Error("expected a lifecycle peer")
  let changes = 0
  client.onBlockersChanged(() => { changes += 1 })

  await client.setReplacement({ kind: "requested", blockers: [] })
  await Bun.sleep(5)
  expect(host.observations).toContain("replacement")
  // A reply to a request is not a change report; an unasked report is.
  const asked = client.blockers()
  await Bun.sleep(5)
  expect(changes).toBe(0)
  expect(await asked).toEqual([])
  await peer.send({ kind: "blockers", blockers: [turnBlocker] })
  await Bun.sleep(5)
  expect(changes).toBe(1)
  await client.stop()
})

test("the account's login shell PATH goes down the lifecycle channel before the start and again when it arrives later", async () => {
  const loginShellPath = createLoginShellPath()
  loginShellPath.adopt("/opt/homebrew/bin:/usr/bin:/bin")
  const host = fixture({ loginShellPath })
  const client = host.acquire()
  await client.ready
  expect(host.loginShellPaths).toEqual(["/opt/homebrew/bin:/usr/bin:/bin"])
  expect(host.observations.indexOf("login_shell_path")).toBeLessThan(host.observations.indexOf("start"))

  loginShellPath.adopt("/usr/local/bin:/usr/bin:/bin")
  await Bun.sleep(5)
  expect(host.loginShellPaths).toEqual(["/opt/homebrew/bin:/usr/bin:/bin", "/usr/local/bin:/usr/bin:/bin"])
  await client.stop()

  // A generation that has ended hears nothing more.
  loginShellPath.adopt("/after/stop")
  await Bun.sleep(5)
  expect(host.loginShellPaths).not.toContain("/after/stop")
})

test("a generation that opens while the login shell PATH is unknown asks the account to probe again and hears the result", async () => {
  // The account's first probe failed. A failure is not kept, so the account
  // probes again at the next lookup, which is the next project that opens.
  let answer: OwnedCommandResult = { exitCode: 1, stdoutBytes: new Uint8Array(), stdout: "", stderr: "", timedOut: false }
  const run: OwnedCommandRunner = async () => answer
  const loginShellPath = createLoginShellPath({ platform: "darwin", log: { warn() {}, info() {}, debug() {} } })
  await loginShellPath.probe(run)
  expect(loginShellPath.current()).toBeUndefined()

  answer = { ...answer, exitCode: 0, stdoutBytes: new TextEncoder().encode("\0PATH=/opt/homebrew/bin:/usr/bin\0") }
  const host = fixture({ loginShellPath })
  const client = host.acquire()
  await client.ready
  await Bun.sleep(5)

  expect(host.loginShellPaths).toEqual(["/opt/homebrew/bin:/usr/bin"])
  await client.stop()
})

test("a lifecycle channel that reattaches is told the login shell PATH again", async () => {
  // A send in flight when the socket drops has an unknown outcome, so the
  // reattach repeats the PATH the account knows.
  const loginShellPath = createLoginShellPath()
  loginShellPath.adopt("/opt/homebrew/bin:/usr/bin:/bin")
  const host = fixture({ loginShellPath, reattachDeadlineMs: 500 })
  const client = host.acquire()
  await client.ready
  expect(host.loginShellPaths).toEqual(["/opt/homebrew/bin:/usr/bin:/bin"])

  await host.dropPeer("lifecycle")
  host.reconnect("lifecycle")
  // A reply on the lifecycle channel proves the reattach has happened.
  expect(await client.blockers()).toEqual([])
  expect(host.loginShellPaths).toEqual(["/opt/homebrew/bin:/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin:/bin"])
  await client.stop()
})

test("reaper status reads the executor and does not infer work from its catalog", async () => {
  const host = fixture()
  const client = host.acquire()
  await client.ready
  expect(await client.blockers()).toEqual([])
  expect(host.observations).toContain("blockers")
  await client.stop()
})

test("a blockers read that misses its bound of 1.5 s answers nothing while the generation has reported no list, and a concurrent read joins it", async () => {
  const host = fixture({ blockersUnanswered: true })
  const client = host.acquire()
  await client.ready
  let settled = false
  const read = client.blockers().finally(() => { settled = true })
  await host.clock.advance(1_000)
  const joined = client.blockers()
  await host.clock.advance(499)
  expect(settled).toBe(false)
  await host.clock.advance(1)
  expect(await read).toBeUndefined()
  expect(await joined).toBeUndefined()
  expect(host.blockersRequests).toHaveLength(1)
  await client.stop()
})

test("an unasked report becomes the latest list, which a later missed read answers", async () => {
  const host = fixture({ blockersUnanswered: true })
  const client = host.acquire()
  await client.ready
  await host.lifecyclePeer()?.send({ kind: "blockers", blockers: [turnBlocker] })
  const read = client.blockers()
  await host.clock.advance(1_500)
  expect(await read).toEqual([turnBlocker])
  await client.stop()
})

test("a late blockers answer becomes the latest list and tells the listeners only when it changed that list", async () => {
  const host = fixture({ blockersUnanswered: true })
  const client = host.acquire()
  await client.ready
  const peer = host.lifecyclePeer()
  if (!peer) throw new Error("expected a lifecycle peer")
  let changes = 0
  client.onBlockersChanged(() => { changes += 1 })
  for (let missed = 0; missed < 3; missed++) {
    const read = client.blockers()
    await host.clock.advance(1_500)
    await read
  }
  // The first changes the list from none, the second repeats it, and the third empties it.
  const lateLists = [[turnBlocker], [turnBlocker], []]
  for (const [index, id] of host.blockersRequests.entries()) await peer.send({ kind: "blockers", id, blockers: lateLists[index]! })
  await host.clock.advance(0)
  expect(changes).toBe(2)
  const read = client.blockers()
  await host.clock.advance(1_500)
  expect(await read).toEqual([])
  await client.stop()
})

test("a wedged Stop ends ownership without claiming a graceful durable flush", async () => {
  const host = fixture({ wedged: true, stopDeadlineMs: 20 })
  const client = host.acquire()
  await client.ready
  const stopping = client.stop()
  await host.clock.advance(20)
  expect(await stopping).toMatchObject({ settled: false, reason: expect.stringContaining("did not flush gracefully") })
  expect(await client.closed).toMatchObject({ settled: true })
})

test("a Stop whose request waits on a detached channel still ends within the one stop deadline", async () => {
  // The executor lives but its lifecycle socket is gone, so the request
  // waits for a reattach that the reattach deadline would allow for a minute.
  const host = fixture({ stopDeadlineMs: 20, reattachDeadlineMs: 60_000 })
  const client = host.acquire()
  await client.ready
  await host.dropPeer("lifecycle")
  const stopping = client.stop()
  await host.clock.advance(20)
  expect(await stopping).toMatchObject({ settled: false, reason: expect.stringContaining("did not flush gracefully") })
})

test("the executor beats in the period the account counts in: thirty silent periods prove it wedged, through a stop too", async () => {
  // The fixture executor sends one heartbeat when its channels are up and none after.
  const host = fixture({ heartbeatIntervalMs: 5 })
  const client = host.acquire()
  await client.ready
  expect(host.initialization()?.heartbeatIntervalMs).toBe(5)
  const proofs: ExecutorWedgeProof[] = []
  client.onWedged((proof) => { proofs.push(proof) })
  // One more heartbeat, which the first check finds.
  await host.lifecyclePeer()?.send({ kind: "heartbeat" })
  await host.clock.advance(5)
  await host.clock.advance(29 * 5)
  expect(proofs).toEqual([])
  await host.clock.advance(5)
  expect(proofs).toEqual([{ missedPeriods: 30, silentMs: 155 }])
  const flushed = Promise.withResolvers<void>()
  const stopping = fixture({ heartbeatIntervalMs: 5, stopAnswer: flushed.promise })
  const flushing = stopping.acquire()
  await flushing.ready
  let wedged = false
  flushing.onWedged(() => { wedged = true })
  const stop = flushing.stop()
  await stopping.clock.advance(40 * 5)
  // The watch counts through a stop. The generations owner, which asked for
  // the stop, ends nothing on this proof: only the stop deadline does.
  expect(wedged).toBe(true)
  flushed.resolve()
  expect(await stop).toEqual({ settled: true })
  await client.stop()
})

test("an executor that dies unasked ends its generation with how it ended, in plain words", async () => {
  const host = fixture()
  const client = host.acquire()
  await client.ready
  host.exit({ code: null, signal: "SIGKILL" })
  expect(await client.closed).toEqual({ settled: true, cause: "stopped by signal SIGKILL" })
})

test.each([
  ["an exit with a code before it is ready", true, { ready: false, end: (host: ReturnType<typeof fixture>) => host.exit({ code: 1, signal: null }) }],
  ["a crash signal after it is ready", true, { ready: true, end: (host: ReturnType<typeof fixture>) => host.exit({ code: null, signal: "SIGSEGV" }) }],
  ["a signal sent from outside", false, { ready: true, end: (host: ReturnType<typeof fixture>) => host.exit({ code: null, signal: "SIGKILL" }) }],
  ["a lost process guardian", false, { ready: true, end: (host: ReturnType<typeof fixture>) => host.guardianLost({ guardianPid: 1, code: 1 }) }],
] as const)("tells the owner whether the executor ended by itself: %s is %p", async (_case, own, { ready, end }) => {
  const host = fixture(ready ? {} : { readyAnswer: new Promise(() => {}) })
  const client = host.acquire()
  if (ready) await client.ready
  else while (!host.observations.includes("start")) await host.clock.advance(0)
  const heard: boolean[] = []
  client.onEnding((_cause, ended) => { heard.push(ended) })
  end(host)
  await client.closed
  expect(heard).toEqual([own])
})

test("a start that the account's admission refuses is not the executor's own end", async () => {
  const admission = Promise.withResolvers<void>()
  const launched = Promise.withResolvers<void>()
  const host = fixture({ admission: admission.promise, launched: () => launched.resolve() })
  const client = host.acquire()
  const heard: Array<readonly [string, boolean]> = []
  client.onEnding((cause, own) => { heard.push([cause, own]) })
  await launched.promise
  admission.reject(new Error("admission refused"))
  await client.closed
  expect(heard).toEqual([["could not start", false]])
})

test("a blockers read the executor could not do answers the latest list at once, a handoff it could not do fails with its reason, and the generation serves on", async () => {
  const host = fixture({ blockersFailure: "session table busy", handoffFailure: "project executor is not ready" })
  const client = host.acquire()
  await client.ready
  await host.lifecyclePeer()?.send({ kind: "blockers", blockers: [turnBlocker] })
  const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
  // The test clock stands still, so no deadline can end these requests.
  expect(await client.blockers()).toEqual([turnBlocker])
  for (const kind of ["interrupt_for_replacement", "continue_after_replacement"] as const) {
    expect(await client.handoff(kind, "handoff-1").catch(reason)).toBe("project executor is not ready")
  }
  expect(host.observations).not.toContain("terminate")
  expect(await client.stop()).toEqual({ settled: true })
})

// Reproduces a platform stop signal: the service asks for Stop in the same
// instant the executor dies, so neither `stopped` nor a reattach ever arrives.
// The executor ends by its stop signal only once its own stop settled, so
// the exit ends the Stop. The test clock stands still, so no deadline can
// settle the Stop.
test("a Stop in flight when the executor exits by a stop signal settles on the exit as the end of that Stop, not on a deadline", async () => {
  const host = fixture({ wedged: true })
  const client = host.acquire()
  await client.ready
  const stopping = client.stop()
  await Bun.sleep(1)
  host.exit(process.platform === "win32" ? { code: 130, signal: null } : { code: null, signal: "SIGTERM" })
  expect(await stopping).toEqual({ settled: true })
  expect(await client.closed).toMatchObject({ settled: true })
})

test("a Stop sent while the dying executor's channels are detached settles on the exit, and an exit by SIGKILL leaves it unsettled", async () => {
  const host = fixture()
  const client = host.acquire()
  await client.ready
  await host.dropPeer("lifecycle")
  const stopping = client.stop()
  await Bun.sleep(1)
  host.exit({ code: null, signal: "SIGKILL" })
  expect(await stopping).toMatchObject({ settled: false, reason: expect.stringContaining("project executor exited with signal SIGKILL") })
  expect(await client.closed).toMatchObject({ settled: true })
})

test("typed runtime startup failure rejects readiness and joins ownership", async () => {
  const host = fixture({ startupFailure: true })
  await expect(host.acquire().ready).rejects.toThrow("composition failed")
  expect(host.observations).toContain("terminate")
  expect(host.observations).toContain("guardian-close")
  expect(host.observations).toContain("state-close")
  expect(host.observations).not.toContain("worker-close")
})

test("a start that keeps sending heartbeats is served however long it waits for ready, and nothing ends it", async () => {
  const answer = Promise.withResolvers<void>()
  const host = fixture({ readyAnswer: answer.promise })
  const client = host.acquire()
  let ending: string | undefined
  client.onEnding((cause) => { ending = cause })
  // One heartbeat each production period, for fifteen of them.
  for (let second = 0; second < 15; second++) {
    await host.clock.advance(1_000)
    await host.lifecyclePeer()?.send({ kind: "heartbeat" })
  }
  answer.resolve()
  await client.ready
  expect(ending).toBeUndefined()
  expect(host.observations).not.toContain("terminate")
  await client.stop()
})

test("a start whose lifecycle channel detaches and is not reattached within the deadline ends as one that could not start", async () => {
  const host = fixture({ readyAnswer: new Promise(() => {}), reattachDeadlineMs: 100 })
  const client = host.acquire()
  let ending: string | undefined
  client.onEnding((cause) => { ending = cause })
  while (!host.observations.includes("start")) await host.clock.advance(0)
  await host.dropPeer("lifecycle")
  await host.clock.advance(99)
  expect(ending).toBeUndefined()
  await host.clock.advance(1)
  expect(ending).toBe("could not start")
  await expect(client.ready).rejects.toThrow("not reattached within 100ms")
})

test("an executor whose channels never authenticate is sent no start, and is proven wedged at the thirtieth period from its launch", async () => {
  const launched = Promise.withResolvers<void>()
  const host = fixture({ wrongCredential: true, heartbeatIntervalMs: 5, launched: () => launched.resolve() })
  const client = host.acquire()
  const proofs: ExecutorWedgeProof[] = []
  client.onWedged((proof) => { proofs.push(proof) })
  await launched.promise
  await host.clock.advance(29 * 5)
  expect(proofs).toEqual([])
  await host.clock.advance(5)
  // Silent for thirty periods from the launch: no heartbeat ever arrived.
  expect(proofs).toEqual([{ missedPeriods: 30, silentMs: 150 }])
  expect(host.observations).not.toContain("start")
  await client.terminate("could not start")
  await expect(client.ready).rejects.toThrow()
})

test("source and packaged commands select the same internal role", () => {
  expect(projectExecutorCommand("/runtime/bun")).toEqual([
    "/runtime/bun", "--conditions=browser", expect.stringContaining(join("scripts", "project-executor.ts")), "--internal-role=project-executor",
  ])
  expect(projectExecutorCommand("C:\\build\\flywheel.exe")).toEqual(["C:\\build\\flywheel.exe", "--internal-role=project-executor"])
  expect(decodeProjectExecutorCommand({ kind: "run", id: 1, sessionId: "s", command: ["sh"] })).toBeUndefined()
})

test("termination owns pending admission and prevents all later acquisition", async () => {
  const admission = Promise.withResolvers<void>()
  const host = fixture({ admission: admission.promise })
  const client = host.acquire()
  let closed = false
  const closing = client.terminate("the test ends it").then((result) => { closed = true; return result })
  await Promise.resolve()
  expect(closed).toBe(false)
  admission.resolve()
  expect(await closing).toEqual({ settled: true, cause: "the test ends it" })
  await expect(client.ready).rejects.toThrow("terminated")
  expect(host.observations).toEqual(["dispose:control"])
  expect(host.launch().cwd).toBeUndefined()
})

test("the executor launches while admission is pending and acts only after it resolves", async () => {
  const admission = Promise.withResolvers<void>()
  const launched = Promise.withResolvers<void>()
  const host = fixture({ admission: admission.promise, launched: () => launched.resolve() })
  const client = host.acquire()
  await launched.promise
  // Let the executor's channels authenticate so the hold is proven past the handshake.
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(host.observations).toEqual(["launch"])
  admission.resolve()
  await client.ready
  const order = host.observations.filter((item) => ["launch", "guardian", "state", "start"].includes(item))
  expect(order).toEqual(["launch", "guardian", "state", "start"])
  await client.stop()
})

test("a rejected admission after launch terminates the executor and rejects readiness", async () => {
  const admission = Promise.withResolvers<void>()
  const launched = Promise.withResolvers<void>()
  const host = fixture({ admission: admission.promise, launched: () => launched.resolve() })
  const client = host.acquire()
  await launched.promise
  admission.reject(new Error("admission refused"))
  const error = await client.ready.catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(ProjectExecutorStartupError)
  if (!(error instanceof ProjectExecutorStartupError)) throw new Error("expected project executor startup error")
  expect(error.message).toBe("admission refused")
  expect(await client.closed).toMatchObject({ settled: true })
  expect(host.observations).toContain("terminate")
  expect(host.observations).not.toContain("guardian")
  expect(host.observations).not.toContain("state")
  expect(host.observations).not.toContain("start")
  expect(host.observations.filter((item) => item.startsWith("dispose:"))).toHaveLength(4)
})

test("a start that cannot write the project's state names that cause", async () => {
  const admission = Promise.withResolvers<void>()
  const launched = Promise.withResolvers<void>()
  const host = fixture({ admission: admission.promise, launched: () => launched.resolve() })
  const client = host.acquire()
  const causes: string[] = []
  client.onEnding((cause) => { causes.push(cause) })
  await launched.promise
  // A start failure crosses from the executor as text, so the cause is read
  // from the message: here a file write that met a full disk.
  admission.reject(new Error("Module definition reconciliation preparation failed: the contained operation cannot open part of its path (code=ENOSPC, errno=28, operation=openat)"))
  await client.ready.catch(() => {})
  await client.closed
  expect(causes).toEqual(["could not write the project's saved state"])
})

test("termination cancels listener readiness without launching the executor", async () => {
  const host = fixture({ listenerReady: new Promise(() => {}) })
  const client = host.acquire()
  await Promise.resolve()
  expect(await client.terminate("the test ends it")).toEqual({ settled: true, cause: "the test ends it" })
  await expect(client.ready).rejects.toThrow("terminated")
  expect(host.observations).toEqual(["dispose:control"])
  expect(host.launch().cwd).toBeUndefined()
})

test("termination joins a guardian acquired after cancellation before settling closed", async () => {
  const admission = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const host = fixture({ guardianAdmission: admission.promise, guardianEntered: () => entered.resolve() })
  const client = host.acquire()
  await entered.promise
  let closed = false
  const closing = client.terminate("the test ends it").then((result) => { closed = true; return result })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(host.observations).toContain("terminate")
  admission.resolve()
  expect(await closing).toEqual({ settled: true, cause: "the test ends it" })
  await expect(client.ready).rejects.toThrow("terminated")
  expect(host.observations).toContain("guardian-close")
  expect(host.observations).not.toContain("state")
  expect(host.observations).not.toContain("start")
})

test("interactive executor enables periodic provider observation and usage monitoring", async () => {
  const source = await Bun.file("src/orchestration/app-service/project-executor-main.ts").text()
  expect(source).toContain("notify, interactive: true,")
})

test("a channel lost while the executor lives is reattached and the generation continues", async () => {
  const host = fixture({ reattachDeadlineMs: 500 })
  const client = host.acquire()
  await client.ready
  let closed = false
  void client.closed.then(() => { closed = true })

  await host.dropPeer("lifecycle")
  await host.clock.advance(499)
  expect(closed).toBe(false)
  expect(host.observations).not.toContain("terminate")

  host.reconnect("lifecycle")
  expect(await client.blockers()).toEqual([])
  // The reattach withdrew the deadline, so passing it ends nothing.
  await host.clock.advance(1)
  expect(closed).toBe(false)

  expect(await client.stop()).toEqual({ settled: true })
  expect(await client.closed).toMatchObject({ settled: true })
})

test("a channel that is not reattached within the deadline ends the generation with its cause", async () => {
  const host = fixture({ reattachDeadlineMs: 30 })
  const client = host.acquire()
  await client.ready

  await host.dropPeer("state")
  await host.clock.advance(30)
  expect(await client.closed).toMatchObject({ settled: true })
  expect(host.observations).toContain("terminate")
})

test("the owner hears a generation begin to end at once, before its closure settles", async () => {
  const host = fixture()
  const client = host.acquire()
  await client.ready
  const heard: string[] = []
  client.onEnding((cause) => { heard.push(cause) })
  const ending = client.terminate("stopped answering, so Flywheel ended it", { silentMs: 31_000 })
  expect(heard).toEqual(["stopped answering, so Flywheel ended it"])
  await ending
  // A listener that arrives late hears the cause at once.
  client.onEnding((cause) => { heard.push(`late: ${cause}`) })
  expect(heard).toEqual(["stopped answering, so Flywheel ended it", "late: stopped answering, so Flywheel ended it"])
})

test("an unsettled closure is proved again on request through the guardian", async () => {
  const host = fixture({ guardianCloses: [{ settled: false, reason: "1 container(s) of gen:x outlived the guardian's kill" }, { settled: true }] })
  const client = host.acquire()
  await client.ready
  host.exit({ code: null, signal: "SIGKILL" })
  expect(await client.closed).toMatchObject({ settled: false, cause: "stopped by signal SIGKILL" })
  expect(await client.settle()).toEqual({ settled: true })
  expect(host.observations.filter((item) => item === "guardian-close")).toHaveLength(2)
  // A proven settlement is final.
  expect(await client.settle()).toEqual({ settled: true })
  expect(host.observations.filter((item) => item === "guardian-close")).toHaveLength(2)
})

test("silence while the lifecycle channel is detached is never read as a wedge", async () => {
  // The fixture executor sends one heartbeat when its channels are up and none after.
  const host = fixture({ heartbeatIntervalMs: 1, reattachDeadlineMs: 1_000 })
  const client = host.acquire()
  await client.ready
  const proofs: ExecutorWedgeProof[] = []
  client.onWedged((proof) => { proofs.push(proof) })
  await host.dropPeer("lifecycle")
  await host.clock.advance(40)
  expect(proofs).toEqual([])
  host.reconnect("lifecycle")
  // A reply on the lifecycle channel proves the reattach has happened.
  expect(await client.blockers()).toEqual([])
  await host.clock.advance(29)
  expect(proofs).toEqual([])
  await host.clock.advance(1)
  // Counted from the reattach, not from the last heartbeat before the detach.
  expect(proofs).toEqual([{ missedPeriods: 30, silentMs: 30 }])
  await client.stop()
})
