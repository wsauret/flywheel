import { describe, expect, test } from "bun:test"
import { createProjectControlClient, type ProjectControlClientOptions } from "../src/orchestration/app-service/project-control-client.js"
import { connectProjectExecutionChannel } from "../src/orchestration/app-service/project-execution-channel.js"
import { createRuntimeUiBus } from "../src/orchestration/app-service/runtime-ui-bus.js"
import { createReattachableProcessEndpoint } from "../src/infra/reattachable-process-endpoint.js"
import type { InternalProcessEndpoint } from "../src/infra/internal-process-channel.js"
import type { RuntimeClient, FrontendMutation, RuntimeChatDefault } from "../src/protocol/app-service-types.js"
import type { SessionMetadataChange } from "../src/orchestration/session/manager.js"
import type { DurableSessionCatalogRow } from "../src/orchestration/session/session-catalog-types.js"
import type { AuthProfileResolution } from "../src/orchestration/auth/auth-profile-manager.js"
import { projectSessionCatalogRow } from "../src/orchestration/session/session-catalog-row.js"
import type { RuntimeBackgroundLane } from "../src/orchestration/app-service/runtime-background-lane.js"
import { durableRow, durableSessionFromCatalogRow, storedEvents } from "../tests/unit/orchestration/app-service/_frontend-projection-fixtures.js"

const never = <T>(): Promise<T> => new Promise(() => {})

function fixture(executor: RuntimeClient | Promise<RuntimeClient> = never()) {
  const metadata = new Map<string, DurableSessionCatalogRow>()
  const changes = new Set<(change: SessionMetadataChange) => void>()
  const stored = storedEvents()
  const failures: unknown[] = []
  const terminated: (string | undefined)[] = []
  let nextId = 0
  let chatDefault: RuntimeChatDefault = { kind: "pending" }
  const auth: AuthProfileResolution = {
    id: "first", persistedId: "first", displayName: "First", source: "sticky", directory: "/auth/first",
    availableProfiles: [{ id: "first", displayName: "First" }], projectBinding: undefined,
  }
  const notify = (change: SessionMetadataChange) => { for (const listener of changes) listener(change) }
  const history: RuntimeBackgroundLane = {
    start() {},
    recall: never,
    transcriptSearch: never,
    snapshot: never,
    sessionSummaryImmediate: async (ids) => ({
      rows: ids.flatMap((id) => {
        const row = metadata.get(id)
        return row ? [projectSessionCatalogRow(row)] : []
      }),
      errors: [],
      totalsLoading: true,
    }),
    waitForTotals: never,
    sessionDetail: never,
    sessionChangeSummary: never,
    workflowViewSnapshotBatch: never,
    outputWindow: never,
    outputRange: never,
    outputGroupChildren: never,
    outputBlockBody: never,
    moduleSnapshot: never,
    async dispose() {},
  }
  const state: ProjectControlClientOptions["state"] = {
    onStored: stored.onStored,
    sessions: {
      allocateId: () => `local-${++nextId}`,
      async createChat(input) {
        const id = input.id ?? "missing"
        metadata.set(id, durableRow(id, { label: input.name ?? id, name: input.name, conversationId: input.conversationId, lifecycleState: input.initialState ?? "inactive" }))
        notify({ kind: "changed", sessionIds: [id] })
        return id
      },
      listMetadata: async () => ({ sessions: [...metadata.values()], errors: [] }),
      listForIds: async (ids) => ({ sessions: ids.flatMap((id) => {
        const row = metadata.get(id)
        return row ? [row] : []
      }), errors: [] }),
      read: async (id) => durableSessionFromCatalogRow(metadata.get(id)),
      async updateLifecycleState(id, lifecycleState) {
        const row = metadata.get(id)
        if (!row) throw new Error("Missing session")
        metadata.set(id, { ...row, lifecycleState })
        notify({ kind: "changed", sessionIds: [id] })
      },
      async updateLabel(id, labels) {
        const row = metadata.get(id)
        if (!row) return false
        metadata.set(id, { ...row, ...labels })
        notify({ kind: "changed", sessionIds: [id] })
        return true
      },
      async delete(id) {
        metadata.delete(id)
        notify({ kind: "deleted", sessionId: id })
      },
      subscribe(listener) { changes.add(listener); return () => { changes.delete(listener) } },
    },
  }
  const options: ProjectControlClientOptions = {
    state, executor, history, awaitGenerationRecovery: async () => {}, directories: { projectRoot: "/workspace" }, executionCwd: "/workspace", runtimeVersion: "test-version",
    authProfiles: { inspect: () => auth }, onError: (error) => { failures.push(error) },
    chatDefault: () => chatDefault,
    setChatDefault: (value) => { chatDefault = value },
    terminate: async (id) => { terminated.push(id) }, cooperativeStopMs: 1,
  }
  return { options, terminated }
}

function privateExecutor() {
  const bus = createRuntimeUiBus()
  const client: RuntimeClient = {
    query: () => never(),
    dispatch: () => never(),
    subscribe(listener) {
      bus.addListener(listener)
      listener({ type: "runtime.connected", snapshotPosition: 900 })
      return () => bus.removeListener(listener)
    },
    async close() {},
  }
  return { client, bus }
}

/** One socket between the account and the project executor. `drop` models the
 *  socket resetting while the executor process stays alive. */
