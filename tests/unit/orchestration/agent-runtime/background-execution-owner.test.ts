import { describe, expect, it, jest } from "bun:test"
import { existsSync } from "node:fs"
import { Effect } from "effect"

import { handoverChannelAddress } from "../../../../src/infra/command-handover"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter } from "../../../../src/infra/event-store-types"
import type { OwnedProcess } from "../../../../src/infra/owned-subprocess"
import type { HandedOverCommand } from "../../../../src/infra/owned-command-control"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner"
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work"
import { bridgeExternalPromise } from "../../../../src/orchestration/agent-runtime/external-promise-bridge"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND, commandHandoversOfAsync, retireCommandHandover, type CommandCompletion, type CommandHandoverRow } from "../../../../src/orchestration/session/command-handover"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import type { PrivateCopy } from "../../../../src/orchestration/agent-runtime/tools/shell-runtime-types"
import { temporaryDirectories } from "../../../helpers/directories"
import { fakeContainer, HANDOFF, handedOverRow, handoverAuthority, USER_DATA_ROOT, type AdoptionAnswer } from "./_command-handover-fixtures"
import { makeMockOps } from "./tools/_bash-fixtures"

/** The production launch shape: the dispatch owns its external Promise, so the
 *  owner's close awaits that Promise and not merely the fiber that started it. */
function dispatch<A>(start: (signal: AbortSignal) => Promise<A>): (signal: AbortSignal) => Effect.Effect<A> {
  return (ownerSignal) => bridgeExternalPromise<A>((stopSignal) => start(anyOf(ownerSignal, stopSignal))).owned
}

function anyOf(first: AbortSignal, second: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const forward = (): void => { controller.abort() }
  if (first.aborted || second.aborted) forward()
  first.addEventListener("abort", forward, { once: true })
  second.addEventListener("abort", forward, { once: true })
  return controller.signal
}

function trackedOwner(kind: "chat" | "workflow" = "chat") {
  const notifications: string[] = []
  const owner = createBackgroundExecutionOwner(kind === "chat"
    ? createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => { notifications.push(text) } })
    : createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: (text) => { notifications.push(text) } }))
  return { owner, notifications }
}

