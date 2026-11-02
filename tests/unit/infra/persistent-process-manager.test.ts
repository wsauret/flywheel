import { describe, expect, test } from "bun:test"

import { connectPersistentProcessBridge, servePersistentProcessBridge } from "../../../src/infra/persistent-process-bridge.js"
import type { InternalProcessEndpoint } from "../../../src/infra/internal-process-channel.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import type { PersistentSubprocess } from "../../../src/infra/persistent-subprocess.js"
import { DeadlineExceeded } from "../../../src/infra/with-deadline.js"

function fakeProcess(pid: number): PersistentSubprocess & { stops: number; releases: number; finish(): void } {
  const exit = Promise.withResolvers<number>()
  let status: "running" | "exited" = "running"
  return {
    pid,
    command: ["server"],
    spool: { directory: `/spool/${pid}`, stdoutPath: `/spool/${pid}/stdout`, stderrPath: `/spool/${pid}/stderr` },
    exited: exit.promise,
    stops: 0,
    releases: 0,
    metadata: () => ({ startedAtMs: 1_234, status, stdoutBytes: 8, stderrBytes: 3 }),
    read: () => ({ data: new Uint8Array([1, 2]), nextOffset: 2, eof: true }),
    async stop() { this.stops += 1; return "terminated" as const },
    release() { this.releases += 1 },
    finish() { status = "exited"; exit.resolve(0) },
  }
}

/** Two in-process endpoints joined back to back, the shape the project executor serves the bridge over. */
function endpointPair(): readonly [InternalProcessEndpoint<unknown, unknown>, InternalProcessEndpoint<unknown, unknown>] {
  interface Side {
    readonly messages: Set<(message: unknown) => void | Promise<void>>
    readonly closes: Set<(reason: Error) => void>
    readonly closed: PromiseWithResolvers<void>
    reason?: Error
  }
  const sides: readonly [Side, Side] = [
    { messages: new Set(), closes: new Set(), closed: Promise.withResolvers<void>() },
    { messages: new Set(), closes: new Set(), closed: Promise.withResolvers<void>() },
  ]
  const endpoint = (own: Side, peer: Side): InternalProcessEndpoint<unknown, unknown> => ({
    closed: own.closed.promise,
    async send(message) {
      if (own.reason) throw own.reason
      for (const handler of peer.messages) await handler(message)
    },
    onMessage(handler) {
      own.messages.add(handler)
      return () => own.messages.delete(handler)
    },
    onClose(handler) {
      own.closes.add(handler)
      return () => own.closes.delete(handler)
    },
    close(reason = "test endpoint closed") {
      if (own.reason) return
      own.reason = new Error(reason)
      peer.reason = new Error("test endpoint peer closed")
      own.closed.resolve()
      peer.closed.resolve()
      for (const handler of own.closes) handler(own.reason)
      for (const handler of peer.closes) handler(peer.reason)
    },
  })
  return [endpoint(sides[0], sides[1]), endpoint(sides[1], sides[0])]
}

