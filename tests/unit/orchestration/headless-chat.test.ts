import { describe, expect, it } from "bun:test"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { PassThrough } from "node:stream"
import type { FrontendEvent, FrontendMutation, RuntimeClient, RuntimeQuery } from "../../../src/protocol/app-service-types.js"
import { recordedDispatch, recordedQuery, runtimeDispatch, runtimeQuery } from "../../helpers/runtime-dispatch.js"
import { modulesView, tailWindow } from "../../helpers/runtime-views.js"
import type { PendingQuestionView } from "../../../src/protocol/question-protocol-types.js"
import type { RuntimeSessionDetailView } from "../../../src/protocol/session-detail-protocol-types.js"
import { acpFraming } from "../../../src/orchestration/headless/acp-chat.js"
import { inProcessHeadlessClient, runHeadlessChatChannel, type ChatTransport } from "../../../src/orchestration/headless/headless-chat-channel.js"
import { createRuntimeWorkSettlement, serveChatSettlement } from "../../../src/orchestration/app-service/runtime-work-settlement.js"
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../src/orchestration/agent-runtime/background-work.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import { catalogRow, deferred } from "../../helpers/session-catalog.js"
import { createRuntimeUiBus } from "../../../src/orchestration/app-service/runtime-ui-bus.js"
import { liveSessionControl, registerLiveSessionControl, registerLiveWorkflowControl, runningChildSessionIds, liveWorkflowControls, onLiveWorkChanged } from "../../../src/orchestration/session/live-session-control.js"
import { heldSessionLineage, sessionSubtree, type SessionLineage } from "../../../src/orchestration/session/session-subtree.js"
import { countStateRequests } from "../../helpers/state-requests.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface } from "../../../src/infra/event-store-types.js"
import { openReplyWait, suspendReplyWaits, workProgressesWithout, type ReplyWaitDeps } from "../../../src/orchestration/session/reply-waits.js"
import { createSupervisorTestContext, disposeSupervisorTestContext } from "../../fixtures/runtime-supervisor-fixtures.js"

type LiveWorkOwners = Pick<Parameters<typeof createRuntimeWorkSettlement>[0], "busyWorkflows" | "onWorkflowChange" | "progressesWithout" | "interrupted">