describe("BackgroundExecutionOwner", () => {
  it("fires the signal, kills tracked work, and resolves only once the work settles", async () => {
    const { owner } = trackedOwner()
    const observed: string[] = []
    const task = Promise.withResolvers<BackgroundWorkResult>()
    owner.tasks.track({
      done: task.promise,
      meta: { id: "task-1", type: "subagent", description: "dispatched work" },
      kill: { run: () => { observed.push(`kill:${owner.signal.aborted}`) } },
    })

    let closed = false
    const closing = owner.close().then(() => { closed = true })
    await Bun.sleep(1)

    // The blanket signal fires before the per-task kill, so work still being
    // constructed when close lands sees an aborted signal.
    expect(observed).toEqual(["kill:true"])
    expect(closed).toBe(false)

    task.resolve({ status: "failed", content: "terminated" })
    await closing
    expect(closed).toBe(true)
  })

  it("is idempotent: repeated close awaits the same settlement and kills once", async () => {
    const { owner } = trackedOwner()
    const kills: string[] = []
    const task = Promise.withResolvers<BackgroundWorkResult>()
    owner.tasks.track({
      done: task.promise,
      meta: { id: "task-1", type: "background_command", description: "tail -f", toolUseId: "toolu_1" },
      kill: { run: () => { kills.push("task-1") } },
    })

    const first = owner.close()
    const second = owner.close()
    // The kill lands once close reaches the registry, after it has drained the
    // dispatches it admitted; the work settles in response.
    await Bun.sleep(1)
    task.resolve({ status: "completed", content: "done" })
    await Promise.all([first, second])

    expect(kills).toEqual(["task-1"])
    await owner.close()
    expect(kills).toEqual(["task-1"])
  })

  it("drains registered settles after the registry, in registration order", async () => {
    const { owner } = trackedOwner()
    const order: string[] = []
    const task = Promise.withResolvers<BackgroundWorkResult>()
    owner.tasks.track({
      done: task.promise.then((result) => { order.push("registry"); return result }),
      meta: { id: "task-1", type: "subagent", description: "dispatched work" },
    })
    owner.addSettle(async () => { order.push("first settle") })
    owner.addSettle(async () => { order.push("second settle") })

    const closing = owner.close()
    task.resolve({ status: "completed", content: "done" })
    await closing

    expect(order).toEqual(["registry", "first settle", "second settle"])
  })

  it("drains the remaining settles when one of them rejects", async () => {
    const { owner } = trackedOwner()
    const order: string[] = []
    owner.addSettle(async () => { throw new Error("review fork failed") })
    owner.addSettle(async () => { order.push("still drained") })

    await owner.close()

    expect(order).toEqual(["still drained"])
  })

  it("rejects registration after close, because a closed owner drains nothing more", async () => {
    const { owner } = trackedOwner()
    await owner.close()

    expect(() => owner.addSettle(async () => {})).toThrow("background execution owner is closed")
  })

  it("suppresses notifications for work the close terminated", async () => {
    const { owner, notifications } = trackedOwner()
    const task = Promise.withResolvers<BackgroundWorkResult>()
    owner.tasks.track({
      done: task.promise,
      meta: { id: "task-1", type: "subagent", description: "dispatched work" },
    })

    const closing = owner.close()
    task.resolve({ status: "completed", content: "done" })
    await closing

    expect(notifications).toEqual([])
  })

  it("awaits a dispatch still queued behind the admission gate and stops admitting once closed", async () => {
    const { owner } = trackedOwner()
    const gate = Promise.withResolvers<void>()
    let executed = false

    const dispatched = owner.run(dispatch(async (signal) => {
      // Stands in for the admission gate (ARCH-TOOLS-004): the dispatch is admitted but
      // has not started any external work yet.
      await gate.promise
      if (signal.aborted) return "refused"
      executed = true
      return "executed"
    }))
    expect(dispatched).not.toBeNull()

    let closed = false
    const closing = owner.close().then(() => { closed = true })
    await Bun.sleep(1)
    expect(closed).toBe(false)

    gate.resolve()
    await closing

    expect(closed).toBe(true)
    expect(executed).toBe(false)

    // A closed owner drains nothing more, so it admits nothing more either.
    expect(owner.run(() => Effect.succeed("late"))).toBeNull()
  })

  it("terminates a subagent task a queued dispatch registers on its way out of the closing gate", async () => {
    const { owner, notifications } = trackedOwner()
    const gate = Promise.withResolvers<void>()
    const task = Promise.withResolvers<BackgroundWorkResult>()
    let killed = false
    let taskSettled = false
    void task.promise.then(() => { taskSettled = true })

    // The real launch shape of a subagent or workflow dispatch: it clears the
    // admission gate first and only then registers the long-running task. A
    // close that snapshots the registry before draining this dispatch would
    // leave that task running with nothing left to own it.
    const dispatched = owner.run(dispatch(async () => {
      await gate.promise
      owner.tasks.track({
        done: task.promise,
        meta: { id: "task-late", type: "subagent", description: "deferred launch", toolUseId: "toolu_late" },
        // Terminating this task is not instant, so a close that stops awaiting
        // the registry before draining its dispatches would resolve too early.
        kill: { run: () => { killed = true; void Bun.sleep(2).then(() => { task.resolve({ status: "failed", content: "terminated" }) }) } },
      })
      return "dispatched"
    }))
    expect(dispatched).not.toBeNull()

    let closed = false
    const closing = owner.close().then(() => { closed = true })
    await Bun.sleep(1)
    expect(closed).toBe(false)

    gate.resolve()
    await closing

    expect(closed).toBe(true)
    expect(killed).toBe(true)
    expect(taskSettled).toBe(true)
    expect(owner.tasks.activeTaskCount()).toBe(0)
    expect(notifications).toEqual([])
  })

  it("detaches a workflow task whose deferred launch lands during the close", async () => {
    const { owner, notifications } = trackedOwner("workflow")
    const gate = Promise.withResolvers<void>()
    const task = Promise.withResolvers<BackgroundWorkResult>()
    let killed = false
    let taskSettled = false
    void task.promise.then(() => { taskSettled = true })

    const dispatched = owner.run(dispatch(async () => {
      await gate.promise
      owner.tasks.track({
        done: task.promise,
        meta: { id: "workflow-late", type: "workflow", description: "deferred workflow launch", toolUseId: "toolu_wf" },
        hostClose: "detach",
        kill: { run: () => { killed = true; task.resolve({ status: "failed", content: "terminated" }) } },
      })
      return "dispatched"
    }))
    expect(dispatched).not.toBeNull()

    const closing = owner.close()
    await Bun.sleep(1)
    gate.resolve()
    await closing

    expect(killed).toBe(false)
    expect(taskSettled).toBe(false)
    expect(owner.tasks.activeTaskCount()).toBe(0)
    expect(notifications).toEqual([])
    task.resolve({ status: "completed", content: "done" })
  })

  it("terminates a task registered after close began, because nothing owns it any more", async () => {
    const { owner, notifications } = trackedOwner()
    await owner.close()

    const task = Promise.withResolvers<BackgroundWorkResult>()
    let killed = false
    owner.tasks.track({
      done: task.promise,
      meta: { id: "task-post-close", type: "subagent", description: "late registration" },
      kill: { run: () => { killed = true; task.resolve({ status: "failed", content: "terminated" }) } },
    })
    await task.promise
    await Bun.sleep(1)

    expect(killed).toBe(true)
    expect(owner.tasks.activeTaskCount()).toBe(0)
    expect(notifications).toEqual([])
  })
})

