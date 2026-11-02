import { describe, expect, test } from "bun:test"
import { createProjectControlClient } from "../../../../src/orchestration/app-service/project-control-client.js"
import { ProjectExecutionChannelDetached } from "../../../../src/orchestration/app-service/project-execution-channel.js"
import { fixture, privateExecutor } from "./_project-control-client-fixture.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

/** Where the send's turn stands in the executor the restart starts. */
interface ExecutedTurn {
  turn: "none" | "running" | "interrupted"
}

/** The executor a restart starts: it answers nothing until `restarted`
 *  settles, then takes a send's turn a moment later, and an interrupt cuts
 *  the turn only once it runs. */
function restartedExecutorDispatch(restarted: Promise<void>, executed: ExecutedTurn) {
  return runtimeDispatch({
    "session.send": async (command) => {
      await restarted
      await Bun.sleep(1)
      executed.turn = "running"
      return { ok: true, sessionId: command.sessionId }
    },
    "chat.interrupt": async (command) => {
      await restarted
      if (executed.turn === "running") executed.turn = "interrupted"
      return { ok: true, sessionId: command.sessionId }
    },
  })
}

describe("account project control interrupts", () => {
  test("an unanswered interrupt stays pending while the executor still answers, and never ends the executor that serves its siblings", async () => {
    const f = fixture()
    const client = createProjectControlClient(f.options)
    let answered = false
    void client.dispatch({ type: "chat.interrupt", sessionId: "one" }).then(() => { answered = true })
    await Bun.sleep(20)
    expect(answered).toBe(false)
    expect(f.terminated).toEqual([])
    f.wedged()
    await Bun.sleep(1)
    await client.close()
  })

  test("an interrupt ends the executor only once it is proven wedged, and names the session it interrupts", async () => {
    const f = fixture()
    const client = createProjectControlClient(f.options)
    const interrupted = client.dispatch({ type: "chat.interrupt", sessionId: "one" })
    await Bun.sleep(1)
    f.wedged()
    expect(await interrupted).toEqual({ ok: true, sessionId: "one" })
    expect(f.terminated).toEqual([{ kind: "interrupt", sessionId: "one" }])
    const workflow = client.dispatch({ type: "workflow.interrupt", workflowId: "two" })
    await Bun.sleep(1)
    f.wedged()
    expect(await workflow).toEqual({ kind: "interrupt", interrupted: true })
    expect(f.terminated).toEqual([{ kind: "interrupt", sessionId: "one" }, { kind: "interrupt", sessionId: "two" }])
    await client.close()
  })

  test("an interrupt the executor refuses carries its reason back, never escalates, and raises nothing", async () => {
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch: async () => { throw new Error("execution request capacity exceeded") } })
    const client = createProjectControlClient(f.options)
    expect(await client.dispatch({ type: "chat.interrupt", sessionId: "one" })).toEqual({ ok: false, error: "execution request capacity exceeded" })
    expect(await client.dispatch({ type: "workflow.interrupt", workflowId: "one" })).toEqual({ kind: "interrupt", interrupted: false, reason: "execution request capacity exceeded" })
    expect(f.terminated).toEqual([])
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("an interrupt of a paused project holds, because nothing runs there", async () => {
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const client = createProjectControlClient({ ...f.options, executionPaused: () => true })
    expect(await client.dispatch({ type: "chat.interrupt", sessionId: "one" })).toEqual({ ok: true, sessionId: "one" })
    expect(await client.dispatch({ type: "subagent.interrupt", sessionId: "child" })).toEqual({ ok: true })
    expect(executor.commands).toEqual([])
    expect(f.terminated).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test.each([
    { kind: "a chat", command: { type: "chat.interrupt", sessionId: "owed" }, interrupted: { ok: true, sessionId: "owed" } },
    { kind: "a workflow", command: { type: "workflow.interrupt", workflowId: "owed" }, interrupted: { kind: "interrupt", interrupted: true } },
    { kind: "a child", command: { type: "subagent.interrupt", sessionId: "owed" }, interrupted: { ok: true } },
  ] as const)("an interrupt of $kind in a paused project with no restart scheduled records, through the state Worker and before it answers, the person's interrupt of a session a successor owes its continuation", async ({ command, interrupted }) => {
    const executor = privateExecutor()
    const requested = Promise.withResolvers<string>()
    const f = fixture({ ...executor.client, dispatch: (sent) => { requested.resolve(`executor: ${sent.type}`); return executor.client.dispatch(sent) } })
    const recorded = Promise.withResolvers<boolean>()
    const client = createProjectControlClient({ ...f.options, executionPaused: () => true, state: { ...f.options.state, sessions: {
      ...f.options.state.sessions,
      interruptOwed: (sessionId) => { requested.resolve(sessionId); return recorded.promise },
    } } })
    let answered = false
    const answer = client.dispatch(command).then((result) => { answered = true; return result })
    expect(await requested.promise).toBe("owed")
    expect(answered).toBe(false)

    recorded.resolve(true)
    expect(await answer).toEqual(interrupted)
    // Nothing reaches an executor, and none is ended.
    expect(executor.commands).toEqual([])
    expect(f.terminated).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("an interrupt of a session whose open tab waits for a person's input in a paused project holds at once, never waiting on that activation", async () => {
    // While a replacement is requested, a tab's activation of a paused
    // project waits for a person's input or the close and schedules nothing.
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch: () => new Promise(() => {}) })
    const client = createProjectControlClient({ ...f.options, executionPaused: () => true, restartScheduled: () => false })
    void client.dispatch({ type: "session.activate", sessionId: "one" })
    const interrupt = client.dispatch({ type: "chat.interrupt", sessionId: "one" })
    expect(await Promise.race([interrupt, Bun.sleep(20).then(() => "still waiting")])).toEqual({ ok: true, sessionId: "one" })
    await client.close()
    await executor.bus.clear()
  })

  test("an interrupt while a restart is scheduled goes to the generation that restart starts, instead of holding at once", async () => {
    // The input that scheduled the restart runs on the generation it
    // starts; the interrupt joins the same restart after it and cuts its turn.
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const client = createProjectControlClient({ ...f.options, executionPaused: () => true, restartScheduled: () => true })
    const interrupt = client.dispatch({ type: "chat.interrupt", sessionId: "one" })
    await Bun.sleep(1)
    expect(executor.commands).toEqual([{ type: "chat.interrupt", sessionId: "one" }])
    expect(f.terminated).toEqual([])
    await client.close()
    await executor.bus.clear()
    void interrupt.catch(() => {})
  })

  test("a send waiting on the scheduled restart and then an interrupt of the same session end with that turn interrupted", async () => {
    // The generation the restart starts takes a moment to accept the send's
    // turn. An interrupt that reached it first would find nothing running
    // and the turn would then run on; it waits for the send instead.
    let paused = true
    const executed: ExecutedTurn = { turn: "none" }
    const restarted = Promise.withResolvers<void>()
    const dispatch = restartedExecutorDispatch(restarted.promise, executed)
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch })
    const client = createProjectControlClient({ ...f.options, executionPaused: () => paused, restartScheduled: () => paused })
    const sent = client.dispatch({ type: "session.send", sessionId: "one", input: "hello" })
    const interrupt = client.dispatch({ type: "chat.interrupt", sessionId: "one" })
    paused = false
    restarted.resolve()
    expect(await sent).toEqual({ ok: true, sessionId: "one" })
    expect(await interrupt).toEqual({ ok: true, sessionId: "one" })
    expect(executed.turn).toBe("interrupted")
    expect(f.terminated).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a send while a restart is scheduled over an opening generation and then an interrupt of the same session end with that turn interrupted", async () => {
    // The restart has started its next generation, so the project no longer
    // reads as paused, but that generation has not yet reported ready: the
    // send still waits for it, and the interrupt still waits for the send.
    let restarting = true
    const executed: ExecutedTurn = { turn: "none" }
    const restarted = Promise.withResolvers<void>()
    const dispatch = restartedExecutorDispatch(restarted.promise, executed)
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch })
    const client = createProjectControlClient({ ...f.options, executionPaused: () => false, restartScheduled: () => restarting })
    const sent = client.dispatch({ type: "session.send", sessionId: "one", input: "hello" })
    const interrupt = client.dispatch({ type: "chat.interrupt", sessionId: "one" })
    restarting = false
    restarted.resolve()
    expect(await sent).toEqual({ ok: true, sessionId: "one" })
    expect(await interrupt).toEqual({ ok: true, sessionId: "one" })
    expect(executed.turn).toBe("interrupted")
    expect(f.terminated).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("an interrupt waiting on a send that is never answered resolves once the generation is proven wedged", async () => {
    // The generation the restart starts accepts the send and then stops
    // answering. The interrupt's escalation is armed while it waits for the
    // send, so the wedge ends that generation and the interrupt holds.
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const client = createProjectControlClient({ ...f.options, executionPaused: () => true, restartScheduled: () => true })
    void client.dispatch({ type: "session.send", sessionId: "one", input: "hello" })
    const interrupt = client.dispatch({ type: "chat.interrupt", sessionId: "one" })
    await Bun.sleep(1)
    f.wedged()
    expect(await interrupt).toEqual({ ok: true, sessionId: "one" })
    expect(f.terminated).toEqual([{ kind: "interrupt", sessionId: "one" }])
    expect(executor.commands).toEqual([{ type: "session.send", sessionId: "one", input: "hello" }])
    await client.close()
    await executor.bus.clear()
  })

  test("an unasked executor exit while an interrupt is in flight waits for that end and its recovery and reports the turn interrupted", async () => {
    // The executor dies with the interrupt unanswered. Its generation reads as
    // ending at once, its channels close, and the call fails; the exit
    // already cut the turn, so the interrupt waits for the recovery and holds.
    let paused = false
    const recovered = Promise.withResolvers<void>()
    const dispatched = Promise.withResolvers<void>()
    const failCall = Promise.withResolvers<never>()
    const dispatch = runtimeDispatch({
      "chat.interrupt": async () => {
        dispatched.resolve()
        return failCall.promise
      },
    })
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch })
    const client = createProjectControlClient({ ...f.options, executionPaused: () => paused, awaitGenerationRecovery: () => recovered.promise })
    let settled: unknown
    const interrupt = client.dispatch({ type: "chat.interrupt", sessionId: "one" }).then((result) => { settled = result; return result })
    await dispatched.promise
    paused = true
    failCall.reject(new Error("project executor terminated"))
    await Bun.sleep(1)
    // The recovery has not settled yet, so neither has the interrupt.
    expect(settled).toBeUndefined()
    recovered.resolve()
    expect(await interrupt).toEqual({ ok: true, sessionId: "one" })
    expect(f.terminated).toEqual([])
    expect(f.failures).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("interrupt in flight at a channel detach is sent again and answered by the reattached executor", async () => {
    // A detach leaves the call's outcome unknown. Escalating would end every
    // session's turn in the project to stop one; the interrupt is idempotent,
    // so it is sent again and the reattached executor answers it.
    let detaches = 3
    const dispatch = runtimeDispatch({
      "chat.interrupt": async (command) => {
        if (detaches-- > 0) { await Bun.sleep(1); throw new ProjectExecutionChannelDetached(new Error("socket reset")) }
        return { ok: true, sessionId: command.sessionId }
      },
    })
    const executor = privateExecutor()
    const f = fixture({ ...executor.client, dispatch })
    const client = createProjectControlClient(f.options)
    expect(await client.dispatch({ type: "chat.interrupt", sessionId: "one" })).toEqual({ ok: true, sessionId: "one" })
    expect(f.terminated).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("the snapshot carries the executor state the generations owner states", async () => {
    const f = fixture()
    f.executor({ kind: "restarting", since: 5, cause: "stopped by signal SIGKILL" })
    const client = createProjectControlClient(f.options)
    expect((await client.query({ type: "snapshot" })).executor).toEqual({ kind: "restarting", since: 5, cause: "stopped by signal SIGKILL" })
    await client.close()
  })
})
