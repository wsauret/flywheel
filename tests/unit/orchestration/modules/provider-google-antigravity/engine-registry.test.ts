import { describe, expect, test } from "bun:test"

import { createEngineRegistry, type EnginePlace } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine-registry.js"
import { fakeLaunches, settle, tool } from "./_fake-engine.js"

const place = (treeRootSessionId: string, loginDir: string, tools = [tool("read"), tool("bash")]): EnginePlace => ({ treeRootSessionId, loginDir, accountId: `account-of-${loginDir}`, tools })

describe("the engine registry", () => {
  test("every agent of one tree on one login shares one process; another tree or another login opens its own", async () => {
    const { launch, engines } = fakeLaunches()
    const registry = createEngineRegistry(launch)
    // Three agents of tree A with different tool grants: the place names the tree's whole tool surface.
    const parent = registry.lease(place("A", "/login-1"))
    const child = registry.lease(place("A", "/login-1"))
    const grandchild = registry.lease(place("A", "/login-1"))
    const [first, second, third] = await Promise.all([parent.engine(), child.engine(), grandchild.engine()])
    const otherTree = await registry.lease(place("B", "/login-1")).engine()
    const otherLogin = await registry.lease(place("A", "/login-2")).engine()

    expect(new Set([first, second, third]).size).toBe(1)
    expect(engines.map(({ processId, place: { treeRootSessionId, loginDir } }) => ({ processId, treeRootSessionId, loginDir }))).toEqual([
      { processId: "p1", treeRootSessionId: "A", loginDir: "/login-1" },
      { processId: "p2", treeRootSessionId: "B", loginDir: "/login-1" },
      { processId: "p3", treeRootSessionId: "A", loginDir: "/login-2" },
    ])
    expect([otherTree.processId, otherLogin.processId]).toEqual(["p2", "p3"])
    await registry.drain()
  })

  test("the last release closes the process once its open prompt settled, and drain waits for that close", async () => {
    const { launch, engines } = fakeLaunches()
    const registry = createEngineRegistry(launch)
    const lease = registry.lease(place("A", "/login-1"))
    const sibling = registry.lease(place("A", "/login-1"))
    const engine = await lease.engine()
    const settlePrompt = engine.openPrompt()
    await sibling.release()
    expect(engine.closes).toEqual([])
    const released = lease.release()
    await settle()
    expect(engine.closes).toEqual([])
    settlePrompt()
    await released
    expect(engines[0]?.closes).toEqual(["released"])
    await registry.drain()
  })

  test("a drain ends at once a close that still waits for an open prompt", async () => {
    const { launch } = fakeLaunches()
    const registry = createEngineRegistry(launch)
    const lease = registry.lease(place("A", "/login-1"))
    const engine = await lease.engine()
    engine.openPrompt()
    void lease.release()
    await settle()
    await registry.drain()
    expect(engine.exited).toBe(true)
    expect(engine.closes[0]).toBe("shutdown")
  })

  test("a tool that the running process lacks replaces it at once while it is idle, and only after its open prompt otherwise", async () => {
    const { launch, events } = fakeLaunches()
    const registry = createEngineRegistry(launch)
    const lease = registry.lease(place("A", "/login-1", [tool("read")]))
    const idle = await lease.engine()
    registry.lease(place("A", "/login-1", [tool("read"), tool("bash")]))
    await settle()
    expect(idle.closes).toEqual(["replaced"])
    const replaced = await lease.engine()
    expect(replaced.toolNames).toEqual(new Set(["read", "bash"]))

    const settlePrompt = replaced.openPrompt()
    registry.lease(place("A", "/login-1", [tool("web")]))
    await settle()
    // The open prompt keeps its process, and the lease still returns it, until the prompt settles.
    expect(replaced.closes).toEqual([])
    expect(await lease.engine()).toBe(replaced)
    settlePrompt()
    await settle()
    expect(replaced.closes).toEqual(["replaced"])
    const third = await lease.engine()
    expect(third.toolNames).toEqual(new Set(["read", "bash", "web"]))
    // A lease that names only tools the process has, also fewer, replaces nothing.
    registry.lease(place("A", "/login-1", [tool("read")]))
    await settle()
    expect(events).toEqual(["start p1 read", "end p1", "start p2 read,bash", "end p2", "start p3 read,bash,web"])
    await registry.drain()
  })

  test("a process that ended or failed to launch is never returned again: the next use launches a new one", async () => {
    const { launch, failNextLaunch } = fakeLaunches()
    const registry = createEngineRegistry(launch)
    const lease = registry.lease(place("A", "/login-1"))
    const first = await lease.engine()
    first.end()
    await settle()
    const second = await lease.engine()
    expect(second.processId).toBe("p2")
    second.end()
    await settle()
    failNextLaunch(new Error("launch failed"))
    expect(lease.engine()).rejects.toThrow("launch failed")
    await settle()
    expect((await lease.engine()).processId).toBe("p3")
    await registry.drain()
  })

  test("the preferred account of a tree is the account of its running process", async () => {
    const { launch } = fakeLaunches()
    const registry = createEngineRegistry(launch)
    const lease = registry.lease(place("A", "/login-2"))
    expect(registry.preferredAccount("A")).toBeUndefined()
    const engine = await lease.engine()
    await settle()
    expect(registry.preferredAccount("A")).toBe("account-of-/login-2")
    expect(registry.preferredAccount("B")).toBeUndefined()
    engine.end()
    await settle()
    expect(registry.preferredAccount("A")).toBeUndefined()
    await registry.drain()
  })

  test("a logout closes the processes of its login after their open prompts, runs its work once they exited, and launches nothing on the login until the work settled", async () => {
    const { launch, engines } = fakeLaunches()
    const registry = createEngineRegistry(launch)
    const lease = registry.lease(place("A", "/login-1"))
    const onLogin = await lease.engine()
    const otherTree = await registry.lease(place("B", "/login-1")).engine()
    const otherLogin = await registry.lease(place("A", "/login-2")).engine()
    const settlePrompt = onLogin.openPrompt()
    const work = Promise.withResolvers<string>()
    let workStarted = false
    const loggedOut = registry.withLoginReleased("/login-1", undefined, () => {
      workStarted = true
      return work.promise
    })
    await settle()
    expect([onLogin.exited, otherTree.exited, otherLogin.exited, workStarted]).toEqual([false, true, false, false])
    settlePrompt()
    await settle()
    expect([onLogin.exited, otherLogin.exited, workStarted]).toEqual([true, false, true])

    // A lease taken during the work, and the earlier lease, launch nothing on the login until the work settled.
    const during = registry.lease(place("C", "/login-1")).engine()
    const again = lease.engine()
    await settle()
    expect(engines).toHaveLength(3)
    work.resolve("logged out")
    expect(await loggedOut).toBe("logged out")
    const [fresh, relaunched] = await Promise.all([during, again])
    expect([fresh.processId, relaunched.processId].toSorted()).toEqual(["p4", "p5"])
    await registry.drain()
  })

  test("a logout waits for a process that a last release is still closing, and an aborted logout runs no work", async () => {
    const { launch, engines } = fakeLaunches({ exitOnClose: false })
    const registry = createEngineRegistry(launch)
    const lease = registry.lease(place("A", "/login-1"))
    await lease.engine()
    void lease.release()
    await settle()
    expect(engines[0]?.closes).toEqual(["released"])
    let ran = false
    const loggedOut = registry.withLoginReleased("/login-1", undefined, async () => { ran = true })
    await settle()
    expect(ran).toBe(false)
    engines[0]?.end()
    await loggedOut
    expect(ran).toBe(true)

    const second = registry.lease(place("A", "/login-1"))
    await second.engine()
    void second.release()
    const abort = new AbortController()
    let abortedRan = false
    const aborted = registry.withLoginReleased("/login-1", abort.signal, async () => { abortedRan = true })
    abort.abort(new Error("logout cancelled"))
    expect(aborted).rejects.toThrow("logout cancelled")
    await settle()
    expect(abortedRan).toBe(false)
    engines[1]?.end()
    await registry.drain()
  })

  test("a release and a new lease of the same place never run two processes at once", async () => {
    const { launch, engines } = fakeLaunches({ exitOnClose: false })
    const registry = createEngineRegistry(launch)
    const first = registry.lease(place("A", "/login-1"))
    const old = await first.engine()
    const released = first.release()
    const next = registry.lease(place("A", "/login-1")).engine()
    await settle()
    expect(engines).toHaveLength(1)
    old.end()
    await released
    const replacement = await next
    expect(replacement.processId).toBe("p2")
    const drained = registry.drain()
    replacement.end()
    await drained
  })

  test("a drain waits for a launch in flight and a replacement's close, and nothing launches after it", async () => {
    const { launch, engines, holdNextLaunch } = fakeLaunches({ exitOnClose: false })
    const registry = createEngineRegistry(launch)
    const lease = registry.lease(place("A", "/login-1", [tool("read")]))
    const replaced = await lease.engine()
    // A tool added: the idle process closes for its replacement, which waits until the old one exited.
    registry.lease(place("A", "/login-1", [tool("read"), tool("bash")]))
    await settle()
    expect(replaced.closes).toEqual(["replaced"])
    const resume = holdNextLaunch()
    const launching = registry.lease(place("B", "/login-1")).engine()
    await settle()

    let drained = false
    const drain = registry.drain().then(() => { drained = true })
    await settle()
    expect(drained).toBe(false)
    replaced.end()
    resume()
    const late = await launching
    await settle()
    expect(late.closes).toEqual(["shutdown"])
    expect(drained).toBe(false)
    late.end()
    await drain
    // The replacement never launched: the drain came first.
    expect(engines.map(({ processId }) => processId)).toEqual(["p1", "p2"])
    expect(lease.engine()).rejects.toThrow("shutting down")
  })
})