const temporary = temporaryDirectories()
const SESSION = "chat"
const CONVERSATION = "chat-conversation"
const OWNER = { sessionId: SESSION, conversationId: CONVERSATION }

/** An owner of the chat conversation with a real store, whose launcher answers
 *  an adoption as `adopt` says, and which records the steps a close takes and
 *  every completion it delivers for a command found ended at its adoption.
 *  Its executor is in its stop for a heard handoff unless the input says
 *  otherwise. */
function handoverOwner(input: { readonly heard?: boolean; readonly stopping?: boolean; readonly adopt?: (command: HandedOverCommand) => AdoptionAnswer | Promise<AdoptionAnswer> } = {}) {
  const dir = temporary("owner-command-handover-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
  const events: string[] = []
  const base = asAsyncEventWriter(store)
  const writer: AsyncEventWriter = {
    ...base,
    putInFlight: async (sessionId, kind, key, payload) => {
      events.push(`put ${kind}`)
      await base.putInFlight?.(sessionId, kind, key, payload)
    },
    swapInFlightBatch: async (sessionId, swaps) => {
      events.push(`retire with ${swaps.slice(1).map((swap) => swap.kind).join(",")}`)
      return await base.swapInFlightBatch?.(sessionId, swaps) ?? false
    },
  }
  const authority = handoverAuthority({ reader: store, writer, stopping: true, ...input })
  const notifications: Array<{ readonly text: string; readonly key: string | undefined }> = []
  const delivered: CommandCompletion[] = []
  const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text, key) => { notifications.push({ text, key }) } })
  const { detach, terminateAll } = tasks
  tasks.detach = (processId) => { events.push("detach"); return detach(processId) }
  tasks.terminateAll = async () => { events.push("terminateAll"); await terminateAll() }
  const owner = createBackgroundExecutionOwner(tasks, {
    authority, sessionId: SESSION, conversationId: CONVERSATION, holder: "conversation",
    deliver: async (completion) => { delivered.push(completion) },
  }, { adoptionRetryFirstMs: 5 })
  const heldCompletions = () => store.readInFlight(SESSION, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map((row) => ({ key: row.key, conversationId: row.payload.conversationId, text: String(row.payload.text) }))
  return { dir, store, writer, events, owner, tasks, notifications, delivered, heldCompletions }
}

