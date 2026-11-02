import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types.js"
import type { SessionStore } from "../../../../src/orchestration/session-store/types.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { writePreReadinessTurn } from "../../../../src/orchestration/app-service/session-chat-durability.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { createMessageSessionTool } from "../../../../src/orchestration/agent-runtime/tools/message-session.js"
import { registerLiveSessionControl } from "../../../../src/orchestration/session/live-session-control.js"
import { createSessionMessaging } from "../../../../src/orchestration/session/session-messaging.js"
import { publishTestSubagent } from "../session/_session-manager-fixtures.js"
import { createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, supervisorWithRunner, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { unusedChildSessionControl } from "../../../helpers/child-session-control.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

/** A paused chat with the label every new chat has, whose conversation holds
 *  `messages` turns of the person, each its own batch. */
async function pausedChatWithMessages(messages: number): Promise<string> {
  const id = await ctx.manager.createChat({ name: "New Chat", initialState: "inactive" })
  const chat = await ctx.manager.read(id)
  if (chat?.kind !== "chat") throw new Error("expected a chat")
  for (let turn = 0; turn < messages; turn += 1) {
    await writePreReadinessTurn({ sessionId: id, projectRoot: ctx.baseDir, manager: ctx.manager, eventStore: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), eventWriter: asAsyncEventWriter(ctx.store) }, chat.conversationId, `keep me ${turn}`)
  }
  return id
}

