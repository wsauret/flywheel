import { describe, expect, test } from "bun:test"
import { pack } from "msgpackr"
import { createReattachableProcessEndpoint } from "../../../../src/infra/reattachable-process-endpoint.js"
import { createSocketProcessEndpoint, type SocketConnection } from "../../../../src/infra/internal-process-channel.js"
import {
  connectProjectExecutionChannel,
  PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS,
  ProjectExecutionStopping,
  serveProjectExecutionChannel,
} from "../../../../src/orchestration/app-service/project-execution-channel.js"
import type {
  FrontendEvent,
  MutationResult,
  RuntimeQuery,
  RuntimeQueryResult,
} from "../../../../src/protocol/app-service-types.js"
import { runtimeUiPatchFixtures } from "../../protocol/runtime-ui-patch-fixtures.js"
import { deferred, endpointPair, markerEvent, markerPosition, requestFrame, responseFrame, runtimeHarness } from "./project-execution-channel-fixtures.js"
import { recordedDispatch, recordedQuery, runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

describe("project execution channel", () => {
  test("delivers every canonical patch leaf once with exact cursor and positions", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const stop = serveProjectExecutionChannel(harness.runtime, serverEndpoint)
    const client = connectProjectExecutionChannel(clientEndpoint)
    const events: FrontendEvent[] = []
    const received = deferred<void>()
    client.subscribe((event) => {
      events.push(event)
      if (events.length === runtimeUiPatchFixtures.length) received.resolve()
    })

    for (const patch of runtimeUiPatchFixtures) harness.emit({ type: "patch", patch })
    await received.promise

    expect(events).toEqual(runtimeUiPatchFixtures.map((patch) => ({ type: "patch", patch })))
    await client.close()
    await stop()
  })

  test("ships each event as the one encoding of its frame", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const sent: unknown[] = []
    const stop = serveProjectExecutionChannel(harness.runtime, {
      ...serverEndpoint,
      async send(message) {
        sent.push(message)
        await serverEndpoint.send(message)
      },
    })
    const client = connectProjectExecutionChannel(clientEndpoint)
    const received = deferred<FrontendEvent>()
    client.subscribe((event) => received.resolve(event))
    // Each encoding lists the payload's keys once. The transport copies the
    // packed bytes as they are, so a second encoding is a second listing.
    let listings = 0
    const payload = new Proxy({ kind: "executor.changed", executor: { kind: "serving" } } as const, {
      ownKeys(target) { listings++; return Reflect.ownKeys(target) },
    })

    harness.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "executor" }, position: 1, prevPosition: 0, payload } })

    expect(await received.promise).toEqual(markerEvent(1))
    expect(listings).toBe(1)
    expect(sent).toEqual([{ kind: "events", frames: [expect.any(Uint8Array)] }])
    await client.close()
    await stop()
  })

  test("bounds a distinct-session flood behind a slow send with one gap and keeps delivering during the repair", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const release = deferred<void>()
    const blocked = deferred<void>()
    let sends = 0
    const harness = runtimeHarness()
    const stop = serveProjectExecutionChannel(harness.runtime, {
      ...serverEndpoint,
      async send(message) {
        if (++sends === 1) { blocked.resolve(); await release.promise }
        await serverEndpoint.send(message)
      },
    })
    const client = connectProjectExecutionChannel(clientEndpoint)
    const lost = Promise.withResolvers<never>()
    clientEndpoint.onClose((error) => lost.reject(error))
    void lost.promise.catch(() => {})
    // Output keeps flowing while the account repairs: the event emitted
    // mid-repair must arrive, and must not cost a second repair.
    const duringRepair = deferred<void>()
    client.subscribe((event) => { if (markerPosition(event) === 42) duringRepair.resolve() })
    let repairs = 0
    const repaired = deferred<void>()
    client.onOutputGap(async () => {
      repairs += 1
      expect(await client.query({ type: "commandUsageSnapshot" })).toMatchObject({ snapshotPosition: 7 })
      expect(await client.dispatch({ type: "session.close", sessionId: "s" })).toMatchObject({ ok: true })
      harness.emit(markerEvent(42))
      repaired.resolve()
    })
    // About 11 MB behind a blocked send: one overflow of the 8 MB bound.
    harness.emit(markerEvent(1))
    await blocked.promise
    const title = "x".repeat(2_000)
    for (let i = 0; i < 5_000; i++) {
      harness.emit({ type: "patch", patch: { cursor: { scope: "session", domain: "session", sessionId: `s-${i}` }, position: i + 1, prevPosition: 0, payload: { kind: "session.updated", row: { id: `s-${i}`, kind: "chat", title, lifecycleState: "inactive", notices: [], inputMode: { kind: "chat" }, lastUpdated: "now", executionCwd: "/project", totalsLoading: true } } } })
    }
    expect(sends).toBe(1)
    release.resolve()
    await Promise.race([Promise.all([repaired.promise, duringRepair.promise]), lost.promise])
    await client.query({ type: "commandUsageSnapshot" })
    expect(repairs).toBe(1)
    expect(harness.closeCalls).toBe(0)
    await client.close()
    await stop()
  })

  test("drains replies for calls admitted before its stop, and refuses each call it reads after, so the caller knows that call never ran", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const entered = deferred<void>()
    const result = deferred<MutationResult>()
    const harness = runtimeHarness()
    const dispatch = runtimeDispatch({
      "session.close": async () => {
        entered.resolve()
        return await result.promise
      },
    })
    // The executor's stop closes admission before the channel's drain begins.
    let admits = true
    const stop = serveProjectExecutionChannel({ ...harness.runtime, dispatch }, serverEndpoint, { admits: () => admits })
    const client = connectProjectExecutionChannel(clientEndpoint)
    // A refusal is read by a plain await: Bun's `expect(pending).rejects`
    // holds back the MessagePort event that settles the call.
    const failureOf = (call: Promise<unknown>): Promise<Error | undefined> => call.then(() => undefined, (error: unknown) => error instanceof Error ? error : undefined)
    const reply = client.dispatch({ type: "session.close", sessionId: "s" })
    await entered.promise
    admits = false
    expect(await failureOf(client.query({ type: "commandUsageSnapshot" }))).toBeInstanceOf(ProjectExecutionStopping)
    const draining = stop.drain()
    result.resolve({ ok: true })
    await draining
    expect(await reply).toEqual({ ok: true })
    // A call read after that reply, once the drain began, is refused the same way.
    expect(await failureOf(client.query({ type: "commandUsageSnapshot" }))).toBeInstanceOf(ProjectExecutionStopping)
    await client.close()
    await stop()
  })

  test("round-trips every public dispatch result family through its codec", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const dispatch = runtimeDispatch({
      "session.close": async () => ({ ok: true, sessionRemoved: true }),
      "background.warm": async () => undefined,
      "workflow.interrupt": async () => ({ kind: "interrupt", interrupted: true }),
      "command.invoke": async () => ({ kind: "warning", message: "Command warning" }),
      "mcp.authenticate": async () => ({ ok: false, error: "Authentication required" }),
      "config.mutate": async () => ({ kind: "committed", revision: 2 }),
      "model.save_effort": async () => ({ label: "Saved effort" }),
      "model.reset_assignments": async () => ({ rows: [] }),
      "provider_model.set": async () => ({
        profileId: "profile-1",
        eligibilityRevision: 2,
        target: { kind: "singleton", providerId: "anthropic" },
        row: { modelId: "claude", checked: true, optInAvailable: true, configured: true },
      }),
      "provider_models.deselect_all": async () => ({
        profileId: "profile-1",
        eligibilityRevision: 2,
        target: { kind: "singleton", providerId: "anthropic" },
        providerDisplayName: "Anthropic",
        catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
        rows: [],
      }),
      "provider_models.set_auto_enable": async () => ({ profileId: "profile-1", eligibilityRevision: 2, autoEnableNewModels: false }),
      "auth.login": async () => ({ kind: "needs_key", providerId: "anthropic", displayName: "Anthropic" }),
    })
    const runtime = {
      ...harness.runtime,
      dispatch,
    }
    const stop = serveProjectExecutionChannel(runtime, serverEndpoint)
    const client = connectProjectExecutionChannel(clientEndpoint)

    expect(await client.query({ type: "commandUsageSnapshot" })).toEqual({
      snapshotPosition: 7,
      usage: { uses: [{ name: "ship", count: 2 }] },
    })
    expect(await client.dispatch({ type: "session.close", sessionId: "session-1" })).toEqual({
      ok: true,
      sessionRemoved: true,
    })
    expect(await client.dispatch({ type: "background.warm" })).toBeUndefined()
    expect(await client.dispatch({ type: "workflow.interrupt", workflowId: "session-1" })).toEqual({
      kind: "interrupt",
      interrupted: true,
    })
    expect(await client.dispatch({ type: "command.invoke", id: "test", revision: 1 })).toEqual({
      kind: "warning",
      message: "Command warning",
    })
    expect(await client.dispatch({ type: "mcp.authenticate", server: "test" })).toEqual({
      ok: false,
      error: "Authentication required",
    })
    expect(await client.dispatch({
      type: "config.mutate",
      setting: { id: "showThinking", expected: { kind: "absent" }, desired: true },
    })).toEqual({ kind: "committed", revision: 2 })
    expect(await client.dispatch({
      type: "model.save_effort",
      scope: { kind: "defaults" },
      slot: { kind: "role", roleId: "chat" },
      model: "claude",
      effort: "high",
    })).toEqual({ label: "Saved effort" })
    expect(await client.dispatch({
      type: "model.reset_assignments",
      scope: { kind: "defaults" },
      slots: [{ kind: "role", roleId: "chat" }],
    })).toEqual({ rows: [] })
    const target = { kind: "singleton" as const, providerId: "anthropic" }
    expect(await client.dispatch({
      type: "provider_model.set",
      queriedProfileId: "profile-1",
      queriedEligibilityRevision: 1,
      target,
      modelId: "claude",
      checked: true,
    })).toMatchObject({ profileId: "profile-1", row: { modelId: "claude", checked: true } })
    const deselected = await client.dispatch({
      type: "provider_models.deselect_all",
      queriedProfileId: "profile-1",
      queriedEligibilityRevision: 1,
      target,
    })
    if ("hidden" in deselected) throw new Error("provider target unexpectedly disappeared")
    expect(deselected.rows).toEqual([])
    expect(await client.dispatch({ type: "provider_models.set_auto_enable", queriedProfileId: "profile-1", queriedEligibilityRevision: 1, enabled: false }))
      .toEqual({ profileId: "profile-1", eligibilityRevision: 2, autoEnableNewModels: false })
    expect(await client.dispatch({ type: "auth.login", providerId: "anthropic" })).toEqual({
      kind: "needs_key",
      providerId: "anthropic",
      displayName: "Anthropic",
    })
    await client.close()
    await stop()
  })

  test("redacts external execution errors before sending them", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-")
    const stop = serveProjectExecutionChannel({
      ...harness.runtime,
      dispatch: runtimeDispatch({
        "session.close": async () => { throw new Error(`provider rejected ${secret}`) },
      }),
    }, serverEndpoint)
    const client = connectProjectExecutionChannel(clientEndpoint)

    await expect(client.dispatch({ type: "session.close", sessionId: "session-1" }))
      .rejects.toMatchObject({ message: "provider rejected [redacted secret]" })

    await client.close()
    await stop()
  })

  test("delivers a catalog-sized burst of events whole, with no gap", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const stop = serveProjectExecutionChannel(harness.runtime, serverEndpoint)
    const client = connectProjectExecutionChannel(clientEndpoint)
    let gaps = 0
    client.onOutputGap(async () => { gaps += 1 })
    const received: number[] = []
    client.subscribe((event) => { if (event.type === "patch") received.push(event.patch.position) })

    // The background hydration publishes one row per session in one tick.
    for (let position = 1; position <= 311; position += 1) {
      const row = { id: `session-${position}`, kind: "chat" as const, title: `Chat ${position}`, lifecycleState: "inactive" as const, notices: [], inputMode: { kind: "chat" as const }, lastUpdated: "now", executionCwd: "/project", totalsLoading: true as const }
      harness.emit({ type: "patch", patch: { cursor: { scope: "session", domain: "session", sessionId: row.id }, position, prevPosition: 0, payload: { kind: "session.updated", row } } })
    }
    while (received.length < 311) await Bun.sleep(1)
    expect(received).toEqual(Array.from({ length: 311 }, (_, index) => index + 1))
    expect(gaps).toBe(0)

    await client.close()
    await stop()
  })

  test("bounds queued events by their packed bytes and signals one gap when they exceed the cap", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    let gate = deferred<void>()
    let inFlight = deferred<void>()
    const harness = runtimeHarness()
    const stop = serveProjectExecutionChannel(harness.runtime, {
      ...serverEndpoint,
      async send(message) {
        inFlight.resolve()
        await gate.promise
        await serverEndpoint.send(message)
      },
    })
    const client = connectProjectExecutionChannel(clientEndpoint)
    let gaps = 0
    const recovered = deferred<void>()
    client.onOutputGap(async () => { gaps += 1; recovered.resolve() })
    const positions: number[] = []
    const twoDelivered = deferred<void>()
    client.subscribe((event) => {
      if (event.type === "patch") positions.push(event.patch.position)
      if (positions.length === 2) twoDelivered.resolve()
    })
    // The title packs to 5 MB and escapes to 30 MB of JSON, so one queued
    // event fits the 8 MB bound only when its packed frame is what counts.
    const title = "\u0001".repeat(5_000_000)
    const row = { id: "session-1", kind: "chat" as const, title, lifecycleState: "active" as const, notices: [], inputMode: { kind: "chat" as const }, lastUpdated: "now", executionCwd: "/project", totalsLoading: true as const }
    const emit = (position: number) => harness.emit({ type: "patch", patch: { cursor: { scope: "session", domain: "session", sessionId: "session-1" }, position, prevPosition: position - 1, payload: { kind: "session.updated", row } } })

    // Each first event is in flight behind the closed gate; the rest queue.
    emit(1)
    await inFlight.promise
    emit(2)
    gate.resolve()
    await Promise.race([twoDelivered.promise, recovered.promise])
    expect(gaps).toBe(0)

    gate = deferred<void>()
    inFlight = deferred<void>()
    emit(3)
    await inFlight.promise
    emit(4)
    emit(5)
    gate.resolve()
    await recovered.promise
    expect(positions).toEqual([1, 2, 3])
    expect(gaps).toBe(1)

    await client.close()
    await stop()
  })

  test("passes event order through while filtering transport-local events", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const stop = serveProjectExecutionChannel(harness.runtime, serverEndpoint)
    const client = connectProjectExecutionChannel(clientEndpoint)
    const events: FrontendEvent[] = []
    const received = deferred<void>()
    client.subscribe((event) => { events.push(event); if (events.length === 2) received.resolve() })

    harness.emit({ type: "runtime.startup", status: { kind: "phase", label: "test" } })
    harness.emit(markerEvent(3))
    harness.emit(markerEvent(4))
    await received.promise

    expect(events).toEqual([markerEvent(3), markerEvent(4)])
    await client.close()
    await stop()
  })

  test("skips an additive private patch before strict known-frame validation", async () => {
    const [peer, clientEndpoint] = endpointPair()
    const client = connectProjectExecutionChannel(clientEndpoint)
    const events: FrontendEvent[] = []
    const received = deferred<void>()
    client.subscribe((event) => {
      events.push(event)
      received.resolve()
    })

    await peer.send({
      kind: "events",
      frames: [
        pack({
          type: "patch",
          patch: {
            cursor: { scope: "session", domain: "status", sessionId: "session-1" },
            position: 1,
            prevPosition: 0,
            payload: { kind: "status.future", private: true },
          },
        }),
        // A lane frame is the client lane's own and never crosses this channel.
        pack({ type: "runtime.connected" }),
        pack(markerEvent(1)),
      ],
    })
    await received.promise

    expect(events).toEqual([markerEvent(1)])
    await client.close()
  })

  test("ignores a malformed known event and continues with the next valid event", async () => {
    const [peer, clientEndpoint] = endpointPair()
    const client = connectProjectExecutionChannel(clientEndpoint)
    const events: FrontendEvent[] = []
    const received = deferred<void>()
    client.subscribe((event) => {
      events.push(event)
      received.resolve()
    })

    await peer.send({
      kind: "events",
      frames: [
        pack({
          type: "patch",
          patch: {
            cursor: { scope: "session", domain: "status", sessionId: "session-1" },
            position: 1,
            prevPosition: 0,
            payload: { kind: "status.updated" },
          },
        }),
        pack(markerEvent(2)),
      ],
    })
    await received.promise

    expect(events).toEqual([markerEvent(2)])
    await client.close()
  })

  test("ignores invalid messages and unknown correlations without losing the channel", async () => {
    const [serverEndpoint, peerEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const stop = serveProjectExecutionChannel(harness.runtime, serverEndpoint)
    const replyIds: string[] = []
    peerEndpoint.onMessage((value) => { replyIds.push(requestFrame(value).id) })
    await peerEndpoint.send({ kind: "query", id: "", query: { type: "commandUsageSnapshot" } })
    await peerEndpoint.send({ kind: "query", id: "valid", query: { type: "commandUsageSnapshot" } })
    await Bun.sleep(10)
    expect(replyIds).toEqual(["valid"])
    expect(harness.subscriptions).toBe(1)
    await stop()

    const [peer, clientEndpoint] = endpointPair()
    const client = connectProjectExecutionChannel(clientEndpoint)
    await peer.send({ kind: "result", id: "not-pending", result: {} })
    await Bun.sleep(10)
    let closed = false
    void clientEndpoint.closed.then(() => { closed = true })
    await Bun.sleep(1)
    expect(closed).toBe(false)
    await client.close()
  })

  test("rejects pending calls when the transport is lost", async () => {
    const [peer, clientEndpoint] = endpointPair()
    const client = connectProjectExecutionChannel(clientEndpoint)
    const pending = client.dispatch({ type: "session.close", sessionId: "session-1" })
    peer.close("executor exited")
    await expect(pending).rejects.toThrow("internal process endpoint peer closed")
  })

  test("rejects server overflow before runtime execution", async () => {
    const [serverEndpoint, peer] = endpointPair()
    type UsageResult = RuntimeQueryResult<Extract<RuntimeQuery, { readonly type: "commandUsageSnapshot" }>>
    const calls: Array<ReturnType<typeof deferred<UsageResult>>> = []
    const query = runtimeQuery({
      commandUsageSnapshot: () => {
        const call = deferred<UsageResult>()
        calls.push(call)
        return call.promise
      },
    })
    const runtime = { ...runtimeHarness().runtime, query }
    const stop = serveProjectExecutionChannel(runtime, serverEndpoint)
    const responses: Array<{ kind: string; message?: string }> = []
    const overflow = deferred<void>()
    peer.onMessage((value) => {
      responses.push(responseFrame(value))
      if (responses.some((response) => response.kind === "error")) overflow.resolve()
    })

    for (let index = 0; index <= PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS; index += 1) {
      await peer.send({
        kind: "query",
        id: `query-${index}`,
        query: { type: "commandUsageSnapshot" },
      })
    }
    await overflow.promise
    expect(calls).toHaveLength(PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS)
    expect(responses).toContainEqual(expect.objectContaining({ kind: "error", message: expect.stringContaining("capacity") }))

    for (const call of calls) call.resolve({ snapshotPosition: 1, usage: { uses: [] } })
    await stop()
  })

  test("the executor applies a watch statement before it serves a call the account sent after it", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const order: string[] = []
    const runtime = {
      ...harness.runtime,
      watchOutput(sessionIds: readonly string[]) { order.push(`watch ${sessionIds.join(",")}`) },
      query: recordedQuery((query) => { order.push(`query ${query.type}`) }, harness.runtime.query),
    }
    const stop = serveProjectExecutionChannel(runtime, serverEndpoint)
    const client = connectProjectExecutionChannel(clientEndpoint)
    void client.query({ type: "commandUsageSnapshot" })
    client.watchOutput(["a", "b"])
    await client.query({ type: "commandUsageSnapshot" })
    expect(order).toEqual(["query commandUsageSnapshot", "watch a,b", "query commandUsageSnapshot"])
    await client.close()
    await stop()
  })

  test("the executor takes a hide before an activation the account sent right after it, and answers the hide once it is taken", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const order: string[] = []
    const stop = serveProjectExecutionChannel({
      ...harness.runtime,
      async hideSession(sessionId: string) { order.push(`hide ${sessionId}`) },
      dispatch: recordedDispatch((mutation) => { order.push(`dispatch ${mutation.type}`) }, runtimeDispatch({ "session.activate": async (command) => ({ ok: true, sessionId: command.sessionId }) })),
    }, serverEndpoint)
    const client = connectProjectExecutionChannel(clientEndpoint)
    const hidden = client.hideSession("chat")
    await client.dispatch({ type: "session.activate", sessionId: "chat" })
    expect(order).toEqual(["hide chat", "dispatch session.activate"])
    await expect(hidden).resolves.toBeUndefined()
    await client.close()
    await stop()
  })

  test("a watch statement that waits for room on a full socket is still applied before a smaller call sent after it", async () => {
    // The account's end of a socket whose peer reads nothing until `release`,
    // as an executor busy with a large message does.
    let held = true
    const limits = { decode: (value: unknown) => value, maxFrameBytes: 1024 * 1024, maxMessageBytes: 1024 * 1024, maxQueuedBytes: 4096 }
    const writer = (peer: () => SocketConnection<unknown, unknown>, holds: boolean) => ({
      write(bytes: Uint8Array) {
        if (holds && held) return 0
        peer().receive(bytes.slice())
        return bytes.byteLength
      },
      end() { peer().lost("peer closed") },
    })
    const account: SocketConnection<unknown, unknown> = createSocketProcessEndpoint({ socket: writer(() => executor, true), ...limits })
    const executor: SocketConnection<unknown, unknown> = createSocketProcessEndpoint({ socket: writer(() => account, false), ...limits })
    const harness = runtimeHarness()
    const order: string[] = []
    const stop = serveProjectExecutionChannel({
      ...harness.runtime,
      watchOutput(sessionIds: readonly string[]) { order.push(`watch ${sessionIds.length}`) },
      query: recordedQuery((query) => { order.push(`query ${query.type}`) }, harness.runtime.query),
      dispatch: recordedDispatch((mutation) => { order.push(`dispatch ${mutation.type}`) }, harness.runtime.dispatch),
    }, executor.endpoint)
    const client = connectProjectExecutionChannel(account.endpoint)
    try {
      // Most of the queue, held there, then a statement that does not fit
      // beside it, then a read that does.
      const closed = client.dispatch({ type: "session.close", sessionId: "s".repeat(3000) })
      await new Promise((resolve) => setImmediate(resolve))
      client.watchOutput(Array.from({ length: 200 }, (_, index) => `session-${index}`))
      const read = client.query({ type: "commandUsageSnapshot" })
      held = false
      account.drain()
      await Promise.all([closed, read])
      expect(order).toEqual(["dispatch session.close", "watch 200", "query commandUsageSnapshot"])
    } finally {
      await client.close()
      await stop()
    }
  })

  test("server cleanup drains its channel without closing the runtime owner", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const stop = serveProjectExecutionChannel(harness.runtime, serverEndpoint)
    connectProjectExecutionChannel(clientEndpoint)

    await stop()

    expect(harness.subscriptions).toBe(0)
    expect(harness.closeCalls).toBe(0)
  })
})

