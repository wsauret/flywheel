import { expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import type { SessionChangesUndoResult } from "../../../../src/protocol/session-changes-protocol-types.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import type { ChatRunnerDeps } from "../../../../src/orchestration/chat/runner.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps } from "../../../fixtures/runtime-supervisor-fixtures.js"

const request = { type: "session.changes.undo" as const, sessionId: "s", fileId: "file:a", revision: 0 }
const completed: SessionChangesUndoResult = { status: "completed" }

test("Undo holds the ordered mailbox until settlement without constructing a runner", async () => {
  const ctx = createSupervisorTestContext()
  const started = createDeferred<void>(), settle = createDeferred<SessionChangesUndoResult>()
  let runners = 0
  const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async () => { runners++; throw new Error("No agent allowed") } }), undoChanges: async () => { started.resolve(); return settle.promise } })
  try {
    await ctx.manager.createChat({ id: "s", name: "Before", initialState: "inactive" })
    const undo = supervisor.undoChanges(request)
    await started.promise
    const rename = supervisor.renameSession("s", { title: "After" })
    expect((await ctx.manager.read("s"))?.label).toBe("Before")
    expect(ctx.sessionStore.has("s")).toBe(false)
    settle.resolve(completed)
    expect(await undo).toEqual(completed)
    expect(await rename).toBe(true)
    expect((await ctx.manager.read("s"))?.label).toBe("After")
    expect(runners).toBe(0)
  } finally {
    settle.resolve(completed)
    await supervisor.disposeAll()
    await disposeSupervisorTestContext(ctx)
  }
})

test.each(["close", "delete", "shutdown"] as const)("%s aborts and joins Undo before teardown and denies a queued Undo", async action => {
  const ctx = createSupervisorTestContext()
  const started = createDeferred<AbortSignal>(), settle = createDeferred<SessionChangesUndoResult>()
  let calls = 0, tornDown = false
  const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async () => { throw new Error("No agent allowed") } }), undoChanges: async (_request, signal) => { calls++; started.resolve(signal); return settle.promise } })
  try {
    await ctx.manager.createChat({ id: "s", name: "Before", initialState: "inactive" })
    const undo = supervisor.undoChanges(request)
    const signal = await started.promise
    const queued = supervisor.undoChanges(request)
    const closing = (action === "close" ? supervisor.closeChat("s") : action === "delete" ? supervisor.deleteSession("s") : supervisor.disposeAll()).then(() => { tornDown = true })
    await Bun.sleep(0)
    expect(signal.aborted).toBe(true)
    expect(tornDown).toBe(false)
    expect(await ctx.manager.read("s")).not.toBeNull()
    settle.resolve(completed)
    expect(await undo).toEqual(completed)
    expect(await queued).toEqual({ status: "refused", message: "Session is closing" })
    await closing
    expect(calls).toBe(1)
    expect(tornDown).toBe(true)
    if (action === "delete") expect(await ctx.manager.read("s")).toBeNull()
  } finally {
    settle.resolve(completed)
    if (action !== "shutdown") await supervisor.disposeAll()
    await disposeSupervisorTestContext(ctx)
  }
})