describe("RuntimeSupervisor disposal", () => {
  test("disposeAll disposes a startup that completes late and cannot attach", async () => {
    const deferred = createDeferred<ChatRunner>()
    const constructionStarted = createDeferred<void>()
    let attachCalls = 0
    const wrappedStore: SessionStore = {
      ...ctx.sessionStore,
      attachChatRunner: (sessionId, runner) => {
        attachCalls += 1
        return ctx.sessionStore.attachChatRunner(sessionId, runner)
      },
    }
    const runner = mockRunner("disposing")
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, wrappedStore, { createRunner: async () => {
      constructionStarted.resolve()
      return deferred.promise
    } }))
    const sessionId = await supervisor.openSessionRuntime()
    const startup = supervisor.ensureChatRunner(sessionId).catch((err) => err)
    await constructionStarted.promise
    const disposing = supervisor.disposeAll()

    deferred.resolve(runner)
    await disposing
    await startup

    expect(runner.disposeCalls()).toBe(1)
    expect(attachCalls).toBe(0)
    expect(ctx.sessionStore.allIds()).toEqual([])
    expect(await ctx.manager.read(sessionId)).toBeNull()
  })

  test("disposeAll closes the executor's keeper only once every session's close has settled", async () => {
    const order: string[] = []
    const disposing = createDeferred<void>()
    const runner = mockRunner("closing", { dispose: async () => { order.push("session closing"); await disposing.promise; order.push("session closed") } })
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async () => runner }),
      keeper: { terminate: () => false, close: async () => { order.push("keeper closed") } },
    })
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(sessionId)

    const disposed = supervisor.disposeAll()
    for (let attempt = 0; attempt < 100 && !order.includes("session closing"); attempt++) await Bun.sleep(1)
    await Bun.sleep(5)
    expect(order).toEqual(["session closing"])
    disposing.resolve()
    await disposed

    expect(order).toEqual(["session closing", "session closed", "keeper closed"])
  })

  test("disposeAll does not acquire runner capabilities for an empty supervisor", async () => {
    let capabilityLoads = 0
    const base = supervisorBaseDeps(ctx)
    const supervisor = createRuntimeSupervisor({
      ...base,
      runnerCapabilities: async () => {
        capabilityLoads += 1
        return base.runnerCapabilities()
      },
    })

    await supervisor.disposeAll()

    expect(capabilityLoads).toBe(0)
  })

  test("disposeAll settles after runner capability rejection", async () => {
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx),
      runnerCapabilities: async () => { throw new Error("capability rejection") },
    })
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "retained")).resolves.toEqual({ ok: true })
    await Promise.resolve()

    await expect(supervisor.disposeAll()).resolves.toBeUndefined()
  })

  test("disposeAll bounds an unresolved runner capability load", async () => {
    const held = createDeferred<Awaited<ReturnType<ReturnType<typeof supervisorBaseDeps>["runnerCapabilities"]>>>()
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx),
      runnerCapabilities: () => held.promise,
      closeStartupGraceMs: 0,
    })
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "retained")).resolves.toEqual({ ok: true })

    await expect(supervisor.disposeAll()).resolves.toBeUndefined()
  })

  // A stop decides an empty chat by whether a client holds the project as it
  // stops, never by whether a replacement planned it (PI-INTERACTION-075).
  const stops = [{ planned: "an ordinary stop", handoff: undefined }, { planned: "a planned replacement's stop", handoff: "handoff-1" }]
  const stoppingSupervisor = (clientsHold: boolean, handoff: string | undefined) => createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId) }),
    clientsHold: () => clientsHold,
    replacementHandoff: () => handoff,
  })

  test.each(stops)("$planned that no client holds the project through tombstones empty shells and deactivates committed ones in the same pass", async ({ handoff }) => {
    const supervisor = stoppingSupervisor(false, handoff)
    const blankId = await supervisor.openSessionRuntime()
    const committedId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(committedId, "keep me")).resolves.toEqual({ ok: true })

    await supervisor.disposeAll()

    expect(await ctx.manager.read(blankId)).toBeNull()
    expect((await ctx.manager.read(committedId))?.lifecycleState).toBe("inactive")
    expect(ctx.sessionStore.allIds()).toEqual([])
  })

  test.each(stops)("$planned that a client holds the project through keeps an empty shell for the tab that attaches it again", async ({ handoff }) => {
    const supervisor = stoppingSupervisor(true, handoff)
    const blankId = await supervisor.openSessionRuntime()
    // The tab's keeper attached the runner; the person has typed nothing.
    await supervisor.ensureChatRunner(blankId)
    // An earlier stop kept this one, and its tab has not attached it again yet.
    const pausedId = await ctx.manager.createChat({ name: "New Chat", initialState: "inactive" })

    await supervisor.disposeAll()

    expect((await ctx.manager.read(blankId))?.lifecycleState).toBe("inactive")
    expect((await ctx.manager.read(pausedId))?.lifecycleState).toBe("inactive")
    expect(ctx.sessionStore.allIds()).toEqual([])
  })

  test("a stop that no client holds the project through removes every empty chat, open or paused, and keeps every chat with a message, a name, a tab, or a conversation it cannot read", async () => {
    // A stop that a client held, or startup recovery, paused this empty
    // chat, and the client that showed it has left: nothing else removes it.
    const abandoned = await ctx.manager.createChat({ name: "New Chat", initialState: "inactive" })
    // Its first message never earned a title.
    const untitled = await pausedChatWithMessages(1)
    // A person named it "New Chat".
    const named = await ctx.manager.createChat({ name: "New Chat", initialState: "inactive" })
    await ctx.manager.updateLabel(named, { label: "New Chat", shortLabel: "New Chat" }, "user")
    // A tab activated it, and this executor has not opened it yet.
    const activating = await ctx.manager.createChat({ name: "New Chat", initialState: "active" })
    // Bytes that no reader can read may hold the person's message: a row
    // that is not JSON, and a batch that no fact schema or salvage decodes.
    const unreadable = await pausedChatWithMessages(1)
    const undecodable = await pausedChatWithMessages(1)
    const db = new Database(resolveEventStoreDbFile(ctx.baseDir))
    try {
      const damage = async (id: string, payload: string): Promise<void> => {
        const chat = await ctx.manager.read(id)
        if (chat?.kind !== "chat") throw new Error("expected a chat")
        db.run(`update event set payload = ${payload} where aggregate_id = ? and type = 'chat.entries.appended'`, [`conversation:${chat.conversationId}`])
      }
      await damage(unreadable, "'{{broken'")
      await damage(undecodable, "json_object('conversationId', json_extract(payload, '$.conversationId'))")
    } finally {
      db.close()
    }
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async () => { throw new Error("no runner") } }),
      clientsHold: () => false,
    })
    // Open here, and its runner failed to start. The error is not durable,
    // so it keeps nothing: the chat is empty, as it is for the next stop.
    const failed = await supervisor.openSessionRuntime()
    await expect(supervisor.ensureChatRunner(failed)).rejects.toThrow("no runner")

    await supervisor.disposeAll()

    for (const kept of [untitled, named, activating, unreadable, undecodable]) expect(await ctx.manager.read(kept)).not.toBeNull()
    for (const removed of [abandoned, failed]) expect(await ctx.manager.read(removed)).toBeNull()
  })

  test("a paused empty chat that the stop cannot remove keeps no other empty chat from removal", async () => {
    const first = await ctx.manager.createChat({ name: "New Chat", initialState: "inactive" })
    const second = await ctx.manager.createChat({ name: "New Chat", initialState: "inactive" })
    const admitDeletion = ctx.manager.admitDeletion
    let refused: string | undefined
    const refuseFirst = spyOn(ctx.manager, "admitDeletion").mockImplementation(async (id) => {
      if (refused !== undefined) return admitDeletion(id)
      refused = id
      throw new Error("deletion refused")
    })
    try {
      await createRuntimeSupervisor({ ...supervisorBaseDeps(ctx), clientsHold: () => false }).disposeAll()
    } finally {
      refuseFirst.mockRestore()
    }

    expect(refused === first || refused === second).toBe(true)
    for (const id of [first, second]) {
      if (id === refused) expect(await ctx.manager.read(id)).not.toBeNull()
      else expect(await ctx.manager.read(id)).toBeNull()
    }
  })

  test("a stop reads a paused chat's conversation only as far as the person's first message", async () => {
    const batches = 24
    const untitled = await pausedChatWithMessages(batches)
    const chat = await ctx.manager.read(untitled)
    if (chat?.kind !== "chat") throw new Error("expected a chat")
    const conversation = `conversation:${chat.conversationId}`
    let rowsRead = 0
    const deps = supervisorBaseDeps(ctx)
    await createRuntimeSupervisor({
      ...deps,
      projectionReader: {
        ...deps.projectionReader,
        readPage: async (query, ...args) => {
          const page = await deps.projectionReader.readPage(query, ...args)
          if (query.aggregateId === conversation) rowsRead += page.facts.length
          return page
        },
      },
      clientsHold: () => false,
    }).disposeAll()

    expect(await ctx.manager.read(untitled)).not.toBeNull()
    expect(rowsRead).toBeGreaterThan(0)
    expect(rowsRead).toBeLessThan(batches)
  })

  test("a stop ends no reply wait: the waiter gets no notice and keeps the wait's cell for the next runtime", async () => {
    // The registry of live sessions is keyed by the reader the supervisor holds.
    const reader = ctx.runtime.runSync(EventReaderService)
    const messaging = createSessionMessaging({ manager: ctx.manager, projectionReader: reader, eventWriter: asAsyncEventWriter(ctx.store) }, unusedChildSessionControl())
    // The stop cuts the addressee's run: it stops interrupted, and its run
    // observation reports the change, as the run of a real runner does.
    let addresseeState: "running" | "interrupted" = "running"
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, {
        createRunner: async (deps) => mockRunner(deps.sessionId, {
          messageState: async () => addresseeState,
          deliverHeldMessage: async (_message, decide) => decide(addresseeState),
          dispose: async () => {
            addresseeState = "interrupted"
            await (await messaging.observeRun({ sessionId: deps.sessionId })).changed()
          },
        }),
      }),
      clientsHold: () => true,
    })
    const addressee = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(addressee)
    // A child waits on its parent chat.
    const waiter = await publishTestSubagent(ctx.manager, ctx.baseDir, "waiter", addressee)
    const notices: string[] = []
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => { notices.push(text) } })
    const unregister = registerLiveSessionControl(reader, { sessionId: waiter, state: async () => "running", deliver: async (_input, decide) => decide("running"), notify: async () => true })
    try {
      const sent = await createMessageSessionTool(messaging, tasks).execute({ target: "session", to: addressee, text: "Which file?", wait: true }, {
        executionCwd: ctx.baseDir, userDataRoot: `${ctx.baseDir}/.test-account`, projectRoot: ctx.baseDir, artifactScopeId: waiter, retrievalSessionId: waiter, sessionId: waiter, conversationId: `${waiter}-conversation`, toolUseId: "ask-1",
      })
      expect(sent.content).toStartWith(`Waiting on ${addressee}`)

      await supervisor.disposeAll()
      await Bun.sleep(5)
      expect(notices).toEqual([])
      expect(tasks.holdsWait("ask-1")).toBe(true)
      expect(ctx.store.readInFlight(waiter, "session.reply_wait")).toHaveLength(1)
    } finally {
      unregister()
    }
  })

  test("does not create a session actor after disposal starts", async () => {
    const supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))

    await supervisor.disposeAll()

    await expect(supervisor.recallQueuedMessage("late-query")).rejects.toThrow("runtime supervisor is disposed")
  })

  test("reconciles child results during and after disposal without live delivery or a new actor", async () => {
    const calls: string[] = []
    const deps = supervisorBaseDeps(ctx, ctx.sessionStore, {
      reconcileChildSessionCompletions: async (sessionId, options) => {
        expect(options?.deliverNotification).toBeUndefined()
        calls.push(sessionId)
        return { reconciledCount: 1, workflowAggregateReads: 1 }
      },
    })
    const supervisor = createRuntimeSupervisor({
      ...deps,
      lifecycle: {
        ...deps.lifecycle,
        settleSessionStore: async (causeOf) => {
          expect(await supervisor.reconcileChildSessionCompletions("during-stop")).toEqual({ reconciledCount: 1, workflowAggregateReads: 1 })
          await deps.lifecycle.settleSessionStore(causeOf)
        },
      },
    })
    await supervisor.disposeAll()
    expect(await supervisor.reconcileChildSessionCompletions("after-stop")).toEqual({ reconciledCount: 1, workflowAggregateReads: 1 })
    expect(calls).toEqual(["during-stop", "after-stop"])
    expect(supervisor.ownedSessionIds()).toEqual([])
  })
})