test("a detached transport fails calls in flight and a reattached one is repaired once, with no handshake", async () => {
  const [first, firstPeer] = endpointPair()
  const facade = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 10_000 })
  facade.attach(first)
  const client = connectProjectExecutionChannel(facade)
  let repairs = 0
  const sent: unknown[] = []
  client.onOutputGap(async () => { repairs += 1 })

  const pending = client.query({ type: "commandUsageSnapshot" })
  await Bun.sleep(5)
  firstPeer.close("socket reset")
  await first.closed
  await expect(pending).rejects.toThrow("detached")

  const [second, secondPeer] = endpointPair()
  secondPeer.onMessage((value) => { sent.push(value) })
  facade.attach(second)
  await Bun.sleep(10)
  expect(repairs).toBe(1)
  expect(sent).toEqual([])
  await client.close()
})

test("a reattached transport states the current watched union before the calls that waited for it", async () => {
  const [first, firstPeer] = endpointPair()
  const facade = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 10_000 })
  facade.attach(first)
  let union: readonly string[] = ["a"]
  const client = connectProjectExecutionChannel(facade, { watchedOutput: () => union })
  client.onOutputGap(async () => {})
  client.watchOutput(union)
  firstPeer.close("socket reset")
  await first.closed
  union = ["a", "b"]
  client.watchOutput(union)
  void client.query({ type: "commandUsageSnapshot" }).catch(() => {})

  const [second, secondPeer] = endpointPair()
  const sent: unknown[] = []
  secondPeer.onMessage((value) => { sent.push(value) })
  facade.attach(second)
  await Bun.sleep(10)
  expect(sent[0]).toEqual({ kind: "watch", sessionIds: ["a", "b"] })
  expect(sent.slice(1).map((value) => typeof value === "object" && value !== null && "kind" in value ? value.kind : undefined)).toEqual(["query"])
  await client.close()
})