/** Launches one background command through the owner's shell runtime. */
async function launch(fixture: ReturnType<typeof handoverOwner>, owned: OwnedProcess, timeoutSec?: number, privateCopy?: PrivateCopy): Promise<string> {
  await fixture.owner.shell.runBackground({
    command: "bun run dev",
    context: {
      executionCwd: fixture.dir,
      userDataRoot: `${fixture.dir}/.test-account`, projectRoot: fixture.dir,
      scratchDir: fixture.dir,
      toolUseId: "toolu_1",
      artifactScopeId: SESSION, retrievalSessionId: SESSION, sessionId: SESSION,
    },
    spawnOwned: async () => owned,
    env: {},
    operations: makeMockOps(),
    platform: "linux",
    tempDir: fixture.dir,
    executionOutputThrottleMs: 5,
    foreground: false,
    rawOutput: false,
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
    ...(privateCopy === undefined ? {} : { privateCopy }),
  })
  const [command] = fixture.tasks.activeBackgroundCommands()
  if (!command) throw new Error("the command was not tracked")
  return command.id
}

function storeRow(fixture: ReturnType<typeof handoverOwner>, row: CommandHandoverRow): void {
  fixture.store.putInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, row)
}

async function settled(fixture: ReturnType<typeof handoverOwner>): Promise<void> {
  for (let attempt = 0; attempt < 200 && fixture.tasks.activeTaskCount() > 0; attempt++) await Bun.sleep(5)
  await Bun.sleep(5)
}

async function until(label: string, accept: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !accept(); attempt++) await Bun.sleep(5)
  if (!accept()) throw new Error(`${label} did not happen`)
}