test.each(["close", "delete"] as const)("%s cannot be undone by a queued cold-send activation", async action => {
  const ctx = createSupervisorTestContext()
  const started = createDeferred<AbortSignal>(), settle = createDeferred<SessionChangesUndoResult>()
  let calls = 0, loads = 0, runners = 0, tornDown = false
  const supervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async deps => { runners++; return mockRunner(deps.sessionId) } }),
    sessionViewLoader: { load: id => { loads++; return loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) } },
    undoChanges: async (_request, signal) => { calls++; started.resolve(signal); return settle.promise },
  })
  try {
    await ctx.manager.createChat({ id: "s", conversationId: "conversation:s", name: "Before", initialState: "inactive" })
    const tree = await tryOpenConversationTree({ conversationId: "conversation:s", sessionId: "s", store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
    if (!tree) throw new Error("Missing durable chat tree")
    try {
      expect((await tree.appendMessages([{ kind: "user", content: "Earlier user turn" }])).kind).toBe("committed")
    } finally {
      await tree.getStorage().dispose()
    }
    const undo = supervisor.undoChanges(request)
    const signal = await started.promise
    const coldSend = supervisor.sendChat("s", "Do not start after closure")
    const queuedBefore = supervisor.undoChanges(request)
    const closing = (action === "close" ? supervisor.closeChat("s") : supervisor.deleteSession("s")).then(() => { tornDown = true })
    const activation = supervisor.activateSession("s")
    const queuedAfter = supervisor.undoChanges(request)
    await Bun.sleep(0)
    expect(signal.aborted).toBe(true)
    expect(tornDown).toBe(false)
    expect(ctx.sessionStore.has("s")).toBe(false)
    settle.resolve(completed)
    expect(await undo).toEqual(completed)
    const [sent, before, activated, after] = await Promise.all([coldSend, queuedBefore, activation, queuedAfter])
    await closing
    expect(before).toEqual({ status: "refused", message: "Session is closing" })
    expect(after).toEqual({ status: "refused", message: "Session is closing" })
    expect(sent.ok).toBe(false)
    expect(activated).toBe(false)
    expect(calls).toBe(1)
    expect(loads).toBe(0)
    expect(runners).toBe(0)
    expect(ctx.sessionStore.has("s")).toBe(false)
    if (action === "delete") {
      expect(await ctx.manager.read("s")).toBeNull()
    } else {
      expect(await supervisor.activateSession("s")).toBe(true)
      expect(loads).toBe(1)
      expect(runners).toBe(1)
      expect(await supervisor.sendChat("s", "Explicitly reopen")).toEqual({ ok: true })
      expect(runners).toBe(1)
      expect(await supervisor.undoChanges(request)).toEqual(completed)
      expect(calls).toBe(2)
    }
  } finally {
    settle.resolve(completed)
    await supervisor.disposeAll()
    await disposeSupervisorTestContext(ctx)
  }
})

for (const terminal of ["error", "ended"] as const) {
  test.each(["close", "delete", "shutdown"] as const)(`${terminal} callback aborts Undo synchronously and stays joinable by %s`, async action => {
    const ctx = createSupervisorTestContext()
    const started = createDeferred<AbortSignal>(), settle = createDeferred<SessionChangesUndoResult>()
    const attached = createDeferred<ChatRunnerDeps>()
    const notifications: string[] = []
    let calls = 0, removals = 0, tornDown = false
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, { ...ctx.sessionStore, remove: async id => { removals++; await ctx.sessionStore.remove(id) } }, {
        createRunner: async deps => { attached.resolve(deps); return mockRunner(deps.sessionId) },
        onRunnerError: (_id, message) => { notifications.push(message) },
        onRunnerDone: () => { notifications.push("ended") },
      }),
      undoChanges: async (_request, signal) => { calls++; started.resolve(signal); return settle.promise },
    })
    try {
      const id = await supervisor.openSessionRuntime()
      await supervisor.renameSession(id, { title: "Keep my title" })
      const runner = await supervisor.ensureChatRunner(id)
      const callbacks = await attached.promise
      ctx.sessionStore.updateChatEntry(id, { providerConversationId: "provider-thread", seedContext: "retained seed" })
      const scopedRequest = { ...request, sessionId: id }
      const undo = supervisor.undoChanges(scopedRequest)
      const signal = await started.promise
      const queuedBefore = supervisor.undoChanges(scopedRequest)
      if (terminal === "error") callbacks.onError("Session history flush failed: disk full")
      else callbacks.onEnded()
      expect(signal.aborted).toBe(true)
      expect(removals).toBe(0)
      expect(notifications).toEqual([])
      expect(ctx.sessionStore.get(id)?.runner).toBe(runner)
      const queuedAfter = supervisor.undoChanges(scopedRequest)
      callbacks.onEnded()
      const closing = (action === "close" ? supervisor.closeChat(id) : action === "delete" ? supervisor.deleteSession(id) : supervisor.disposeAll()).then(() => { tornDown = true })
      await Promise.resolve()
      expect(tornDown).toBe(false)
      expect(removals).toBe(0)
      expect(await ctx.manager.read(id)).not.toBeNull()
      settle.resolve(completed)
      expect(await undo).toEqual(completed)
      expect(await queuedBefore).toEqual({ status: "refused", message: "Session is closing" })
      expect(await queuedAfter).toEqual({ status: "refused", message: "Session is closing" })
      await closing
      expect(calls).toBe(1)
      expect(notifications).toEqual([terminal === "error" ? "Session history flush failed: disk full" : "ended"])
      expect(ctx.sessionStore.has(id)).toBe(false)
      if (action === "delete") expect(await ctx.manager.read(id)).toBeNull()
      else expect(await ctx.manager.read(id)).toMatchObject({ lifecycleState: "inactive", label: "Keep my title", providerConversationId: "provider-thread", seedContext: "retained seed" })
    } finally {
      settle.resolve(completed)
      await supervisor.disposeAll()
      await disposeSupervisorTestContext(ctx)
    }
  })
}

