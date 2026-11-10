import { describe, expect, test } from "bun:test"
import { Rpc } from "effect/rpc"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createProjectControlClient, type ProjectControlClientOptions } from "../../../../src/orchestration/app-service/project-control-client.js"
import { ProjectExecutionChannelDetached, ProjectExecutionStopping } from "../../../../src/orchestration/app-service/project-execution-channel.js"
import type { SessionRow } from "../../../../src/protocol/app-service-types.js"
import { projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import { durableRow } from "./_frontend-projection-fixtures.js"
import { fixture, privateExecutor } from "./_project-control-client-fixture.js"
import { fixture as generationsFixture, servedAfter, settle } from "./_executor-generations-fixture.js"
import { canonicalTestDirectory, temporaryDirectories } from "../../../helpers/directories.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const directory = temporaryDirectories()

/** An executor that attaches every runner it is asked for and takes every release. */
function holdingExecutor() {
  const executor = privateExecutor()
  executor.client.dispatch = recordedDispatch((command) => { executor.commands.push(command) }, runtimeDispatch({
    "session.activate": async (command) => ({ ok: true, sessionId: command.sessionId }),
    "session.release": async () => ({ ok: true }),
    "session.close": async (command) => ({ ok: true, sessionId: command.sessionId }),
  }))
  // The account asks this executor only for the detail of the sessions it holds, which it does not know.
  executor.client.query = runtimeQuery({ sessionDetail: async () => ({ view: null }) })
  return executor
}

const runnerChanges = (executor: ReturnType<typeof privateExecutor>, sessionId: string) =>
  executor.commands.flatMap((command) => "sessionId" in command && command.sessionId === sessionId ? [command.type] : [])
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** The hold grace's timers, which a test runs out, and the project holds the
 *  account takes for a connection that ended. */
function graceClock(projectIdleGraceMs?: number) {
  const timers = new Set<() => void>()
  const delays: number[] = []
  let projectHolds = 0
  const sessionHolds: ProjectControlClientOptions["sessionHolds"] = {
    projectIdleGraceMs,
    setTimer(fire, delayMs) {
      timers.add(fire)
      delays.push(delayMs)
      return () => { timers.delete(fire) }
    },
    holdProject() {
      projectHolds++
      let held = true
      return () => {
        if (held) projectHolds--
        held = false
      }
    },
  }
  return {
    options: { sessionHolds },
    delays,
    pending: () => timers.size,
    projectHolds: () => projectHolds,
    runOut() {
      const due = [...timers]
      timers.clear()
      for (const fire of due) fire()
    },
  }
}

describe("account project control client session holds", () => {
  test("held settled child detail owns its git directory without an executor or store entry", async () => {
    const projectRoot = canonicalTestDirectory(directory("fw-held-project-"))
    const executionCwd = canonicalTestDirectory(directory("fw-held-child-"))
    mkdirSync(join(projectRoot, ".git"))
    writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n")
    mkdirSync(join(executionCwd, ".git"))
    writeFileSync(join(executionCwd, ".git", "HEAD"), "ref: refs/heads/child\n")
    const f = fixture()
    f.metadata.set("child", durableRow("child", { kind: "subagent", executionCwd, parentSessionId: "root" }))
    f.options.history.sessionDetail = async ({ sessionId }) => {
      const metadata = f.metadata.get(sessionId)
      if (!metadata) return { view: null }
      const row = projectSessionCatalogRow(metadata)
      if (row.kind !== "subagent") throw new Error("Expected child detail")
      return { view: { id: sessionId, kind: "subagent", source: "durable", conversationId: "conv-child", budget: null, row, status: {
        activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
        activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0, streamingStartedAt: null,
        accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
      } } }
    }
    const client = createProjectControlClient({ ...f.options, directories: { projectRoot } })
    const terminal = new Rpc.ServerClient(1)
    const browser = new Rpc.ServerClient(2)
    try {
      await client.query({ type: "sessionDetailSnapshot", sessionIds: ["child"] }, terminal)
      await client.query({ type: "sessionDetailSnapshot", sessionIds: ["child"] }, browser)
      expect((await client.query({ type: "gitSnapshot" })).git.directories[executionCwd]).toEqual({ branch: "child" })
      await client.dispatch({ type: "session_detail.release", sessionId: "child" }, terminal)
      expect((await client.query({ type: "gitSnapshot" })).git.directories[executionCwd]).toEqual({ branch: "child" })
      await client.dispatch({ type: "session_detail.release", sessionId: "child" }, browser)
      expect((await client.query({ type: "gitSnapshot" })).git.directories).toEqual({ [projectRoot]: { branch: "main" } })
      expect(f.failures).toEqual([])
    } finally { await client.close() }
  })

  test("the executor hears one background release when the last connection that follows a session's index lets go, by its release or its end", async () => {
    const executor = privateExecutor()
    executor.client.dispatch = recordedDispatch((command) => { executor.commands.push(command) }, runtimeDispatch({ "background.release": async () => ({ ok: true }) }))
    executor.client.query = runtimeQuery({ sessionBackgroundWork: async () => ({ snapshotPosition: 0, rows: [] }) })
    const f = fixture(executor.client)
    const client = createProjectControlClient(f.options)
    const terminal = new Rpc.ServerClient(1)
    const browser = new Rpc.ServerClient(2)
    try {
      await client.query({ type: "sessionBackgroundWork", sessionId: "chat" }, terminal)
      await client.query({ type: "sessionBackgroundWork", sessionId: "chat" }, browser)
      await client.query({ type: "sessionBackgroundWork", sessionId: "child" }, terminal)
      expect(await client.dispatch({ type: "background.release", sessionId: "chat" }, browser)).toEqual({ ok: true })
      await settled()
      // The terminal still follows the chat's index.
      expect(runnerChanges(executor, "chat")).toEqual([])

      client.disconnect(terminal)
      await settled()
      expect(runnerChanges(executor, "chat")).toEqual(["background.release"])
      expect(runnerChanges(executor, "child")).toEqual(["background.release"])
      expect(f.failures).toEqual([])
    } finally { await client.close() }
  })

  test("the executor hears one release when the last connection that shows a session lets go, and the chat stays", async () => {
    const executor = holdingExecutor()
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat", { label: "New Chat", name: "New Chat" }))
    const clock = graceClock()
    const client = createProjectControlClient({ ...f.options, ...clock.options })
    const terminal = new Rpc.ServerClient(1)
    const browser = new Rpc.ServerClient(2)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, terminal)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, browser)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, browser)
    expect(await client.dispatch({ type: "session.release", sessionId: "chat" }, browser)).toEqual({ ok: true })
    await settled()
    // The terminal still shows the session, so its runner stays.
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "session.activate", "session.activate"])

    client.disconnect(terminal)
    client.disconnect(terminal)
    await settled()
    // The terminal's hold outlives its connection for the grace, and the
    // project stays open on its behalf. No client shows the session, so the
    // executor hides it at once.
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "session.activate", "session.activate", "hide"])
    expect(clock.projectHolds()).toBe(1)
    clock.runOut()
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "session.activate", "session.activate", "hide", "session.release"])
    expect(clock.projectHolds()).toBe(0)

    // A release never closes, renames, or removes the chat, an empty one included.
    expect(f.metadata.get("chat")).toMatchObject({ lifecycleState: "active", label: "New Chat" })
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a release or a disconnect during an activation's durable work reaches the executor after the activation", async () => {
    const executor = holdingExecutor()
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    f.metadata.set("other", durableRow("other"))
    const metadataRead = Promise.withResolvers<void>()
    const sessions: ProjectControlClientOptions["state"]["sessions"] = {
      ...f.options.state.sessions,
      read: async (id) => { await metadataRead.promise; return f.options.state.sessions.read(id) },
    }
    const clock = graceClock()
    const client = createProjectControlClient({ ...f.options, ...clock.options, state: { ...f.options.state, sessions } })
    const terminal = new Rpc.ServerClient(1)
    const browser = new Rpc.ServerClient(2)
    const activations = Promise.all([
      client.dispatch({ type: "session.activate", sessionId: "chat" }, terminal),
      client.dispatch({ type: "session.activate", sessionId: "other" }, browser),
    ])
    await client.dispatch({ type: "session.release", sessionId: "chat" }, terminal)
    client.disconnect(browser)
    await settled()
    expect(executor.commands).toEqual([])

    metadataRead.resolve()
    expect((await activations).map((result) => result.ok)).toEqual([true, true])
    clock.runOut()
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "session.release"])
    expect(runnerChanges(executor, "other")).toEqual(["session.activate", "hide", "session.release"])
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a tab's close during an activation's durable work reaches the executor after the activation, so the activation cannot cancel it", async () => {
    const executor = holdingExecutor()
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    const metadataRead = Promise.withResolvers<void>()
    const sessions: ProjectControlClientOptions["state"]["sessions"] = {
      ...f.options.state.sessions,
      read: async (id) => { await metadataRead.promise; return f.options.state.sessions.read(id) },
    }
    const client = createProjectControlClient({ ...f.options, ...graceClock().options, state: { ...f.options.state, sessions } })
    const terminal = new Rpc.ServerClient(1)
    const activation = client.dispatch({ type: "session.activate", sessionId: "chat" }, terminal)
    await client.dispatch({ type: "session.release", sessionId: "chat" }, terminal)
    const close = client.dispatch({ type: "session.close", sessionId: "chat", atRest: true }, terminal)
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual([])

    metadataRead.resolve()
    expect((await activation).ok).toBe(true)
    expect(await close).toEqual({ ok: true, sessionId: "chat" })
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "session.release", "session.close"])
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a connection that ends hides its sessions at once, an activation from any connection inside the grace shows one again and keeps its runner, and the returned connection's release ends it at once", async () => {
    const executor = holdingExecutor()
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    f.metadata.set("other", durableRow("other"))
    // A harness that closes projects after a second shortens the grace too.
    const clock = graceClock(1_000)
    const client = createProjectControlClient({ ...f.options, ...clock.options })
    const phone = new Rpc.ServerClient(1)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, phone)
    await client.dispatch({ type: "session.activate", sessionId: "other" }, phone)
    client.disconnect(phone)
    expect(clock.projectHolds()).toBe(1)
    expect(clock.delays).toEqual([1_000])
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "hide"])
    expect(runnerChanges(executor, "other")).toEqual(["session.activate", "hide"])

    // The phone comes back on a new connection and shows one of its sessions.
    const returned = new Rpc.ServerClient(2)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, returned)
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "hide", "session.activate"])
    expect(clock.projectHolds()).toBe(1)

    // The grace runs out for the session nobody showed again, and only it ends.
    clock.runOut()
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "hide", "session.activate"])
    expect(runnerChanges(executor, "other")).toEqual(["session.activate", "hide", "session.release"])
    expect(clock.projectHolds()).toBe(0)

    await client.dispatch({ type: "session.release", sessionId: "chat" }, returned)
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "hide", "session.activate", "session.release"])
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a hide that its transport cut reaches the same generation once the transport reattaches, before a later activation", async () => {
    const executor = holdingExecutor()
    const g = generationsFixture()
    const generation = g.latest()
    const reattached = Promise.withResolvers<void>()
    let sends = 0
    // The first send is in flight when its socket resets. The channel holds
    // a send made while it is detached until a socket reattaches.
    generation.runtime.hideSession = async (sessionId) => {
      sends += 1
      if (sends === 1) throw new ProjectExecutionChannelDetached(new Error("socket reset"))
      await reattached.promise
      executor.commands.push({ type: "hide", sessionId })
    }
    executor.client.hideSession = (sessionId) => g.generations.withdraw((runtime) => runtime.hideSession(sessionId))
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    const client = createProjectControlClient({ ...f.options, ...graceClock().options })
    await settle()
    const phone = new Rpc.ServerClient(1)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, phone)
    client.disconnect(phone)
    await settled()
    // The phone comes back while the hide waits for its socket.
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, new Rpc.ServerClient(2))
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate"])

    reattached.resolve()
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "hide", "session.activate"])
    expect(sends).toBe(2)
    expect(g.executors).toHaveLength(1)
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a hide is complete when its generation ends while the transport is detached, and reaches no successor", async () => {
    const executor = holdingExecutor()
    const g = generationsFixture()
    const first = g.latest()
    let sends = 0
    // The end closes the channel, which fails the send it held.
    first.runtime.hideSession = async () => {
      sends += 1
      if (sends === 1) throw new ProjectExecutionChannelDetached(new Error("socket reset"))
      first.die("lost its connection to Flywheel", false)
      throw new Error("project execution channel closed")
    }
    executor.client.hideSession = (sessionId) => g.generations.withdraw((runtime) => runtime.hideSession(sessionId))
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    const client = createProjectControlClient({ ...f.options, ...graceClock().options })
    await settle()
    const phone = new Rpc.ServerClient(1)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, phone)
    client.disconnect(phone)
    await settled()
    await servedAfter(g)
    await settled()
    expect(sends).toBe(2)
    expect(g.executors.map((generation) => generation.hidden())).toEqual([[], []])
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a hide that a stopping generation refused never reaches its successor, where a client's activation keeps the session shown", async () => {
    const executor = holdingExecutor()
    const g = generationsFixture()
    const first = g.latest()
    const shown = new Map<number, Set<string>>()
    // Each activation is served by the generation that serves now, which a
    // paused project's activation restarts.
    executor.client.dispatch = recordedDispatch((command) => { executor.commands.push(command) }, runtimeDispatch({
      "session.activate": async (command) => {
        const { generation } = await g.generations.serving("surface")
        shown.set(generation, new Set([...shown.get(generation) ?? [], command.sessionId]))
        return { ok: true, sessionId: command.sessionId }
      },
      "session.release": async () => ({ ok: true }),
    }))
    // The first generation begins its own stop as the hide reaches it.
    first.runtime.hideSession = async () => {
      first.beginEnding("exited with code 0")
      throw new ProjectExecutionStopping()
    }
    executor.client.hideSession = (sessionId) => g.generations.withdraw((runtime) => runtime.hideSession(sessionId))
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    const client = createProjectControlClient({ ...f.options, ...graceClock().options, executionPaused: () => g.generations.current.recovery !== undefined })
    await settle()
    const phone = new Rpc.ServerClient(1)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, phone)
    client.disconnect(phone)
    await settled()

    // The phone comes back while the project is paused, and its activation
    // restarts the executor.
    const activation = client.dispatch({ type: "session.activate", sessionId: "chat" }, new Rpc.ServerClient(2))
    first.close({ settled: true, cause: "exited with code 0" })
    await settle()
    await g.clock.advance(1_000)
    expect((await activation).ok).toBe(true)
    await settled()
    expect(g.executors).toHaveLength(2)
    expect(shown.get(2)).toEqual(new Set(["chat"]))
    expect(g.latest().hidden()).toEqual([])
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a connection that ends after the client's new connection showed its session gives that session no grace and no hide", async () => {
    const executor = holdingExecutor()
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    const clock = graceClock()
    const client = createProjectControlClient({ ...f.options, ...clock.options })
    const stale = new Rpc.ServerClient(1)
    const returned = new Rpc.ServerClient(2)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, stale)
    // The phone comes back before the account sees its old connection end.
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, returned)
    client.disconnect(stale)
    expect(clock.pending()).toBe(0)
    expect(clock.projectHolds()).toBe(0)

    await client.dispatch({ type: "session.release", sessionId: "chat" }, returned)
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "session.activate", "session.release"])
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("an override of the project's idle grace bounds the hold grace, and one that turns the idle close off leaves it", async () => {
    const twentyMinutes = 20 * 60 * 1000
    const cases: ReadonlyArray<readonly [number | undefined, number]> = [[undefined, twentyMinutes], [1_000, 1_000], [2 * twentyMinutes, twentyMinutes], [0, twentyMinutes]]
    for (const [projectIdleGraceMs, graceMs] of cases) {
      const executor = holdingExecutor()
      const f = fixture(executor.client)
      f.metadata.set("chat", durableRow("chat"))
      const clock = graceClock(projectIdleGraceMs)
      const client = createProjectControlClient({ ...f.options, ...clock.options })
      const phone = new Rpc.ServerClient(1)
      await client.dispatch({ type: "session.activate", sessionId: "chat" }, phone)
      client.disconnect(phone)
      expect({ projectIdleGraceMs, delays: clock.delays }).toEqual({ projectIdleGraceMs, delays: [graceMs] })
      await client.close()
      await executor.bus.clear()
    }
  })

  test("a grace that every session's new activation takes over ends with no release", async () => {
    const executor = holdingExecutor()
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    const clock = graceClock()
    const client = createProjectControlClient({ ...f.options, ...clock.options })
    const phone = new Rpc.ServerClient(1)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, phone)
    client.disconnect(phone)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, new Rpc.ServerClient(2))
    await settled()
    expect(clock.pending()).toBe(0)
    expect(clock.projectHolds()).toBe(0)
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "hide", "session.activate"])
    await client.close()
    await executor.bus.clear()
  })

  test("a connection that ends with no session shown takes no grace, and a close ends every grace with no release and takes no new one", async () => {
    const executor = holdingExecutor()
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    f.metadata.set("other", durableRow("other"))
    const clock = graceClock()
    const client = createProjectControlClient({ ...f.options, ...clock.options })
    client.disconnect(new Rpc.ServerClient(1))
    expect(clock.pending()).toBe(0)
    expect(clock.projectHolds()).toBe(0)

    const phone = new Rpc.ServerClient(2)
    const terminal = new Rpc.ServerClient(3)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, phone)
    await client.dispatch({ type: "session.activate", sessionId: "other" }, terminal)
    await settled()
    client.disconnect(phone)
    expect(clock.pending()).toBe(1)
    expect(clock.projectHolds()).toBe(1)
    await client.close()
    expect(clock.pending()).toBe(0)
    expect(clock.projectHolds()).toBe(0)
    // A connection whose stream ends after the close takes no grace.
    client.disconnect(terminal)
    expect(clock.pending()).toBe(0)
    expect(clock.projectHolds()).toBe(0)
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate"])
    expect(runnerChanges(executor, "other")).toEqual(["session.activate"])
    await executor.bus.clear()
  })

  test("a chat a connection shows lists the Resume its detail admits, and is not read once the connection lets go", async () => {
    const f = fixture()
    f.metadata.set("chat", durableRow("chat"))
    let interrupted = true
    let reads = 0
    f.options.history.sessionDetail = async ({ sessionId }) => {
      reads++
      const metadata = f.metadata.get(sessionId)
      if (!metadata) return { view: null }
      const listed = projectSessionCatalogRow(metadata)
      if (listed.kind !== "chat") throw new Error("Expected chat detail")
      const row: Extract<SessionRow, { kind: "chat" }> = { ...listed, admittedActions: interrupted ? ["chat.interrupt", "chat.resume", "session.delete"] : ["chat.interrupt", "session.delete"] }
      return { view: { id: sessionId, kind: "chat", source: "durable", conversationId: "conv-1", budget: null, row, status: {
        activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
        activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0, streamingStartedAt: null,
        accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
      } } }
    }
    const client = createProjectControlClient(f.options)
    const listedActions = async () => (await client.query({ type: "snapshot" })).rows.find((row) => row.id === "chat")?.admittedActions
    const terminal = new Rpc.ServerClient(1)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, terminal)
    await settled()
    expect(await listedActions()).toContain("chat.resume")

    interrupted = false
    f.notify({ kind: "changed", sessionIds: ["chat"] })
    await settled()
    expect(await listedActions()).not.toContain("chat.resume")

    await client.dispatch({ type: "session.release", sessionId: "chat" }, terminal)
    const read = reads
    f.notify({ kind: "changed", sessionIds: ["chat"] })
    await settled()
    expect(reads).toBe(read)
    expect(f.failures).toEqual([])
    await client.close()
  })

  test("a connection that lets go of a chat's read detail keeps the chat's runner and the Resume its row lists", async () => {
    const executor = holdingExecutor()
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    const listed = projectSessionCatalogRow(durableRow("chat"))
    if (listed.kind !== "chat") throw new Error("Expected chat detail")
    const interrupted: Extract<SessionRow, { kind: "chat" }> = { ...listed, admittedActions: ["chat.interrupt", "chat.resume", "session.delete"] }
    // The account asks this executor only for the detail of the chat it holds.
    executor.client.query = runtimeQuery({ sessionDetail: async () => ({ view: { id: "chat", kind: "chat", source: "durable", conversationId: "conv-1", budget: null, row: interrupted, status: {
      activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
      activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0, streamingStartedAt: null,
      accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
    } } }) })
    const client = createProjectControlClient(f.options)
    const terminal = new Rpc.ServerClient(1)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, terminal)
    // A fork the terminal showed before the catalog listed it: its surface
    // read the detail, then let go of it once the row arrived.
    await client.query({ type: "sessionDetailSnapshot", sessionIds: ["chat"] }, terminal)
    expect(await client.dispatch({ type: "session_detail.release", sessionId: "chat" }, terminal)).toEqual({ ok: true })
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate"])
    expect((await client.query({ type: "snapshot" })).rows.find((row) => row.id === "chat")?.admittedActions).toContain("chat.resume")
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a connection that shows the session again after its release reaches the executor in the order asked", async () => {
    const executor = holdingExecutor()
    const f = fixture(executor.client)
    f.metadata.set("chat", durableRow("chat"))
    const client = createProjectControlClient(f.options)
    const terminal = new Rpc.ServerClient(1)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, terminal)
    await client.dispatch({ type: "session.release", sessionId: "chat" }, terminal)
    await client.dispatch({ type: "session.activate", sessionId: "chat" }, terminal)
    await settled()
    expect(runnerChanges(executor, "chat")).toEqual(["session.activate", "session.release", "session.activate"])
    await client.close()
    await executor.bus.clear()
  })
})