describe("BackgroundExecutionOwner command handover", () => {
  it("hands a running command over at a close in its executor's stop for a heard handoff: row, handover word, then detach, all before terminateAll", async () => {
    const fixture = handoverOwner()
    const container = fakeContainer(fixture.events, "handed_over")
    const processId = await launch(fixture, container.owned, 600)
    const channel = handoverChannelAddress({ userDataRoot: USER_DATA_ROOT, lane: "dev", token: container.owned.token })

    await fixture.owner.close()

    expect(fixture.events).toEqual([`put ${COMMAND_HANDOVER_IN_FLIGHT_KIND}`, `handOver ${channel}`, "detach", "terminateAll"])
    const [stored] = await commandHandoversOfAsync(asAsyncEventReadSurface(fixture.store), SESSION, CONVERSATION)
    expect(stored?.row).toMatchObject({
      version: 1, handoffId: HANDOFF, processId, toolUseId: "toolu_1", description: "bun run dev",
      channel, token: container.owned.token, pid: container.owned.pid,
      recordPath: expect.stringMatching(/flywheel-agent-bg-[0-9a-f]+\.outcome\.json$/),
    })
    expect((stored?.row.deadlineAtMs ?? 0) - (stored?.row.startedAtMs ?? 0)).toBe(600_000)
    expect(fixture.notifications).toEqual([])
    fixture.store.close()
  })

  it("ends every running command at a close with no heard handoff, as before", async () => {
    const fixture = handoverOwner({ heard: false })
    await launch(fixture, fakeContainer(fixture.events, "handed_over").owned)

    await fixture.owner.close()

    expect(fixture.events).toEqual(["terminateAll", "terminate"])
    expect(await commandHandoversOfAsync(asAsyncEventReadSurface(fixture.store), SESSION, CONVERSATION)).toEqual([])
    fixture.store.close()
  })

  it("ends every running command at a close after a heard handoff that neither the executor's stop nor the replacement's pause made", async () => {
    // A person deletes the chat, or a child settles, while the replacement drains.
    const fixture = handoverOwner({ stopping: false })
    await launch(fixture, fakeContainer(fixture.events, "handed_over").owned)

    await fixture.owner.close()

    expect(fixture.events).toEqual(["terminateAll", "terminate"])
    expect(await commandHandoversOfAsync(asAsyncEventReadSurface(fixture.store), SESSION, CONVERSATION)).toEqual([])
    fixture.store.close()
  })

  it("hands a running command over at a close the replacement's pause marked, before the executor's stop", async () => {
    const fixture = handoverOwner({ stopping: false })
    const container = fakeContainer(fixture.events, "handed_over")
    await launch(fixture, container.owned)

    fixture.owner.handOverAtClose()
    await fixture.owner.close()

    expect(fixture.events).toEqual([`put ${COMMAND_HANDOVER_IN_FLIGHT_KIND}`, `handOver ${handoverChannelAddress({ userDataRoot: USER_DATA_ROOT, lane: "dev", token: container.owned.token })}`, "detach", "terminateAll"])
    fixture.store.close()
  })

  it("ends an unacknowledged command, and holds its one keyed completion for its conversation in the step that retires its row", async () => {
    const fixture = handoverOwner()
    const container = fakeContainer(fixture.events, "unacknowledged")
    const processId = await launch(fixture, container.owned)

    await fixture.owner.close()

    expect(fixture.events).toEqual([
      `put ${COMMAND_HANDOVER_IN_FLIGHT_KIND}`,
      `handOver ${handoverChannelAddress({ userDataRoot: USER_DATA_ROOT, lane: "dev", token: container.owned.token })}`,
      "terminate",
      `retire with ${QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND}`,
      "terminateAll",
    ])
    expect(fixture.heldCompletions()).toEqual([{ key: `command:${processId}`, conversationId: CONVERSATION, text: expect.stringContaining("ended by signal SIGTERM") }])
    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([])
    expect(fixture.notifications).toEqual([{ key: `command:${processId}`, text: expect.stringContaining("ended by signal SIGTERM") }])
    fixture.store.close()
  })

  it("holds the completion of a command that exited before its supervisor took it, without ending it, as its row retires", async () => {
    const fixture = handoverOwner()
    const container = fakeContainer(fixture.events, "exited")
    const processId = await launch(fixture, container.owned)

    await fixture.owner.close()

    expect(fixture.events).toEqual([
      `put ${COMMAND_HANDOVER_IN_FLIGHT_KIND}`,
      `handOver ${handoverChannelAddress({ userDataRoot: USER_DATA_ROOT, lane: "dev", token: container.owned.token })}`,
      `retire with ${QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND}`,
      "terminateAll",
    ])
    expect(fixture.heldCompletions()).toEqual([{ key: `command:${processId}`, conversationId: CONVERSATION, text: expect.stringContaining("exited with code 3") }])
    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([])
    fixture.store.close()
  })

  it("hands a command that runs in a private project copy over like any other, naming the copy's home, and lands nothing in this runtime, even at the command's end", async () => {
    const fixture = handoverOwner()
    const container = fakeContainer(fixture.events, "handed_over")
    let landings = 0
    await launch(fixture, container.owned, undefined, { home: "/p/scratch/edits/1", land: async () => { landings += 1; return { report: "landed" } } })

    await fixture.owner.close()
    container.end(0)
    await Bun.sleep(10)

    expect((await commandHandoversOfAsync(asAsyncEventReadSurface(fixture.store), SESSION, CONVERSATION)).map((stored) => stored.row.privateCopyHome)).toEqual(["/p/scratch/edits/1"])
    expect(landings).toBe(0)
    expect(fixture.notifications).toEqual([])
    fixture.store.close()
  })

  it("writes no row for a command that settled before the close, which published its completion as before", async () => {
    const fixture = handoverOwner()
    const container = fakeContainer(fixture.events, "handed_over")
    const processId = await launch(fixture, container.owned)
    container.end(0)
    await settled(fixture)

    await fixture.owner.close()

    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([])
    expect(fixture.events).not.toContain(`handOver ${handoverChannelAddress({ userDataRoot: USER_DATA_ROOT, lane: "dev", token: container.owned.token })}`)
    expect(fixture.notifications).toEqual([{ text: expect.stringContaining("exited with code 0"), key: `command:${processId}` }])
    fixture.store.close()
  })

  it("adopts a handed-over command with its original start, its log, and Stop, retires its row, and publishes its completion once", async () => {
    const events: string[] = []
    const container = fakeContainer(events)
    const fixture = handoverOwner({ adopt: () => ({ kind: "adopted", owned: container.owned }) })
    const row = handedOverRow(fixture.dir, OWNER)
    await Bun.write(row.logPath, "compiled 12 modules\nwatching for changes\n")
    await Bun.write(row.recordPath, "{}")
    storeRow(fixture, row)

    await fixture.owner.adoptHandedOver()

    expect(fixture.tasks.processRecord(row.processId)).toMatchObject({ status: "running", startedAtMs: row.startedAtMs })
    expect(fixture.tasks.activeBackgroundCommands().map((command) => command.toolUseId)).toEqual(["toolu_previous"])
    expect(await fixture.tasks.readTaskOutput("toolu_previous", { limit: 5 })).toEqual({ ok: true, text: expect.stringContaining("watching for changes") })
    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([])
    expect(fixture.tasks.terminate("toolu_previous")).toBe(true)
    await settled(fixture)
    expect(events).toEqual(["terminate"])
    expect(fixture.notifications).toEqual([{ text: expect.stringContaining("watching for changes"), key: "command:bash-bg-previous" }])
    // The supervisor's record has no reader once this host published the end.
    await until("the outcome record removed", () => !existsSync(row.recordPath))
    await fixture.owner.close()
    fixture.store.close()
  })

  it("ends an adopted command at its remaining deadline, and one whose deadline already passed at once", async () => {
    const events: string[] = []
    const container = fakeContainer(events)
    const fixture = handoverOwner({ adopt: () => ({ kind: "adopted", owned: container.owned }) })
    const startedAtMs = Date.now() - 120_000
    storeRow(fixture, handedOverRow(fixture.dir, OWNER, { startedAtMs, deadlineAtMs: startedAtMs + 60_000 }))

    await fixture.owner.adoptHandedOver()
    await settled(fixture)

    expect(events).toEqual(["terminate"])
    expect(fixture.notifications).toEqual([{ text: expect.stringContaining("reached its 60s hard deadline and was terminated"), key: "command:bash-bg-previous" }])
    await fixture.owner.close()
    fixture.store.close()
  })

  it("ends an adopted command when the deadline that remains passes", async () => {
    const events: string[] = []
    const container = fakeContainer(events)
    const fixture = handoverOwner({ adopt: () => ({ kind: "adopted", owned: container.owned }) })
    // The clock is faked, so a slow adoption on a loaded runner cannot use up the 20 ms that remain of the deadline.
    jest.useFakeTimers()
    try {
      const startedAtMs = Date.now() - 1_000
      storeRow(fixture, handedOverRow(fixture.dir, OWNER, { startedAtMs, deadlineAtMs: Date.now() + 20 }))

      await fixture.owner.adoptHandedOver()
      jest.advanceTimersByTime(19)
      expect(events).toEqual([])
      jest.advanceTimersByTime(1)
    } finally {
      jest.useRealTimers()
    }
    await settled(fixture)

    expect(events).toEqual(["terminate"])
    expect(fixture.notifications[0]?.text).toContain("hard deadline and was terminated")
    await fixture.owner.close()
    fixture.store.close()
  })

  const recorded = (outcome?: { code: number | null; deadlineExpired: boolean }): AdoptionAnswer => ({
    kind: "ended",
    record: { kind: "record", record: { version: 1, handedOverAtMs: Date.now() - 1_000, ...(outcome === undefined ? {} : { outcome: { ...outcome, signal: null, endedAtMs: Date.now() } }) } },
  })

  it.each([
    ["the recorded exit", recorded({ code: 3, deadlineExpired: false }), "exited with code 3"],
    ["one failed completion for a record without an outcome", recorded(), "ended without a recorded exit status"],
    ["one failed completion for no record", { kind: "ended", record: { kind: "absent" } } satisfies AdoptionAnswer, "ended with the previous runtime"],
  ] as const)("settles a command that ended before adoption, holds %s as its row retires, and delivers it to the host once", async (_name, answer, text) => {
    const fixture = handoverOwner({ adopt: () => answer })
    const row = handedOverRow(fixture.dir, OWNER)
    await Bun.write(row.recordPath, "{}")
    storeRow(fixture, row)

    await fixture.owner.adoptHandedOver()

    expect(fixture.delivered).toEqual([{ key: "command:bash-bg-previous", text: expect.stringContaining(text) }])
    expect(fixture.delivered[0]?.text).toContain("<status>failed</status>")
    expect(fixture.heldCompletions()).toEqual([{ key: "command:bash-bg-previous", conversationId: CONVERSATION, text: fixture.delivered[0]?.text ?? "" }])
    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([])
    expect(existsSync(row.recordPath)).toBe(false)
    // Nothing of it is this host's to track or stop.
    expect(fixture.tasks.activeTaskCount()).toBe(0)
    expect(fixture.notifications).toEqual([])
    await fixture.owner.close()
    fixture.store.close()
  })

  // A later generation's sweep can settle the row of a command that ended at
  // the moment a host of its conversation adopts it.
  it("publishes nothing for an ended command whose row another consumer retired first", async () => {
    const fixture: ReturnType<typeof handoverOwner> = handoverOwner({
      adopt: async () => {
        const [stored] = await commandHandoversOfAsync(asAsyncEventReadSurface(fixture.store), SESSION, CONVERSATION)
        if (stored) await retireCommandHandover(fixture.writer, stored, { key: "command:bash-bg-previous", text: "the sweep's completion" })
        return recorded({ code: 0, deadlineExpired: false })
      },
    })
    storeRow(fixture, handedOverRow(fixture.dir, OWNER))

    await fixture.owner.adoptHandedOver()

    expect(fixture.delivered).toEqual([])
    expect(fixture.heldCompletions()).toEqual([{ key: "command:bash-bg-previous", conversationId: CONVERSATION, text: "the sweep's completion" }])
    await fixture.owner.close()
    fixture.store.close()
  })

  it("leaves the row of a command whose supervisor kept a record this release cannot read, and publishes nothing", async () => {
    const fixture = handoverOwner({ adopt: () => ({ kind: "ended", record: { kind: "unreadable", reason: "the record has version 2" } }) })
    storeRow(fixture, handedOverRow(fixture.dir, OWNER))

    await fixture.owner.adoptHandedOver()

    expect(fixture.delivered).toEqual([])
    expect(fixture.heldCompletions()).toEqual([])
    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toHaveLength(1)
    await fixture.owner.close()
    fixture.store.close()
  })

  it("tries a row it left again until its command can be adopted: a supervisor that refused the adopt word, then one that did not answer in time", async () => {
    const events: string[] = []
    const container = fakeContainer(events)
    const answers: Array<() => AdoptionAnswer> = [
      () => ({ kind: "refused" }),
      () => { throw new Error("no answer came within the bound") },
      () => ({ kind: "adopted", owned: container.owned }),
    ]
    const fixture = handoverOwner({ adopt: () => (answers.shift() ?? raise())() })
    storeRow(fixture, handedOverRow(fixture.dir, OWNER))

    await fixture.owner.adoptHandedOver()
    // The first pass left the row, and nothing of it is tracked or stoppable.
    expect(fixture.tasks.activeTaskCount()).toBe(0)
    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toHaveLength(1)

    await until("the command adopted", () => fixture.tasks.activeBackgroundCommands().length === 1)
    expect(answers).toEqual([])
    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([])
    await fixture.owner.close()
    fixture.store.close()
  })

  it("stops trying a row it left once the host closes", async () => {
    let attempts = 0
    const fixture = handoverOwner({ adopt: () => { attempts += 1; return { kind: "refused" } } })
    storeRow(fixture, handedOverRow(fixture.dir, OWNER))

    await fixture.owner.adoptHandedOver()
    await fixture.owner.close()
    const closedAt = attempts
    await Bun.sleep(25)

    expect(attempts).toBe(closedAt)
    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toHaveLength(1)
    fixture.store.close()
  })

  it("leaves a row of an unknown version in place and adopts nothing from it", async () => {
    let asked = false
    const fixture = handoverOwner({ adopt: () => { asked = true; return { kind: "ended", record: { kind: "absent" } } } })
    fixture.store.putInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND, "bash-bg-previous", { ...handedOverRow(fixture.dir, OWNER), version: 2 })

    await fixture.owner.adoptHandedOver()

    expect(asked).toBe(false)
    expect(fixture.tasks.activeTaskCount()).toBe(0)
    expect(fixture.store.readInFlight(SESSION, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toHaveLength(1)
    await fixture.owner.close()
    fixture.store.close()
  })
})

function raise(): never {
  throw new Error("the fixture is not ready")
}