// A runner's failure is reported at once, and it keeps nothing: the error is
// not durable, so an empty chat stays empty (PI-INTERACTION-075).
test("a tree-flush failure is reported at once, and a stop that no client holds removes the empty chat once it joins Undo", async () => {
  const ctx = createSupervisorTestContext()
  const started = createDeferred<AbortSignal>(), settle = createDeferred<SessionChangesUndoResult>()
  const attached = createDeferred<ChatRunnerDeps>()
  const supervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async deps => { attached.resolve(deps); return mockRunner(deps.sessionId) } }),
    undoChanges: async (_request, signal) => { started.resolve(signal); return settle.promise },
  })
  try {
    const id = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(id)
    const undo = supervisor.undoChanges({ ...request, sessionId: id })
    const signal = await started.promise
    const callbacks = await attached.promise
    callbacks.onError("Session history flush failed: disk full")
    expect(signal.aborted).toBe(true)
    expect(supervisor.runtimeState(id)).toEqual({ kind: "failed", message: "Session history flush failed: disk full" })
    const closing = supervisor.disposeAll()
    settle.resolve(completed)
    await undo
    await closing
    expect(await ctx.manager.read(id)).toBeNull()
  } finally {
    settle.resolve(completed)
    await supervisor.disposeAll()
    await disposeSupervisorTestContext(ctx)
  }
})

test("runner callback cleanup rejection is contained and does not poison the mailbox", async () => {
  const ctx = createSupervisorTestContext()
  const attached = createDeferred<ChatRunnerDeps>()
  let removals = 0
  const supervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, { ...ctx.sessionStore, remove: async id => {
      removals++
      if (removals === 1) throw new Error("Runtime removal failed")
      await ctx.sessionStore.remove(id)
    } }, { createRunner: async deps => { attached.resolve(deps); return mockRunner(deps.sessionId) } }),
  })
  try {
    const id = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(id)
    const callbacks = await attached.promise
    callbacks.onError("Session history flush failed: disk full")
    expect(await supervisor.renameSession(id, { title: "Retained after failed cleanup" })).toBe(true)
    expect(removals).toBe(1)
    expect(await supervisor.closeChat(id)).toBe(true)
    expect((await ctx.manager.read(id))?.label).toBe("Retained after failed cleanup")
  } finally {
    await supervisor.disposeAll()
    await disposeSupervisorTestContext(ctx)
  }
})

test("Undo on a cold workflow agent does not load, resume, or start agent work", async () => {
  const ctx = createSupervisorTestContext()
  let calls = 0, loads = 0, runners = 0
  const supervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, {
      createRunner: async () => { runners++; throw new Error("No agent allowed") },
    }),
    sessionViewLoader: { load: id => { loads++; return loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) } },
    undoChanges: async () => { calls++; return completed },
  })
  try {
    const workflowId = await publishTestWorkflow(ctx.manager)
    const memberId = await startTestWorkflowMember(ctx.manager, ctx.store, workflowId)
    await ctx.manager.updateLifecycleState(memberId, "inactive")
    expect(await supervisor.undoChanges({ ...request, sessionId: memberId })).toEqual(completed)
    expect(calls).toBe(1)
    expect(loads).toBe(0)
    expect(runners).toBe(0)
    expect(ctx.sessionStore.has(memberId)).toBe(false)
    expect(await ctx.manager.read(memberId)).toMatchObject({ kind: "workflow-agent", lifecycleState: "inactive" })
  } finally {
    await supervisor.disposeAll()
    await disposeSupervisorTestContext(ctx)
  }
})