function channelFixture(runningChildren: (sessionIds: readonly string[]) => Promise<readonly string[]> = async () => [], workflows: LiveWorkOwners = { busyWorkflows: async () => [], onWorkflowChange: () => () => {}, progressesWithout: async () => true, interrupted: async () => false }) {
  const calls: FrontendMutation[] = []
  const views = new Map<string, RuntimeSessionDetailView>([["root", detail("root")]])
  const questions = new Map<string, PendingQuestionView>()
  const statuses = new Map<string, StatusView>()
  const pendingTurns = new Map<string, Promise<void>>()
  const registries = new Map<string, ReturnType<typeof createBackgroundWorkRegistry>>()
  const continuations = new Set<string>()
  // The channel's subscribers, and the runtime's own settlement owner, which
  // outlives every channel.
  const listeners = new Set<(event: FrontendEvent) => void>()
  const owners = new Set<(event: FrontendEvent) => void>()
  const bus = createRuntimeUiBus()
  // The launch tree: each view's catalog children, and the launches a test adds.
  const launched = new Map<string, string[]>()
  const kinds = new Map<string, string>()
  const lineage = (): SessionLineage => {
    const children = new Map<string, readonly string[]>()
    for (const [id, view] of views) children.set(id, [...view.row.childSessionIds ?? []])
    for (const [id, ids] of launched) children.set(id, [...children.get(id) ?? [], ...ids])
    return { children, kinds: new Map([...[...children.values()].flat().map((id): [string, string] => [id, "subagent"]), ...kinds]), titles: new Map() }
  }
  let admission = { owner: "root", work: Promise.resolve() }
  let onRead: (query: RuntimeQuery) => void = () => {}
  const answered = runtimeQuery({
    sessionDetail: async (request) => ({ view: views.get(request.sessionId) ?? null }),
    statusSnapshot: async (request) => ({
      snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: statuses.get(sessionId) ?? views.get(sessionId)?.status ?? null })),
    }),
    questionSnapshot: async (request) => ({
      snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: questions.get(sessionId) ?? null })),
    }),
    // What an ACP session reads to open and to answer a prompt.
    budgetSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: null })) }),
    outputWindow: async () => tailWindow([]),
    modelOptions: async () => [],
    sessionModelPlan: async ({ sessionId }) => ({ sessionId, profile: { persistedId: "Personal", effectiveId: "Personal" }, assignments: [], plans: [] }),
    roleSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: null })) }),
    moduleSnapshot: async () => ({ snapshotPosition: 0, capabilities: modulesView() }),
  })
  const accepted = async () => ({ ok: true as const, sessionId: "root" })
  const runtime: RuntimeClient = {
    query: recordedQuery((request) => { onRead(request) }, answered),
    dispatch: recordedDispatch((command) => { calls.push(command) }, runtimeDispatch({
      "chat.open": accepted, "session.activate": accepted, "session.send": accepted, "chat.interrupt": accepted,
      "question.answer": accepted, "question.cancel": accepted, "background.terminate": accepted,
    })),
    close: async () => {},
    subscribe: (next) => { owners.add(next); return () => { owners.delete(next) } },
  }
  const workSettlement = createRuntimeWorkSettlement({
    ...workflows,
    client: runtime, members: async (root) => sessionSubtree(lineage(), root),
    awaitAcceptedWork: (sessionIds) => sessionIds.includes(admission.owner) ? admission.work : Promise.resolve(),
    runningChildren, keptSessions: () => [],
    failed: () => false,
    pendingTurnSettlement: (id) => pendingTurns.get(id),
    backgroundWork: (id) => registries.get(id),
    requiresContinuation: async (id) => continuations.has(id) || views.get(id)?.row.admittedActions?.some((action) => action === "chat.resume") === true,
    onLiveSessionRemoved: () => () => {},
  })
  const served = serveChatSettlement({ client: runtime, settlement: workSettlement, currentTotals: async () => {}, turnEnding: () => undefined, bus })
  const client = inProcessHeadlessClient({
    ...runtime, query: served.query,
    subscribe: (next) => { listeners.add(next); bus.addListener(next); return () => { listeners.delete(next); bus.removeListener(next) } },
  })
  let position = 0
  const publish = (event: FrontendEvent) => { for (const listener of [...listeners, ...owners]) listener(event) }
  return {
    client, workSettlement,
    calls, views, questions, statuses, pendingTurns, registries, continuations, bus,
    admission: (work: Promise<void>, owner = "root") => { admission = { owner, work } },
    launch: (parent: string, child: string, kind: string) => { launched.set(parent, [...launched.get(parent) ?? [], child]); kinds.set(child, kind) },
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
    write: async () => {},
    subscribed: () => listeners.size > 0,
  }
}

/** The live work owners that the runtime composes from its live controls. */
function liveWorkOwners(reader: AsyncEventStateReadSurface): LiveWorkOwners {
  return {
    busyWorkflows: async (members) => (await Promise.all(liveWorkflowControls(reader).filter((control) => members.has(control.workflowId)).map(async (control) => await control.state() === "interrupted" ? [] : [control.workflowId]))).flat(),
    onWorkflowChange: (listener) => onLiveWorkChanged(reader, listener),
    progressesWithout: (work, held) => workProgressesWithout(reader, work, held),
    interrupted: async (sessionId) => await liveSessionControl(reader, sessionId)?.state() === "interrupted",
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

/** Tracks a running background command in the session's real registry. Its
 *  completion notification commits when `delivery` resolves, as a mailbox
 *  commits it only once the turn is free. `finish` ends the command. */
function trackCommand(fixture: ReturnType<typeof channelFixture>, sessionId: string, id: string, delivery?: Promise<void>) {
  const registry = fixture.registries.get(sessionId) ?? createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: async () => { await delivery } })
  fixture.registries.set(sessionId, registry)
  const done = deferred<BackgroundWorkResult>()
  registry.track({ done: done.promise, meta: { id, type: "background_command", description: id, toolUseId: id } })
  return {
    finish: async (result: BackgroundWorkResult) => {
      done.resolve(result)
      await done.promise
    },
  }
}

