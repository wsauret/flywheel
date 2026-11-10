import { describe, expect, it } from "bun:test"
import { PassThrough } from "node:stream"
import { Schema } from "effect"
import type { FrontendEvent, FrontendMutation, RuntimeClient, RuntimeQuery } from "../../../src/protocol/app-service-types.js"
import { recordedDispatch, recordedQuery, runtimeDispatch, runtimeQuery } from "../../helpers/runtime-dispatch.js"
import { HeadlessChatRecordSchema, type HeadlessChatRecord } from "../../../src/protocol/headless-chat.js"
import type { PendingQuestionView } from "../../../src/protocol/question-protocol-types.js"
import type { RuntimeSessionDetailView } from "../../../src/protocol/session-detail-protocol-types.js"
import { runHeadlessChatChannel } from "../../../src/orchestration/headless/run-headless-chat.js"
import { createRuntimeWorkSettlement } from "../../../src/orchestration/app-service/runtime-work-settlement.js"
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../src/orchestration/agent-runtime/background-work.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import { catalogRow, deferred } from "../../helpers/session-catalog.js"
import { createRuntimeUiBus } from "../../../src/orchestration/app-service/runtime-ui-bus.js"
import { createChatInvocationCompletion } from "../../../src/orchestration/chat/runner-completion.js"
import type { AgentToolInput } from "../../../src/orchestration/agent-runtime/types.js"
import { registerLiveWorkflowControl, runningChildSessionIds, liveWorkflowControls, onLiveWorkChanged } from "../../../src/orchestration/session/live-session-control.js"
import { asAsyncEventReadSurface } from "../../../src/infra/event-store-types.js"
import { createSupervisorTestContext, disposeSupervisorTestContext } from "../../fixtures/runtime-supervisor-fixtures.js"

function channelFixture(runningChildren: () => Promise<readonly string[]> = async () => [], workflows: Pick<Parameters<typeof createRuntimeWorkSettlement>[0], "busyWorkflows" | "onWorkflowChange"> = { busyWorkflows: async () => [], onWorkflowChange: () => () => {} }) {
  const calls: FrontendMutation[] = []
  const records: HeadlessChatRecord[] = []
  const views = new Map<string, RuntimeSessionDetailView>([["root", detail("root")]])
  const questions = new Map<string, PendingQuestionView>()
  const statuses = new Map<string, StatusView>()
  const pendingTurns = new Map<string, Promise<void>>()
  const registries = new Map<string, ReturnType<typeof createBackgroundWorkRegistry>>()
  const continuations = new Set<string>()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const bus = createRuntimeUiBus()
  let admission = Promise.resolve()
  let onRead: (query: RuntimeQuery) => void = () => {}
  const answered = runtimeQuery({
    sessionDetail: async (request) => ({ view: views.get(request.sessionId) ?? null }),
    statusSnapshot: async (request) => ({
      snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: statuses.get(sessionId) ?? views.get(sessionId)?.status ?? null })),
    }),
    questionSnapshot: async (request) => ({
      snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: questions.get(sessionId) ?? null })),
    }),
  })
  const accepted = async () => ({ ok: true as const, sessionId: "root" })
  const client: RuntimeClient = {
    query: recordedQuery((request) => { onRead(request) }, answered),
    dispatch: recordedDispatch((command) => { calls.push(command) }, runtimeDispatch({
      "chat.open": accepted, "session.activate": accepted, "session.send": accepted, "chat.interrupt": accepted,
      "question.answer": accepted, "question.cancel": accepted, "background.terminate": accepted,
    })),
    close: async () => {},
    subscribe: (next) => { listeners.add(next); bus.addListener(next); return () => { listeners.delete(next); bus.removeListener(next) } },
  }
  const workSettlement = createRuntimeWorkSettlement({
    ...workflows,
    client, awaitAcceptedWork: () => admission,
    ownedSessionIds: () => [...views.keys()], runningChildren, keptSessions: () => [],
    failed: () => false,
    pendingTurnSettlement: (id) => pendingTurns.get(id),
    backgroundWork: (id) => registries.get(id),
    requiresContinuation: async (id) => continuations.has(id) || views.get(id)?.row.admittedActions?.some((action) => action === "chat.resume") === true,
    onLiveSessionRemoved: () => () => {},
  })
  let position = 0
  const publish = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
  return {
    runtime: { client, startChatDefault: () => {}, workSettlement, currentTotals: async () => {} },
    calls, records, views, questions, statuses, pendingTurns, registries, continuations, bus,
    admission: (work: Promise<void>) => { admission = work },
    onRead: (next: typeof onRead) => { onRead = next },
    changed: () => {
      for (const [sessionId, view] of views) publish({ type: "patch", patch: {
        cursor: { scope: "session", domain: "status", sessionId }, position: ++position, prevPosition: 0,
        payload: { kind: "status.updated", status: statuses.get(sessionId) ?? view.status },
      } })
    },
    content: () => publish({ type: "patch", patch: {
      cursor: { scope: "session", domain: "output", sessionId: "root" }, position: ++position, prevPosition: 0,
      payload: { kind: "runtime.invalidate", reason: "rebase" },
    } }),
    write: async (line: string) => { records.push(Schema.decodeUnknownSync(HeadlessChatRecordSchema)(JSON.parse(line))) },
    subscribed: () => listeners.size > 0,
  }
}