describe("persistent process manager", () => {
  test("owns persistent processes across ephemeral client generations", async () => {
    const launched: Array<ReturnType<typeof fakeProcess>> = []
    const manager = createPersistentProcessManager({
      launch: async () => {
        const process = fakeProcess(100 + launched.length)
        launched.push(process)
        return process
      },
    })

    const first = manager.client()
    const started = await first.launch(["server"])
    first.close()

    const second = manager.client()
    expect(await second.list()).toEqual([started])
    expect(started).toMatchObject({ startedAtMs: 1_234, status: "running", stdoutBytes: 8, stderrBytes: 3 })
    expect((await second.read(started.id, "stdout", 0, 10)).nextOffset).toBe(2)
    await second.stop(started.id)
    expect(launched[0]?.stops).toBe(1)
    expect(await second.list()).toHaveLength(1)
    launched[0]?.finish()
    await launched[0]?.exited
    expect(await second.list()).toEqual([expect.objectContaining({ id: started.id, status: "exited", exitCode: 0 })])
    expect((await second.read(started.id, "stdout", 0, 10)).nextOffset).toBe(2)
  })

  test("releases a process without terminating it and removes host management", async () => {
    const process = fakeProcess(101)
    const manager = createPersistentProcessManager({ launch: async () => process })
    const client = manager.client()
    const started = await client.launch(["server"])

    await client.release(started.id)

    expect(process.releases).toBe(1)
    expect(process.stops).toBe(0)
    expect(await client.list()).toEqual([])
    await expect(client.stop(started.id)).rejects.toThrow("unknown persistent process")
  })

  test("releases running and exited managed processes exactly once when the CLI host settles", async () => {
    const firstProcess = fakeProcess(201)
    const secondProcess = fakeProcess(202)
    const processes = [firstProcess, secondProcess]
    const manager = createPersistentProcessManager({ launch: async () => processes.shift() ?? fakeProcess(203) })
    const client = manager.client()
    const first = await client.launch(["first"])
    const second = await client.launch(["second"])
    secondProcess.finish()
    await secondProcess.exited

    manager.releaseAll()
    manager.releaseAll()

    expect(await client.list()).toEqual([])
    expect(first.pid).toBe(201)
    expect(second.pid).toBe(202)
    expect(processes).toEqual([])
    expect(firstProcess.releases).toBe(1)
    expect(secondProcess.releases).toBe(1)
  })

  test("keeps host management when a bridged client generation closes", async () => {
    const process = fakeProcess(102)
    const manager = createPersistentProcessManager({ launch: async () => process })
    const firstChannel = new MessageChannel()
    const closeFirstHost = servePersistentProcessBridge({ manager, port: firstChannel.port1, allowLaunch: async () => true })
    const first = connectPersistentProcessBridge(firstChannel.port2)
    const started = await first.launch(["server"])
    first.close()
    await closeFirstHost()

    const secondChannel = new MessageChannel()
    const closeSecondHost = servePersistentProcessBridge({ manager, port: secondChannel.port1, allowLaunch: async () => true })
    const second = connectPersistentProcessBridge(secondChannel.port2)
    expect(await second.list()).toEqual([started])
    await second.release(started.id)
    expect(process.releases).toBe(1)
    second.close()
    await closeSecondHost()
  })

  test("returns structured launch and stop results through the bridge", async () => {
    const process = fakeProcess(103)
    let launchOptions: unknown
    const manager = createPersistentProcessManager({ launch: async (_command, options) => { launchOptions = options; return process } })
    const channel = new MessageChannel()
    const closeHost = servePersistentProcessBridge({ manager, port: channel.port1, allowLaunch: async () => true })
    const client = connectPersistentProcessBridge(channel.port2)
    const started = await client.launch(["server"], { cwd: "/work", env: { MODE: "test" } })

    expect(started).toMatchObject({ pid: 103, status: "running" })
    expect(launchOptions).toEqual({ cwd: "/work", env: { MODE: "test" } })
    process.finish()
    await process.exited
    expect(await client.stop(started.id)).toBe("already_exited")
    client.close()
    await closeHost()
  })

  test("cleans injected request deadlines after timeout, success, and explicit close", async () => {
    const channel = new MessageChannel()
    const requests: Array<{ id: number }> = []
    channel.port2.addEventListener("message", (event) => {
      const value: unknown = event.data
      if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "number") requests.push({ id: value.id })
    })
    channel.port2.start()
    const deadlines: Array<() => void> = []
    let deadlineCleanups = 0
    const client = connectPersistentProcessBridge(channel.port1, {
      requestDeadlineMs: 10,
      setTimer: (fire) => {
        deadlines.push(fire)
        let active = true
        return () => {
          if (!active) return
          active = false
          deadlineCleanups += 1
        }
      },
    })

    // MessageChannel delivery is not bound to one timer turn, so each posted
    // request is awaited instead of assumed after a single sleep.
    const postedRequest = async (index: number, what: string): Promise<number> => {
      for (let attempt = 0; attempt < 1000 && requests[index] === undefined; attempt++) await Bun.sleep(1)
      const id = requests[index]?.id
      if (id === undefined) throw new Error(`${what} bridge request was not posted`)
      return id
    }

    const timedOut = client.list()
    const timedOutId = await postedRequest(0, "timed out")
    deadlines[0]?.()
    await expect(timedOut).rejects.toEqual(new DeadlineExceeded(10))
    expect(deadlineCleanups).toBe(1)

    const succeeded = client.list()
    const successId = await postedRequest(1, "successful")
    channel.port2.postMessage({ id: timedOutId, ok: true, value: [{ late: true }] })
    channel.port2.postMessage({ id: successId, ok: true, value: [] })
    expect(await succeeded).toEqual([])
    expect(deadlineCleanups).toBe(2)

    const closed = client.list()
    client.close()
    await expect(closed).rejects.toThrow("bridge is closed")
    expect(deadlineCleanups).toBe(3)
    channel.port2.close()
  })

  test("does not launch when the client request is dropped", async () => {
    let launches = 0
    const manager = createPersistentProcessManager({ launch: async () => { launches += 1; return fakeProcess(110) } })
    const channel = new MessageChannel()
    const closeHost = servePersistentProcessBridge({ manager, port: channel.port1, allowLaunch: async () => true })
    const post = channel.port2.postMessage.bind(channel.port2)
    channel.port2.postMessage = () => {}
    let fireDeadline = (): void => {}
    const client = connectPersistentProcessBridge(channel.port2, {
      requestDeadlineMs: 10,
      setTimer: (fire) => { fireDeadline = fire; return () => {} },
    })

    const launching = client.launch(["server"])
    fireDeadline()
    await expect(launching).rejects.toEqual(new DeadlineExceeded(10))
    expect(launches).toBe(0)
    channel.port2.postMessage = post
    client.close()
    await closeHost()
  })

  test("does not retry a launch whose host reply is dropped and recovers it through list", async () => {
    let launches = 0
    const manager = createPersistentProcessManager({ launch: async () => { launches += 1; return fakeProcess(111) } })
    const channel = new MessageChannel()
    const hostPost = channel.port1.postMessage.bind(channel.port1)
    channel.port1.postMessage = (message, transfer) => {
      channel.port1.postMessage = hostPost
      void message
      void transfer
    }
    const closeHost = servePersistentProcessBridge({ manager, port: channel.port1, allowLaunch: async () => true })
    let fireDeadline = (): void => {}
    const client = connectPersistentProcessBridge(channel.port2, {
      requestDeadlineMs: 10,
      setTimer: (fire) => { fireDeadline = fire; return () => {} },
    })

    const launching = client.launch(["server"])
    await Bun.sleep(0)
    fireDeadline()
    await expect(launching).rejects.toEqual(new DeadlineExceeded(10))
    expect(launches).toBe(1)
    expect(await client.list()).toHaveLength(1)
    expect(launches).toBe(1)
    client.close()
    await closeHost()
  })

  test("correlates out-of-order distinct replies and isolates malformed, late, and duplicate replies", async () => {
    const channel = new MessageChannel()
    const client = connectPersistentProcessBridge(channel.port1, { requestDeadlineMs: 1_000 })
    const requests: Array<{ id: number; operation: string }> = []
    const requestWaiters = new Map<number, (request: { id: number; operation: string }) => void>()
    const requestAt = (index: number): Promise<{ id: number; operation: string }> => {
      const present = requests[index]
      if (present) return Promise.resolve(present)
      return new Promise((resolve) => { requestWaiters.set(index, resolve) })
    }
    channel.port2.addEventListener("message", (event) => {
      const value: unknown = event.data
      if (typeof value !== "object" || value === null || !("id" in value) || !("operation" in value) || typeof value.id !== "number" || typeof value.operation !== "string") return
      const request = { id: value.id, operation: value.operation }
      const index = requests.push(request) - 1
      requestWaiters.get(index)?.(request)
      requestWaiters.delete(index)
    })
    channel.port2.start()
    const record = (id: string, pid: number) => ({
      id,
      pid,
      command: [id],
      spool: { directory: `/spool/${id}`, stdoutPath: `/spool/${id}/stdout`, stderrPath: `/spool/${id}/stderr` },
      startedAtMs: pid,
      status: "running",
      stdoutBytes: pid,
      stderrBytes: 0,
    })

    const first = client.list()
    const second = client.list()
    const [firstRequest, secondRequest] = await Promise.all([requestAt(0), requestAt(1)])
    const firstId = firstRequest.id
    const secondId = secondRequest.id
    channel.port2.postMessage({ id: secondId, ok: true, value: [record("second", 2)] })
    channel.port2.postMessage({ id: firstId, ok: true, value: [record("first", 1)] })
    expect((await first)[0]?.id).toBe("first")
    expect((await second)[0]?.id).toBe("second")

    const malformed = client.list()
    const malformedId = (await requestAt(2)).id
    channel.port2.postMessage({ id: malformedId, ok: true })
    await expect(malformed).rejects.toThrow("invalid persistent process bridge reply")

    const afterMalformed = client.list()
    const afterMalformedId = (await requestAt(3)).id
    channel.port2.postMessage({ id: firstId, ok: true, value: [record("duplicate", 3)] })
    channel.port2.postMessage({ id: secondId, ok: true, value: [record("late", 4)] })
    channel.port2.postMessage({ id: afterMalformedId, ok: true, value: [] })
    expect(await afterMalformed).toEqual([])
    client.close()
    channel.port2.close()
  })

  test("rejects pending calls when the client closes", async () => {
    const channel = new MessageChannel()
    const client = connectPersistentProcessBridge(channel.port1, { requestDeadlineMs: 1_000 })
    const pending = client.list()
    client.close()

    await expect(pending).rejects.toThrow("bridge is closed")
    channel.port2.close()
  })

  test("denies host-policy launch with no manager dispatch", async () => {
    let launches = 0
    const manager = createPersistentProcessManager({ launch: async () => { launches += 1; return fakeProcess(112) } })
    const channel = new MessageChannel()
    const closeHost = servePersistentProcessBridge({ manager, port: channel.port1, allowLaunch: async () => false })
    const client = connectPersistentProcessBridge(channel.port2)

    await expect(client.launch(["server"])).rejects.toThrow("persistent process launch is not authorized")
    expect(launches).toBe(0)

    client.close()
    await closeHost()
  })

  test("close joins a pending launch admission and never launches after it", async () => {
    let launches = 0
    const manager = createPersistentProcessManager({ launch: async () => { launches += 1; return fakeProcess(114) } })
    const admissionAsked = Promise.withResolvers<void>()
    const admission = Promise.withResolvers<boolean>()
    const channel = new MessageChannel()
    const closeHost = servePersistentProcessBridge({
      manager, port: channel.port1,
      allowLaunch: () => { admissionAsked.resolve(); return admission.promise },
    })
    const client = connectPersistentProcessBridge(channel.port2)
    const launching = client.launch(["server"])
    await admissionAsked.promise

    const closing = closeHost()
    let closeSettled = false
    void closing.then(() => { closeSettled = true })
    await Bun.sleep(0)
    expect(closeSettled).toBe(false)

    admission.resolve(true)
    await closing
    expect(launches).toBe(0)
    client.close()
    await expect(launching).rejects.toThrow("persistent process bridge")
  })

  test("dispatches a repeated launch request ID exactly once", async () => {
    let launches = 0
    const manager = createPersistentProcessManager({ launch: async () => { launches += 1; return fakeProcess(113) } })
    const channel = new MessageChannel()
    const replyIds: unknown[] = []
    const listed = Promise.withResolvers<void>()
    channel.port2.addEventListener("message", (event) => {
      const value: unknown = event.data
      if (typeof value !== "object" || value === null || !("id" in value)) return
      replyIds.push(value.id)
      if (value.id === 2) listed.resolve()
    })
    channel.port2.start()
    const closeHost = servePersistentProcessBridge({ manager, port: channel.port1, allowLaunch: async () => true })

    channel.port2.postMessage({ id: 1, operation: "launch", args: [["server"], undefined] })
    channel.port2.postMessage({ id: 1, operation: "launch", args: [["server"], undefined] })
    // The host handles requests in order, so the list reply proves the repeated ID was already refused.
    channel.port2.postMessage({ id: 2, operation: "list", args: [] })
    await listed.promise

    expect(launches).toBe(1)
    expect(replyIds).toEqual([1, 2])
    await closeHost()
    channel.port2.close()
  })

  test("preserves the complete client contract through internal process endpoints", async () => {
    let launchesAllowed = true
    const process = fakeProcess(701)
    const manager = createPersistentProcessManager({ launch: async () => process })
    const [hostEndpoint, clientEndpoint] = endpointPair()
    const closeHost = servePersistentProcessBridge({ manager, endpoint: hostEndpoint, allowLaunch: async () => launchesAllowed })
    const client = connectPersistentProcessBridge(clientEndpoint, { requestDeadlineMs: 1_000 })

    const started = await client.launch(["endpoint"])
    launchesAllowed = false
    await expect(client.launch(["denied"])).rejects.toThrow("persistent process launch is not authorized")
    launchesAllowed = true
    expect((await client.read(started.id, "stdout", 0, 1)).data).toEqual(new Uint8Array([1, 2]))
    expect(await client.stop(started.id)).toBe("terminated")
    await client.release(started.id)
    expect(process.releases).toBe(1)
    const retained = await client.launch(["retained"])

    client.close()
    await closeHost()

    const [replacementHost, replacementClient] = endpointPair()
    const closeReplacement = servePersistentProcessBridge({ manager, endpoint: replacementHost, allowLaunch: async () => true })
    const replacement = connectPersistentProcessBridge(replacementClient)
    expect(await replacement.list()).toEqual([retained])
    await replacement.release(retained.id)
    replacement.close()
    await closeReplacement()
  })

  test("does not block list while launch awaits and close joins the in-flight launch", async () => {
    const launchStarted = Promise.withResolvers<void>()
    const releaseLaunch = Promise.withResolvers<void>()
    const manager = createPersistentProcessManager({
      launch: async () => {
        launchStarted.resolve()
        await releaseLaunch.promise
        return fakeProcess(900)
      },
    })
    const channel = new MessageChannel()
    const closeHost = servePersistentProcessBridge({ manager, port: channel.port1, allowLaunch: async () => true })
    const client = connectPersistentProcessBridge(channel.port2)
    const launching = client.launch(["delayed"])
    await launchStarted.promise

    expect(await client.list()).toEqual([])
    const closing = closeHost()
    let closeSettled = false
    void closing.then(() => { closeSettled = true })
    await Promise.resolve()
    expect(closeSettled).toBe(false)

    releaseLaunch.resolve()
    await closing
    client.close()
    await Promise.allSettled([launching])

    const replacementChannel = new MessageChannel()
    const closeReplacement = servePersistentProcessBridge({ manager, port: replacementChannel.port1, allowLaunch: async () => true })
    const replacement = connectPersistentProcessBridge(replacementChannel.port2)
    try {
      expect(await replacement.list()).toHaveLength(1)
    } finally {
      replacement.close()
      await closeReplacement()
    }
  })
})