/** The directory the agent runs in, which session/new names. */
const CWD = realpathSync(tmpdir())

/** Initializes the client and opens the root chat as its ACP session. */
const OPEN = [
  { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
  { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: CWD, mcpServers: [] } },
].map((message) => `${JSON.stringify(message)}\n`).join("")

const prompt = (text: string) => `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "root", prompt: [{ type: "text", text }] } })}\n`

/** Runs the channel over ACP, as both headless hosts do, and closes the framing after it. */
async function runChannel(fixture: ReturnType<typeof channelFixture>, transport: Omit<ChatTransport, "framing">) {
  const framing = acpFraming(CWD)
  try {
    return await runHeadlessChatChannel(fixture.client, { ...transport, framing })
  } finally { framing.close() }
}

/** The one-shot invocation of an unattended run whose turn sealed no result. */
const unsealed = { bind: () => {}, result: () => undefined }

describe("headless chat settlement", () => {
  it("releases its input reader and subscription when writing stdout fails", async () => {
    const fixture = channelFixture()
    const input = new PassThrough()
    input.write(OPEN)
    try {
      await expect(runChannel(fixture, { input, write: async () => { throw new Error("closed stdout") } })).rejects.toThrow("closed stdout")
      expect(fixture.subscribed()).toBe(false)
    } finally { input.destroy() }
  })

  it("reports an unanswered question at EOF without dispatching an answer or cancellation", async () => {
    const fixture = channelFixture()
    fixture.questions.set("root", { kind: "question", toolUseId: "ask", questions: [], timestamp: 0 })
    expect(await runChannel(fixture, { input: [OPEN], write: fixture.write })).toBe("input_required")
    expect(fixture.calls).toEqual([{ type: "chat.open" }, { type: "session.activate", sessionId: "root" }])
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
    const pending = runChannel(fixture, { input: [OPEN], write: fixture.write }).then((result) => { ended = true; return result })
    await reached.promise
    expect(ended).toBe(false)
    fixture.views.set("child", child)
    fixture.changed()
    expect(await pending).toBe("complete")
  })

  it.each(["incomplete", "input_required"] as const)("returns one-shot %s after the first prompt with stdin still open", async (outcome) => {
    const fixture = channelFixture()
    if (outcome === "input_required") fixture.questions.set("root", { kind: "question", toolUseId: "ask", questions: [], timestamp: 0 })
    const input = new PassThrough()
    input.write(OPEN + prompt("hello"))
    try {
      expect(await runChannel(fixture, { input, write: fixture.write, completion: unsealed })).toBe(outcome)
      expect(input.writableEnded).toBe(false)
      expect(fixture.calls).toEqual([{ type: "chat.open" }, { type: "session.activate", sessionId: "root" }, { type: "session.send", sessionId: "root", input: "hello" }])
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
    input.write(OPEN + prompt("hello"))
    let ended = false
    const pending = runChannel(fixture, { input, write: fixture.write, completion: unsealed }).then((result) => { ended = true; return result })
    try {
      await reached.promise
      expect(ended).toBe(false)
      fixture.views.set("child", child)
      fixture.changed()
      expect(await pending).toBe("input_required")
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
    const command = kind === "shell" ? trackCommand(fixture, "root", "shell", answered.promise) : undefined
    if (kind === "shell") fixture.questions.set("root", { kind: "question", toolUseId: "ask", questions: [], timestamp: 0 })
    const reached = deferred<void>()
    let reads = 0
    fixture.onRead((query) => { if (query.type === "statusSnapshot") { reads++; reached.resolve() } })
    let ended = false
    const pending = runChannel(fixture, { input: [OPEN], write: fixture.write }).then((result) => { ended = true; return result })
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
    expect(await pending).toBe(kind === "shell" ? "input_required" : "complete")
    answered.resolve()
  })

  it("holds a turn that leaves a server running until the server ends, as the agent loop does", async () => {
    const fixture = channelFixture()
    const root = detail("root")
    fixture.statuses.set("root", { ...root.status, activeBackgroundCommands: [{ id: "server", toolUseId: "server", description: "server", startedAtMs: 0 }] })
    const server = trackCommand(fixture, "root", "server")
    const reached = deferred<void>()
    fixture.onRead((query) => { if (query.type === "statusSnapshot") reached.resolve() })
    let ended = false
    const pending = runChannel(fixture, { input: [OPEN], write: fixture.write }).then((result) => { ended = true; return result })
    await reached.promise
    // A settlement read while the server runs must say busy; the run's own
    // read can still be in flight, so `ended` alone proves nothing.
    expect(await fixture.workSettlement.read("root")).toBe("busy")
    expect(ended).toBe(false)
    await server.finish({ status: "cancelled", content: "" })
    fixture.statuses.set("root", root.status)
    fixture.changed()
    expect(await pending).toBe("complete")
  })

  it.each([false, true])("joins a chat request and the workflow it launches (interrupted=%p)", async (interrupted) => {
    const context = createSupervisorTestContext()
    const reader = asAsyncEventReadSurface(context.store)
    const fixture = channelFixture((sessionIds) => runningChildSessionIds(reader, sessionIds), liveWorkOwners(reader))
    let cut = false
    fixture.launch("root", "workflow", "workflow")
    const admission = deferred<void>()
    fixture.admission(admission.promise)
    let ended = false
    const pending = runChannel(fixture, {
      input: [OPEN + prompt("Launch a workflow for this work")],
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
        fixture.continuations.add("root")
        fixture.changed()
        expect(await pending).toBe("incomplete")
        return
      }
      const parentResult = deferred<void>()
      fixture.pendingTurns.set("root", parentResult.promise)
      unregister()
      fixture.changed()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ended).toBe(false)
      fixture.pendingTurns.delete("root")
      parentResult.resolve()
      expect(await pending).toBe("complete")
    } finally {
      unregister()
      await disposeSupervisorTestContext(context)
    }
  })

  it("settles while another chat of the project, its request, and the workflow it launched still run", async () => {
    const context = createSupervisorTestContext()
    const reader = asAsyncEventReadSurface(context.store)
    const fixture = channelFixture((sessionIds) => runningChildSessionIds(reader, sessionIds), liveWorkOwners(reader))
    const other = detail("other")
    fixture.views.set("other", { ...other, status: { ...other.status, activity: "generating" } })
    fixture.launch("other", "workflow", "workflow")
    const admission = deferred<void>()
    fixture.admission(admission.promise, "other")
    const unregister = registerLiveWorkflowControl(reader, {
      workflowId: "workflow", kind: "workflow", state: async () => "between_steps",
      handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined,
      deliver: async () => ({ status: "refused", reason: "settled" }),
      notify: async () => false,
    })
    try {
      expect(await runChannel(fixture, { input: [OPEN], write: fixture.write })).toBe("complete")
    } finally {
      admission.resolve()
      unregister()
      await disposeSupervisorTestContext(context)
    }
  })

  it("reports input required when a workflow agent waits for a reply from the root chat that waits on a question", async () => {
    const context = createSupervisorTestContext()
    const reader = asAsyncEventReadSurface(context.store)
    const fixture = channelFixture((sessionIds) => runningChildSessionIds(reader, sessionIds), liveWorkOwners(reader))
    fixture.launch("root", "workflow", "workflow")
    fixture.launch("workflow", "member", "workflow-agent")
    // The root chat launched the workflow, which stays its background work.
    const rootWork = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    rootWork.track({ done: new Promise(() => {}), meta: { id: "workflow", type: "workflow", description: "Fix" } })
    fixture.registries.set("root", rootWork)
    const memberWork = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} })
    const member = detail("member")
    fixture.views.set("member", { ...member, status: { ...member.status, waitingOnBackgroundWork: true, replyWaits: [{ sessionId: "root", name: "Root" }] } })
    const unregister = registerLiveWorkflowControl(reader, {
      workflowId: "workflow", kind: "workflow", state: async () => "waiting_on_work",
      workProgress: async () => ({ runnable: false, members: [{ sessionId: "member", conversationId: "conversation-member", state: "waiting_on_work", tasks: memberWork }] }),
      handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined,
      deliver: async () => ({ status: "refused", reason: "settled" }),
      notify: async () => false,
    })
    try {
      const replyWaits: ReplyWaitDeps = { projectionReader: reader, eventWriter: asAsyncEventWriter(context.store), addresseeState: async () => "running", lineage: async (sessionId) => [sessionId] }
      expect(await (await openReplyWait(replyWaits, { waiter: { sessionId: "member", tasks: memberWork }, addressee: { sessionId: "root", name: "Root" }, toolUseId: "ask-parent" })).accepted()).toBe(true)
      // The root chat can still answer its agent, so the workflow runs on.
      expect(await fixture.workSettlement.read("root")).toBe("busy")
      fixture.questions.set("root", { kind: "question", toolUseId: "ask", questions: [], timestamp: 0 })
      fixture.statuses.set("root", { ...detail("root").status, activity: "awaiting_user" })
      // Only the person's answer moves the root chat, and only its reply moves the workflow.
      expect(await fixture.workSettlement.read("root")).toBe("input_required")
      expect(await runChannel(fixture, { input: [OPEN], write: fixture.write })).toBe("input_required")
      expect(memberWork.holdsWait("ask-parent")).toBe(true)
    } finally {
      unregister()
      suspendReplyWaits(reader)
      await disposeSupervisorTestContext(context)
    }
  })

  it.each([false, true])("answers a cancelled prompt once its turn stops while the work it launched keeps running (unattended=%p)", async (unattended) => {
    const context = createSupervisorTestContext()
    const reader = asAsyncEventReadSurface(context.store)
    const fixture = channelFixture((sessionIds) => runningChildSessionIds(reader, sessionIds), liveWorkOwners(reader))
    fixture.launch("root", "workflow", "workflow")
    fixture.launch("workflow", "member", "workflow-agent")
    // A second workflow of the root runs on its own, waiting on no one.
    fixture.launch("root", "independent", "workflow")
    const unregisterIndependent = registerLiveWorkflowControl(reader, {
      workflowId: "independent", kind: "workflow", state: async () => "between_steps",
      handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined,
      deliver: async () => ({ status: "refused", reason: "settled" }),
      notify: async () => false,
    })
    const rootWork = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    rootWork.track({ done: new Promise(() => {}), meta: { id: "workflow", type: "workflow", description: "Fix" } })
    fixture.registries.set("root", rootWork)
    fixture.statuses.set("root", { ...detail("root").status, activity: "generating" })
    let rootState: "running" | "interrupted" = "running"
    const unregisterRoot = registerLiveSessionControl(reader, {
      sessionId: "root", state: async () => rootState,
      deliver: async () => ({ status: "held", reason: "interrupted" }), notify: async () => false,
    })
    const memberWork = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} })
    const member = detail("member")
    fixture.views.set("member", { ...member, status: { ...member.status, waitingOnBackgroundWork: true, replyWaits: [{ sessionId: "root", name: "Root" }] } })
    const unregister = registerLiveWorkflowControl(reader, {
      workflowId: "workflow", kind: "workflow", state: async () => "waiting_on_work",
      workProgress: async () => ({ runnable: false, members: [{ sessionId: "member", conversationId: "conversation-member", state: "waiting_on_work", tasks: memberWork }] }),
      handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined,
      deliver: async () => ({ status: "refused", reason: "settled" }),
      notify: async () => false,
    })
    const input = new PassThrough()
    const answered = deferred<unknown>()
    const write = async (line: string) => {
      const message: { id?: unknown; result?: unknown; error?: unknown } = JSON.parse(line)
      if (message.id === 2) answered.resolve(message.result ?? message.error)
    }
    try {
      // A person's interrupt of the root leaves its agent's wait open (PI-AGENT-025).
      const replyWaits: ReplyWaitDeps = { projectionReader: reader, eventWriter: asAsyncEventWriter(context.store), addresseeState: async () => rootState, lineage: async (sessionId) => [sessionId] }
      expect(await (await openReplyWait(replyWaits, { waiter: { sessionId: "member", tasks: memberWork }, addressee: { sessionId: "root", name: "Root" }, toolUseId: "ask-parent" })).accepted()).toBe(true)
      const reached = deferred<void>()
      fixture.onRead((query) => { if (query.type === "statusSnapshot") reached.resolve() })
      input.write(OPEN + prompt("Launch a workflow for this work"))
      const pending = runChannel(fixture, { input, write, ...(unattended ? { completion: unsealed } : {}) })
      await reached.promise
      expect(await fixture.workSettlement.read("root")).toBe("busy")
      rootState = "interrupted"
      fixture.statuses.set("root", detail("root").status)
      fixture.continuations.add("root")
      // A command the interrupt left running is still the root's work.
      const command = trackCommand(fixture, "root", "build")
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "root" } })}\n`)
      fixture.changed()
      // The interrupt stops the turn, not the command or the workflows.
      expect(await answered.promise).toEqual({ stopReason: "cancelled" })
      expect(fixture.calls).toContainEqual({ type: "chat.interrupt", sessionId: "root" })
      expect(await fixture.workSettlement.read("root")).toBe("busy")
      // A cancel stops an unattended run with its turn.
      if (unattended) expect(await pending).toBe("incomplete")
      expect(await fixture.workSettlement.read("root")).toBe("busy")
      await command.finish({ status: "completed", content: "" })
      unregisterIndependent()
      fixture.changed()
      // Closing input lets the launched work finish; the agent that waits on
      // the interrupted root holds nothing.
      if (!unattended) {
        input.end()
        expect(await pending).toBe("incomplete")
      }
      expect(memberWork.holdsWait("ask-parent")).toBe(true)
    } finally {
      input.destroy()
      unregisterIndependent()
      unregister()
      unregisterRoot()
      suspendReplyWaits(reader)
      await disposeSupervisorTestContext(context)
    }
  })
})

describe("runtime work settlement", () => {
  it("reads only the root's launch tree, however many other sessions the project holds", async () => {
    const perRead = async (unrelated: number) => {
      const context = createSupervisorTestContext()
      try {
        const root = await context.manager.createChat({ name: "Root" })
        for (let index = 0; index < unrelated; index++) await context.manager.createChat({ name: `Other ${index}` })
        const counter = countStateRequests(asAsyncEventReadSurface(context.store))
        const read: string[][] = []
        const client: RuntimeClient = {
          query: runtimeQuery({
            statusSnapshot: async (request) => { read.push([...request.sessionIds]); return { snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: detail(sessionId).status })) } },
            questionSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: null })) }),
          }),
          dispatch: runtimeDispatch({}), close: async () => {}, subscribe: () => () => {},
        }
        const settlement = createRuntimeWorkSettlement({
          ...liveWorkOwners(counter.reader), client,
          members: async (rootSessionId) => sessionSubtree(await heldSessionLineage(counter.reader).replay(), rootSessionId),
          awaitAcceptedWork: async () => {}, runningChildren: (sessionIds) => runningChildSessionIds(counter.reader, sessionIds),
          keptSessions: () => [], failed: () => false, pendingTurnSettlement: () => undefined, backgroundWork: () => undefined,
          requiresContinuation: async () => false, onLiveSessionRemoved: () => () => {},
        })
        // The first read folds the lineage once.
        expect(await settlement.read(root)).toBe("complete")
        counter.take()
        read.length = 0
        for (let index = 0; index < 3; index++) expect(await settlement.read(root)).toBe("complete")
        return { requests: counter.take().length, statusIds: read.flat().length }
      } finally { await disposeSupervisorTestContext(context) }
    }
    const few = await perRead(2)
    expect(await perRead(20)).toEqual(few)
    expect(few.statusIds).toBe(3)
  })
})