function detail(id: string): Extract<RuntimeSessionDetailView, { kind: "chat" }> {
  return {
    id, source: "durable", kind: "chat", conversationId: `conversation-${id}`,
    row: catalogRow(id, id), budget: null,
    status: {
      activity: "idle", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected",
      activeSubagentCount: 0, waitingOnBackgroundWork: false, replyWaits: [],
      activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
      startedAt: 0, streamingStartedAt: null,
      accumulatedActiveMs: 0, compactionStartedAt: null,
    },
  }
}

/** Tracks a running background command in the session's real registry. A
 *  `service` is a command launched with `background=true`. Its completion
 *  notification commits when `delivery` resolves, as a mailbox commits it
 *  only once the turn is free. `finish` ends the command. */
function trackCommand(fixture: ReturnType<typeof channelFixture>, sessionId: string, id: string, service: boolean, delivery?: Promise<void>) {
  const registry = fixture.registries.get(sessionId) ?? createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: async () => { await delivery } })
  fixture.registries.set(sessionId, registry)
  const done = deferred<BackgroundWorkResult>()
  registry.track({ done: done.promise, meta: { id, type: "background_command", description: id, toolUseId: id }, ...(service ? { service: true as const } : {}) })
  return {
    finish: async (result: BackgroundWorkResult) => {
      done.resolve(result)
      await done.promise
    },
  }
}

function dispatchLine(id: string, command: FrontendMutation): string {
  return `${JSON.stringify({ version: 1, type: "dispatch", id, command })}\n`
}

