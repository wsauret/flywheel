import { describe, expect, test } from "bun:test"
import { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"

import type { FrontendEvent, FrontendMutation, MutationResult } from "../../../../src/protocol/app-service-types.js"
import { RuntimeLaneLost } from "../../../../src/protocol/client/connection-failures.js"
import { createOpenSessionKeeper } from "../../../../src/protocol/client/open-session-keeper.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

type Answer = MutationResult | Error
type KeeperMutation = Extract<FrontendMutation, { readonly type: "session.activate" | "session.release" }>

/** A runtime dispatch that answers both mutations the keeper sends with `answer`. */
const keeperDispatch = (answer: (mutation: KeeperMutation) => Promise<MutationResult<KeeperMutation>>) =>
  runtimeDispatch({ "session.activate": answer, "session.release": answer })

function fakeClient() {
  const dispatched: FrontendMutation[] = []
  const answers: Answer[] = []
  const listeners = new Set<(event: FrontendEvent) => void>()
  const timers: Array<() => void> = []
  const lanes = fakeLanes()
  return {
    dispatched,
    answer: (next: Answer) => { answers.push(next) },
    /** The lane breaks. */
    broke: () => {
      lanes.end()
      for (const listener of listeners) listener(LANE_BREAK)
    },
    lanes,
    /** The lane breaks and the next one opens. */
    reattached: () => {
      lanes.end()
      for (const listener of listeners) listener(LANE_BREAK)
      lanes.open()
    },
    invalidated: () => { for (const listener of listeners) listener({ type: "patch", patch: { position: 1, prevPosition: 0, cursor: { scope: "workspace", domain: "runtime" }, payload: { kind: "runtime.invalidate", reason: "overflow" } } }) },
    fireTimers: () => { const due = timers.splice(0); for (const fire of due) fire() },
    pendingTimers: () => timers.length,
    setTimer: (fire: () => void) => { timers.push(fire); return () => { const at = timers.indexOf(fire); if (at >= 0) timers.splice(at, 1) } },
    client: {
      dispatch: keeperDispatch(async (mutation) => {
        dispatched.push(mutation)
        const next = answers.shift() ?? { ok: true }
        if (next instanceof Error) throw next
        return next
      }),
      subscribe: (listener: (event: FrontendEvent) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      onLane: lanes.onLane,
    },
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("open session keeper", () => {
  test("paces initial opens behind the focused view and each background activation answer", async () => {
    const fake = fakeClient()
    const ready = Promise.withResolvers<void>()
    const background = Promise.withResolvers<{ ok: true }>()
    const dispatch = fake.client.dispatch
    fake.client.dispatch = keeperDispatch(async (mutation) => {
      if (mutation.type === "session.activate" && mutation.sessionId === "chat-3") {
        fake.dispatched.push(mutation)
        return await background.promise
      }
      return await dispatch(mutation)
    })
    const keeper = createOpenSessionKeeper({ client: fake.client, focusReady: () => ready.promise })
    try {
      for (const id of ["chat-1", "chat-2", "chat-3"]) keeper.open(id)
      keeper.focus("chat-2")
      await settle()
      expect(fake.dispatched).toEqual([{ type: "session.activate", sessionId: "chat-2" }])
      ready.resolve()
      await settle()
      expect(fake.dispatched).toEqual([
        { type: "session.activate", sessionId: "chat-2" },
        { type: "session.activate", sessionId: "chat-3" },
      ])
      background.resolve({ ok: true })
      await settle()
      expect(fake.dispatched.at(-1)).toEqual({ type: "session.activate", sessionId: "chat-1" })
    } finally {
      ready.resolve()
      background.resolve({ ok: true })
      keeper.dispose()
    }
  })

  test("activates a session when it opens and again on every attach", async () => {
    const fake = fakeClient()
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer })
    keeper.open("chat-1")
    await settle()
    fake.reattached()
    await settle()

    expect(fake.dispatched).toEqual([
      { type: "session.activate", sessionId: "chat-1" },
      { type: "session.activate", sessionId: "chat-1" },
    ])
    keeper.dispose()
  })

  test("an executor invalidation reattaches only sessions in open tabs", async () => {
    const fake = fakeClient()
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer })
    fake.invalidated()
    keeper.open("chat-1")
    await settle()
    fake.invalidated()
    await settle()
    keeper.close("chat-1")
    fake.invalidated()
    await settle()
    expect(fake.dispatched).toEqual([
      { type: "session.activate", sessionId: "chat-1" },
      { type: "session.activate", sessionId: "chat-1" },
      { type: "session.release", sessionId: "chat-1" },
    ])
    keeper.dispose()
  })

  test("keeps asking with backoff while the runtime cannot answer, and stops once it does", async () => {
    const fake = fakeClient()
    fake.answer(new Error("Flywheel's process for this project is not running now."))
    fake.answer(new Error("socket closed"))
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer, random: () => 0 })
    keeper.open("chat-1")
    await settle()
    expect(fake.pendingTimers()).toBe(1)
    fake.fireTimers()
    await settle()
    expect(fake.pendingTimers()).toBe(1)
    fake.fireTimers()
    await settle()

    expect(fake.dispatched).toHaveLength(3)
    expect(fake.pendingTimers()).toBe(0)
    keeper.dispose()
  })

  test("an activation lost with its lane is silent and waits for the next lane, and any other failure is reported and asked again", async () => {
    const fake = fakeClient()
    fake.answer(new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1000 }) }))
    fake.answer(new Error("socket closed"))
    const diagnostics: string[] = []
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer, random: () => 0, onDiagnostic: (message) => diagnostics.push(message) })
    keeper.open("chat-1")
    await settle()
    expect(diagnostics).toEqual([])
    expect(fake.pendingTimers()).toBe(0)
    fake.reattached()
    await settle()

    expect(diagnostics).toEqual(["session keeper: activation failed; retrying"])
    expect(fake.pendingTimers()).toBe(1)
    fake.fireTimers()
    await settle()
    expect(fake.dispatched).toHaveLength(3)
    keeper.dispose()
  })

  test("an activation made between lanes is sent once, on the next lane", async () => {
    const fake = fakeClient()
    // The connection drops a hold that waited for a lane; the lane asks again.
    fake.answer(new RuntimeLaneLost(new Error("a hold made while the connection attached is sent again by its holder on the new lane")))
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer })
    keeper.open("chat-1")
    await settle()
    fake.broke()
    await settle()
    // The break itself asks for nothing.
    expect(fake.dispatched).toHaveLength(1)
    fake.lanes.open()
    await settle()
    expect(fake.dispatched).toHaveLength(2)
    expect(fake.pendingTimers()).toBe(0)
    keeper.dispose()
  })

  test("stops asking when the runtime says the session takes no runner", async () => {
    const fake = fakeClient()
    fake.answer({ ok: false, error: "Unable to activate chat session wf-1" })
    const diagnostics: string[] = []
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer, onDiagnostic: (message) => diagnostics.push(message) })
    keeper.open("wf-1")
    await settle()

    expect(fake.dispatched).toHaveLength(1)
    expect(fake.pendingTimers()).toBe(0)
    expect(diagnostics).toEqual(["session keeper: activation refused"])
    keeper.dispose()
  })

  test("closing a tab releases its session and ends its retries and its reattach", async () => {
    const fake = fakeClient()
    fake.answer(new Error("not yet"))
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer })
    keeper.open("chat-1")
    await settle()
    keeper.close("chat-1")
    fake.fireTimers()
    fake.reattached()
    await settle()

    expect(fake.dispatched).toEqual([
      { type: "session.activate", sessionId: "chat-1" },
      { type: "session.release", sessionId: "chat-1" },
    ])
    keeper.dispose()
  })

  test("a paced lane activates the focused session first and every other one after the focused view is ready, one at a time", async () => {
    const fake = fakeClient()
    let ready = Promise.withResolvers<void>()
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer, focusReady: () => ready.promise })
    for (const id of ["chat-1", "chat-2", "chat-3"]) keeper.open(id)
    keeper.focus("chat-3")
    await settle()
    fake.dispatched.length = 0

    fake.broke()
    ready = Promise.withResolvers<void>()
    fake.lanes.open()
    await settle()
    expect(fake.dispatched).toEqual([{ type: "session.activate", sessionId: "chat-3" }])

    // A person who shows a hidden session before the walk reaches it gets its
    // runner at once, and the walk does not ask for it again.
    keeper.focus("chat-2")
    await settle()
    ready.resolve()
    await settle()
    expect(fake.dispatched.map((mutation) => "sessionId" in mutation ? mutation.sessionId : "")).toEqual(["chat-3", "chat-2", "chat-1"])
    keeper.dispose()
  })

  test("a paced walk asks for the sessions most recently opened or focused first", async () => {
    const fake = fakeClient()
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer, focusReady: async () => {} })
    for (const id of ["chat-1", "chat-2", "chat-3", "chat-4"]) keeper.open(id)
    for (const id of ["chat-1", "chat-3", "chat-2"]) keeper.focus(id)
    await settle()
    fake.dispatched.length = 0

    fake.broke()
    fake.lanes.open()
    await settle()
    expect(fake.dispatched.map((mutation) => "sessionId" in mutation ? mutation.sessionId : "")).toEqual(["chat-2", "chat-3", "chat-1", "chat-4"])
    keeper.dispose()
  })

  test("a paced walk waits for each activation to answer before it asks for the next", async () => {
    const fake = fakeClient()
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer, focusReady: async () => {} })
    keeper.open("chat-1")
    keeper.open("chat-2")
    keeper.focus("chat-1")
    await settle()
    const answered = Promise.withResolvers<{ ok: true }>()
    const dispatch = fake.client.dispatch
    fake.client.dispatch = keeperDispatch(async (mutation) => {
      if (mutation.sessionId === "chat-1") { fake.dispatched.push(mutation); return await answered.promise }
      return await dispatch(mutation)
    })
    fake.dispatched.length = 0
    fake.reattached()
    await settle()
    expect(fake.dispatched).toEqual([{ type: "session.activate", sessionId: "chat-1" }])
    answered.resolve({ ok: true })
    await settle()
    expect(fake.dispatched).toHaveLength(2)
    keeper.dispose()
  })

  test("a focus that moves to a kept session whose granted runner ended activates it again; a hidden one and a live one are not asked for", async () => {
    const fake = fakeClient()
    const ended = new Set<string>()
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer, ended: (id) => ended.has(id) })
    // A session the runtime has not answered for yet is not asked for twice.
    ended.add("chat-1")
    keeper.open("chat-1")
    keeper.focus("chat-1")
    keeper.open("chat-2")
    await settle()
    expect(fake.dispatched).toEqual([{ type: "session.activate", sessionId: "chat-1" }, { type: "session.activate", sessionId: "chat-2" }])
    fake.dispatched.length = 0
    ended.clear()

    keeper.focus("chat-2")
    keeper.focus("chat-1")
    ended.add("chat-2")
    await settle()
    expect(fake.dispatched).toEqual([])
    keeper.focus("chat-2")
    keeper.focus("chat-2")
    await settle()
    expect(fake.dispatched).toEqual([{ type: "session.activate", sessionId: "chat-2" }])
    keeper.dispose()
  })

  test("opening the same session twice asks once", async () => {
    const fake = fakeClient()
    const keeper = createOpenSessionKeeper({ client: fake.client, setTimer: fake.setTimer })
    keeper.open("chat-1")
    keeper.open("chat-1")
    await settle()

    expect(fake.dispatched).toHaveLength(1)
    keeper.dispose()
  })
})