function transport(onSend: (message: unknown, self: FakeTransport) => void) {
  const messages = new Set<(message: unknown) => void | Promise<void>>()
  const closes = new Set<(reason: Error) => void>()
  const closed = Promise.withResolvers<void>()
  const self = {
    closed: closed.promise,
    async send(message: unknown) { onSend(message, self) },
    onMessage(handler: (message: unknown) => void | Promise<void>) { messages.add(handler); return () => { messages.delete(handler) } },
    onClose(handler: (reason: Error) => void) { closes.add(handler); return () => { closes.delete(handler) } },
    close() { closed.resolve() },
    deliver(message: unknown) { for (const handler of [...messages]) void handler(message) },
    drop(cause: string) { for (const handler of [...closes]) handler(new Error(cause)) },
  }
  return self
}
type FakeTransport = InternalProcessEndpoint<unknown, unknown> & { deliver(message: unknown): void; drop(cause: string): void }

type DispatchEnvelope = { kind: "dispatch"; id: string; mutation: FrontendMutation }
const isDispatch = (message: unknown): message is DispatchEnvelope =>
  typeof message === "object" && message !== null && (message as { kind?: unknown }).kind === "dispatch"

/** An executor that answers every interrupt it receives. */
function answeringTransport(received: FrontendMutation[]) {
  return transport((message, self) => {
    if (!isDispatch(message)) return
    received.push(message.mutation)
    const sessionId = "sessionId" in message.mutation ? message.mutation.sessionId : ""
    queueMicrotask(() => self.deliver({ kind: "result", id: message.id, result: { ok: true, sessionId } }))
  })
}

describe("stopping one session across a brief executor connection drop", () => {
  test("an interrupt in flight when the socket drops is answered by the executor after it reconnects, and nothing is force-stopped", async () => {
    const endpoint = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 10_000 })
    const received: FrontendMutation[] = []
    const first = transport((message, self) => {
      if (!isDispatch(message)) return
      // The socket resets after the interrupt left, before any answer arrives.
      setTimeout(() => {
        self.drop("socket reset")
        setTimeout(() => endpoint.attach(answeringTransport(received)), 5)
      }, 1)
    })
    endpoint.attach(first)
    const channel = connectProjectExecutionChannel(endpoint)
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch: channel.dispatch })
    const client = createProjectControlClient({ ...f.options, cooperativeStopMs: 1_000 })
    try {
      expect(await client.dispatch({ type: "chat.interrupt", sessionId: "one" })).toEqual({ ok: true, sessionId: "one" })
      expect(f.terminated).toEqual([])
      expect(received.map((command) => command.type)).toEqual(["chat.interrupt"])
    } finally {
      await client.close()
      endpoint.close()
      await executor.bus.clear()
    }
  })

  test("a workflow interrupt in flight when the socket drops is also answered after the reconnect", async () => {
    const endpoint = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 10_000 })
    const received: FrontendMutation[] = []
    const first = transport((message, self) => {
      if (!isDispatch(message)) return
      setTimeout(() => {
        self.drop("socket reset")
        setTimeout(() => endpoint.attach(transport((next, live) => {
          if (!isDispatch(next)) return
          received.push(next.mutation)
          queueMicrotask(() => live.deliver({ kind: "result", id: next.id, result: { kind: "interrupt", interrupted: true } }))
        })), 5)
      }, 1)
    })
    endpoint.attach(first)
    const channel = connectProjectExecutionChannel(endpoint)
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch: channel.dispatch })
    const client = createProjectControlClient({ ...f.options, cooperativeStopMs: 1_000 })
    try {
      expect(await client.dispatch({ type: "workflow.interrupt", sessionId: "flow" })).toEqual({ kind: "interrupt", interrupted: true })
      expect(f.terminated).toEqual([])
      expect(received.map((command) => command.type)).toEqual(["workflow.interrupt"])
    } finally {
      await client.close()
      endpoint.close()
      await executor.bus.clear()
    }
  })

  test("a connection that does not come back inside the stop window still force-stops the session", async () => {
    const endpoint = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 10_000 })
    endpoint.attach(transport((message, self) => {
      if (isDispatch(message)) setTimeout(() => self.drop("socket reset"), 1)
    }))
    const channel = connectProjectExecutionChannel(endpoint)
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch: channel.dispatch })
    const client = createProjectControlClient({ ...f.options, cooperativeStopMs: 40 })
    try {
      expect(await client.dispatch({ type: "chat.interrupt", sessionId: "one" })).toEqual({ ok: true, sessionId: "one" })
      expect(f.terminated).toEqual(["one"])
    } finally {
      await client.close()
      endpoint.close()
      await executor.bus.clear()
    }
  })

  test("an interrupt the executor refuses for any other reason still force-stops the session", async () => {
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch: async () => { throw new Error("execution request capacity exceeded") } })
    const client = createProjectControlClient(f.options)
    expect(await client.dispatch({ type: "chat.interrupt", sessionId: "one" })).toEqual({ ok: true, sessionId: "one" })
    expect(f.terminated).toEqual(["one"])
    await client.close()
    await executor.bus.clear()
  })

  test("an interrupt the executor answers in time force-stops nothing", async () => {
    const endpoint = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 10_000 })
    const received: FrontendMutation[] = []
    endpoint.attach(answeringTransport(received))
    const channel = connectProjectExecutionChannel(endpoint)
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch: channel.dispatch })
    const client = createProjectControlClient({ ...f.options, cooperativeStopMs: 1_000 })
    try {
      expect(await client.dispatch({ type: "chat.interrupt", sessionId: "one" })).toEqual({ ok: true, sessionId: "one" })
      expect(f.terminated).toEqual([])
    } finally {
      await client.close()
      endpoint.close()
      await executor.bus.clear()
    }
  })
})