describe("headless Chat JSONL transport", () => {
  it("bounds slow stdout, dispatches Interrupt before drain, and retains control results and overflow invalidation", async () => {
    const fixture = channelFixture()
    const input = new PassThrough()
    const output = new PassThrough({ highWaterMark: 1 })
    const blocked = deferred<void>()
    const interrupted = deferred<void>()
    const ready = deferred<void>()
    const dispatch = fixture.runtime.client.dispatch
    fixture.runtime.client.dispatch = async (command) => {
      const result = await dispatch(command)
      if (command.type === "chat.interrupt") interrupted.resolve()
      return result
    }
    let hold = true
    let writes = 0
    let maxWrites = 0
    output.on("data", (chunk: Buffer) => {
      const line = chunk.toString()
      const record = Schema.decodeUnknownSync(HeadlessChatRecordSchema)(JSON.parse(line))
      void fixture.write(line)
      if (record.type === "ready") {
        output.pause()
        ready.resolve()
      }
    })
    const pending = runHeadlessChatChannel(fixture.runtime, {
      input, write: async (line) => {
        const record = Schema.decodeUnknownSync(HeadlessChatRecordSchema)(JSON.parse(line))
        if (record.type === "event" && hold) {
          hold = false
          blocked.resolve()
        }
        writes++
        maxWrites = Math.max(maxWrites, writes)
        try {
          await new Promise<void>((resolve, reject) => {
            output.write(line, (error) => {
              if (error) reject(error)
              else resolve()
            })
          })
        } finally { writes-- }
      },
    })
    try {
      await ready.promise
      fixture.bus.publish({
        cursor: { scope: "workspace", domain: "executor" },
        payload: { kind: "executor.changed", executor: { kind: "serving" } },
      })
      await blocked.promise
      for (let position = 0; position < 5000; position++) fixture.bus.publish({
        cursor: { scope: "workspace", domain: "executor" },
        payload: { kind: "executor.changed", executor: { kind: "serving" } },
      })
      await fixture.bus.drain()
      input.end(
        dispatchLine("message", { type: "session.send", sessionId: "root", input: "hello" }) +
        dispatchLine("interrupt", { type: "chat.interrupt", sessionId: "root" }) +
        Array.from({ length: 10 }, (_, index) => JSON.stringify({
          version: 1, type: "query", id: `read-${index}`, query: { type: "sessionDetail", sessionId: "root" },
        }) + "\n").join(""),
      )
      await interrupted.promise
      expect(fixture.records.filter((record) => record.type === "event")).toHaveLength(0)
      output.resume()
      expect(await pending).toEqual({ sessionId: "root", outcome: "complete" })
      const patches = fixture.records.filter((record) => record.type === "event" && record.event.type === "patch")
      expect(patches).toHaveLength(2049)
      expect(patches.at(-1)).toMatchObject({ type: "event", event: { patch: { payload: { kind: "runtime.invalidate", reason: "overflow" } } } })
      expect(fixture.records.filter((record) => record.type === "result").map((record) => record.id)).toEqual([
        "message", "interrupt", ...Array.from({ length: 10 }, (_, index) => `read-${index}`),
      ])
      expect(fixture.records[0]?.type).toBe("ready")
      expect(maxWrites).toBe(1)
      expect(fixture.subscribed()).toBe(false)
    } finally {
      output.resume()
      input.destroy()
      output.destroy()
      await fixture.bus.clear()
    }
  })
  it.each(["ready", "event", "result"] as const)("releases its input reader and subscription when writing stdout %s fails", async (type) => {
    const fixture = channelFixture()
    const input = new PassThrough()
    try {
      await expect(runHeadlessChatChannel(fixture.runtime, {
        input, write: async (line) => {
          const record = Schema.decodeUnknownSync(HeadlessChatRecordSchema)(JSON.parse(line))
          if (record.type === type) throw new Error("closed stdout")
          if (record.type === "ready") input.write(dispatchLine("interrupt", { type: "chat.interrupt", sessionId: "root" }))
          await fixture.write(line)
        },
      })).rejects.toThrow("closed stdout")
      expect(fixture.subscribed()).toBe(false)
    } finally { input.destroy() }
  })

  it("forwards multiple messages, question answers, cancellation, interrupts, and child Stop in input order", async () => {
    const fixture = channelFixture()
    const commands: FrontendMutation[] = [
      { type: "session.send", sessionId: "root", input: "first" },
      { type: "session.send", sessionId: "root", input: "second" },
      { type: "question.answer", sessionId: "root", toolUseId: "ask", answers: { Proceed: { kind: "freeform", text: "yes" } } },
      { type: "question.cancel", sessionId: "root", toolUseId: "ask-next" },
      { type: "chat.interrupt", sessionId: "root" },
      { type: "background.terminate", sessionId: "root", toolUseId: "child" },
    ]
    const result = await runHeadlessChatChannel(fixture.runtime, {
      input: [commands.map((command, index) => dispatchLine(String(index), command)).join("")],
      write: fixture.write,
    })
    expect(fixture.calls).toEqual([{ type: "chat.open" }, { type: "session.activate", sessionId: "root" }, ...commands])
    expect(fixture.records.filter((record) => record.type === "result").map((record) => record.id)).toEqual(["0", "1", "2", "3", "4", "5"])
    expect(result).toEqual({ sessionId: "root", outcome: "complete" })
    expect(fixture.subscribed()).toBe(false)
  })

  it("keeps stdin open after a turn and streams ordinary events before a later message", async () => {
    const fixture = channelFixture()
    const input = new PassThrough()
    const first = deferred<void>()
    const originalWrite = fixture.write
    const result = runHeadlessChatChannel(fixture.runtime, {
      input, write: async (line) => {
        await originalWrite(line)
        const record = Schema.decodeUnknownSync(HeadlessChatRecordSchema)(JSON.parse(line))
        if (record.type === "ready") input.write(dispatchLine("first", { type: "session.send", sessionId: "root", input: "first" }))
        if (record.type === "result" && record.id === "first") first.resolve()
      },
    })
    await first.promise
    fixture.changed()
    input.end(dispatchLine("later", { type: "session.send", sessionId: "root", input: "later" }))
    expect(await result).toEqual({ sessionId: "root", outcome: "complete" })
    expect(fixture.records.some((record) => record.type === "event")).toBe(true)
    expect(fixture.calls.at(-1)).toEqual({ type: "session.send", sessionId: "root", input: "later" })
  })

  it("reports an unanswered question at EOF without dispatching an answer or cancellation", async () => {
    const fixture = channelFixture()
    fixture.questions.set("root", { kind: "question", toolUseId: "ask", questions: [], timestamp: 0 })
    expect(await runHeadlessChatChannel(fixture.runtime, { input: [], write: fixture.write })).toEqual({ sessionId: "root", outcome: "input_required" })
    expect(fixture.calls).toEqual([{ type: "chat.open" }, { type: "session.activate", sessionId: "root" }])
  })

  it("attaches saved history without an implicit Resume and reports an interrupted turn as incomplete", async () => {
    const fixture = channelFixture()
    const view = detail("saved")
    fixture.views.set("saved", { ...view, row: { ...view.row, admittedActions: ["chat.resume"] } })
    expect(await runHeadlessChatChannel(fixture.runtime, {
      sessionId: "saved", input: [], write: fixture.write,
    })).toEqual({ sessionId: "saved", outcome: "incomplete" })
    expect(fixture.calls).toEqual([{ type: "session.activate", sessionId: "saved" }])
  })

  it("drains a busy child after EOF even when its root chat is idle", async () => {
    const fixture = channelFixture()
    const root = detail("root")
    fixture.views.set("root", { ...root, row: { ...root.row, childSessionIds: ["child"] } })
    const child = detail("child")
    fixture.views.set("child", { ...child, status: { ...child.status, activity: "executing_tools" } })
    const reached = deferred<void>()
    fixture.onRead((query) => { if (query.type === "questionSnapshot" && query.sessionIds.includes("child")) reached.resolve() })
    let ended = false
    const pending = runHeadlessChatChannel(fixture.runtime, { input: [], write: fixture.write }).then((result) => { ended = true; return result })
    await reached.promise
    expect(ended).toBe(false)
    fixture.views.set("child", child)
    fixture.changed()
    expect(await pending).toEqual({ sessionId: "root", outcome: "complete" })
  })

  it.each(["incomplete", "input_required"] as const)("returns one-shot %s with stdin still open", async (outcome) => {
    const fixture = channelFixture()
    if (outcome === "input_required") fixture.questions.set("root", { kind: "question", toolUseId: "ask", questions: [], timestamp: 0 })
    const input = new PassThrough()
    input.write(dispatchLine("turn", { type: "session.send", sessionId: "root", input: "hello" }))
    try {
      expect(await runHeadlessChatChannel(fixture.runtime, { oneShot: true, input, write: fixture.write })).toEqual({ sessionId: "root", outcome })
      expect(input.writableEnded).toBe(false)
      expect(fixture.calls).toEqual([{ type: "chat.open" }, { type: "session.activate", sessionId: "root" }, { type: "session.send", sessionId: "root", input: "hello" }])
    } finally { input.destroy() }
  })

  it("returns the sealed final reply only after root settlement with stdin still open", async () => {
    const fixture = channelFixture()
    const root = detail("root")
    fixture.views.set("root", { ...root, status: { ...root.status, activity: "generating" } })
    const reached = deferred<void>()
    let bound: string | undefined
    let handoff: AgentToolInput | undefined
    const invocation = createChatInvocationCompletion((content) => { handoff = content })
    const readControls = deferred<void>()
    fixture.onRead((query) => { if (query.type === "questionSnapshot") reached.resolve() })
    const input = new PassThrough()
    input.write(dispatchLine("turn", { type: "session.send", sessionId: "root", input: "hello" }))
    const pending = runHeadlessChatChannel(fixture.runtime, {
      oneShot: true, input, write: async (line) => {
        await fixture.write(line)
        const record = fixture.records.at(-1)
        if (record?.type === "result" && record.id === "interrupt") readControls.resolve()
      },
      completion: { invocation, bind: (id) => { bound = id }, result: () => handoff },
    })
    try {
      await reached.promise
      expect(bound).toBe("root")
      expect(invocation.seal!("done")).toBe(true)
      input.write(dispatchLine("late", { type: "session.send", sessionId: "root", input: "too late" }))
      input.write(`${JSON.stringify({ version: 1, type: "query", id: "status", query: { type: "sessionDetail", sessionId: "root" } })}\n`)
      input.write(dispatchLine("interrupt", { type: "chat.interrupt", sessionId: "root" }))
      await readControls.promise
      expect(fixture.calls.filter((call) => call.type === "session.send")).toHaveLength(1)
      expect(fixture.records).toContainEqual({ version: 1, type: "error", id: "late", error: "The one-shot Chat invocation has already completed" })
      expect(fixture.records.some((record) => record.type === "result" && record.id === "status")).toBe(true)
      expect(handoff).toBeUndefined()
      await invocation.finish({ kind: "completed" }, async () => {})
      fixture.views.set("root", root)
      fixture.changed()
      expect(await pending).toEqual({ sessionId: "root", outcome: "complete", handoff })
      expect(input.writableEnded).toBe(false)
    } finally { input.destroy() }
  })

  it("keeps one-shot input open while background work runs, even with an unanswered question", async () => {
    const fixture = channelFixture()
    fixture.questions.set("root", { kind: "question", toolUseId: "ask", questions: [], timestamp: 0 })
    const root = detail("root")
    fixture.views.set("root", { ...root, row: { ...root.row, childSessionIds: ["child"] } })
    const child = detail("child")
    fixture.views.set("child", { ...child, status: { ...child.status, activity: "generating" } })
    const reached = deferred<void>()
    fixture.onRead((query) => { if (query.type === "questionSnapshot" && query.sessionIds.includes("child")) reached.resolve() })
    const input = new PassThrough()
    input.write(dispatchLine("turn", { type: "session.send", sessionId: "root", input: "hello" }))
    let ended = false
    const pending = runHeadlessChatChannel(fixture.runtime, { oneShot: true, input, write: fixture.write }).then((result) => { ended = true; return result })
    try {
      await reached.promise
      expect(ended).toBe(false)
      fixture.views.set("child", child)
      fixture.changed()
      expect(await pending).toEqual({ sessionId: "root", outcome: "input_required" })
      expect(input.writableEnded).toBe(false)
    } finally { input.destroy() }
  })

  it.each(["shell", "reply_wait"] as const)("drains canonical %s ownership without polling content patches", async (kind) => {
    const fixture = channelFixture()
    const root = detail("root")
    fixture.statuses.set("root", { ...root.status,
      ...(kind === "shell"
        ? { activeBackgroundCommands: [{ id: "shell", toolUseId: "shell", description: "work", startedAtMs: 0 }] }
        : { waitingOnBackgroundWork: true, replyWaits: [{ sessionId: "other", name: "Other" }] }),
    })
    // A running finite command holds settlement past an open question. Its
    // completion notification cannot commit until the question is answered,
    // so once it ends the question is what remains.
    const answered = deferred<void>()
    const command = kind === "shell" ? trackCommand(fixture, "root", "shell", false, answered.promise) : undefined
    if (kind === "shell") fixture.questions.set("root", { kind: "question", toolUseId: "ask", questions: [], timestamp: 0 })
    const reached = deferred<void>()
    let reads = 0
    fixture.onRead((query) => { if (query.type === "statusSnapshot") { reads++; reached.resolve() } })
    let ended = false
    const pending = runHeadlessChatChannel(fixture.runtime, { input: [], write: fixture.write }).then((result) => { ended = true; return result })
    await reached.promise
    fixture.changed()
    // Join the first ownership notification, then content cannot cause a read.
    await Promise.resolve()
    await Promise.resolve()
    const before = reads
    for (let index = 0; index < 50; index++) fixture.content()
    await Promise.resolve()
    expect(ended).toBe(false)
    expect(reads).toBe(before)
    await command?.finish({ status: "completed", content: "" })
    if (kind === "shell") expect(fixture.registries.get("root")?.pendingDeliveryCount()).toBe(1)
    fixture.statuses.set("root", root.status)
    fixture.changed()
    expect(await pending).toEqual({ sessionId: "root", outcome: kind === "shell" ? "input_required" : "complete" })
    answered.resolve()
  })

  it("completes a turn that leaves a service running, as the agent loop does", async () => {
    const fixture = channelFixture()
    const root = detail("root")
    fixture.statuses.set("root", { ...root.status, activeBackgroundCommands: [{ id: "server", toolUseId: "server", description: "server", startedAtMs: 0 }] })
    const service = trackCommand(fixture, "root", "server", true)
    try {
      expect(await runHeadlessChatChannel(fixture.runtime, { input: [], write: fixture.write })).toEqual({ sessionId: "root", outcome: "complete" })
    } finally { await service.finish({ status: "cancelled", content: "" }) }
  })

  it.each([
    { target: "root", interrupted: false },
    { target: "other", interrupted: false },
    { target: "root", interrupted: true },
  ])("joins a chat request and live workflow work under $target (interrupted=$interrupted)", async ({ target, interrupted }) => {
    const context = createSupervisorTestContext()
    const reader = asAsyncEventReadSurface(context.store)
    const fixture = channelFixture(() => runningChildSessionIds(reader), {
      busyWorkflows: async () => (await Promise.all(liveWorkflowControls(reader).map(async (control) => await control.state() === "interrupted" ? [] : [control.workflowId]))).flat(),
      onWorkflowChange: (listener) => onLiveWorkChanged(reader, listener),
    })
    let cut = false
    fixture.views.set(target, detail(target))
    const admission = deferred<void>()
    fixture.admission(admission.promise)
    let ended = false
    const pending = runHeadlessChatChannel(fixture.runtime, {
      input: [dispatchLine("send", { type: "session.send", sessionId: target, input: "Launch a workflow for this work" })],
      write: fixture.write,
    }).then((result) => { ended = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The pending chat request holds the channel open before its workflow control exists.
    expect(ended).toBe(false)
    const unregister = registerLiveWorkflowControl(reader, {
      workflowId: "workflow", kind: "workflow", state: async () => cut ? "interrupted" : "between_steps",
      handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined,
      deliver: async () => ({ status: "refused", reason: "settled" }),
      notify: async () => false,
    })
    admission.resolve()
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ended).toBe(false)
      if (interrupted) {
        cut = true
        fixture.continuations.add(target)
        fixture.changed()
        expect(await pending).toEqual({ sessionId: "root", outcome: "incomplete" })
        return
      }
      const parentResult = deferred<void>()
      fixture.pendingTurns.set(target, parentResult.promise)
      unregister()
      fixture.changed()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ended).toBe(false)
      fixture.pendingTurns.delete(target)
      parentResult.resolve()
      expect(await pending).toEqual({ sessionId: "root", outcome: "complete" })
    } finally {
      unregister()
      await disposeSupervisorTestContext(context)
    }
  })

  it("rejects unsupported versions and invalid commands without echoing secret input, then accepts a query", async () => {
    const fixture = channelFixture()
    expect(await runHeadlessChatChannel(fixture.runtime, {
      input: [
        `${JSON.stringify({ version: 2, type: "dispatch", id: "old", command: { type: "chat.open", secret: "private" } })}\n` +
        `${JSON.stringify({ version: 1, type: "dispatch", id: "bad", command: { type: "question.answer", secret: "private" } })}\n` +
        `${JSON.stringify({ version: 1, type: "query", id: "read", query: { type: "sessionDetail", sessionId: "root" } })}\n`,
      ], write: fixture.write,
    })).toEqual({ sessionId: "root", outcome: "complete" })
    expect(fixture.records.filter((record) => record.type === "error").map((record) => record.id)).toEqual(["old", "bad"])
    expect(JSON.stringify(fixture.records)).not.toContain("private")
    expect(fixture.records.at(-1)).toMatchObject({ type: "result", id: "read" })
    expect(fixture.calls).toEqual([{ type: "chat.open" }, { type: "session.activate", sessionId: "root" }])
  })
})
