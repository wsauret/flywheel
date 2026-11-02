import { describe, expect, test } from "bun:test"

import { threadProcessProbeSource, type OwnedChild, type OwnedExitStatus, type OwnedProcessBackend, type ThreadProcessProbe } from "../../../src/infra/owned-subprocess-backend.js"
import { connectOwnedProcessBridge, serveOwnedProcessBridge, type OwnedProcessBridge } from "../../../src/infra/owned-process-bridge.js"
import { createOwnedProcess } from "../../../src/infra/owned-subprocess.js"
import type { GuardianControl, LauncherScope, OwnershipClosure } from "../../../src/infra/process-supervisor.js"
import type { GuardianCommand, GuardianLeaseOutcome } from "../../../src/infra/process-guardian-protocol.js"
import type { ContainerRef, ManagedContainer } from "../../../src/infra/process-container.js"

const GUARDIAN_PID = 4242

function fakeChild() {
  let settle: (status: OwnedExitStatus) => void = () => {}
  const exited = new Promise<OwnedExitStatus>((resolve) => { settle = resolve })
  const child: OwnedChild = { stdin: undefined, stdout: undefined, stderr: undefined, exited }
  return {
    child,
    exit(code: number | null, signal: NodeJS.Signals | null, statusOf: OwnedExitStatus["statusOf"] = "payload") {
      settle({ code, signal, statusOf })
    },
  }
}

describe("owned process settlement", () => {
  test("surrenders ownership before any caller observes the exit", async () => {
    const order: string[] = []
    const fake = fakeChild()
    const owned = createOwnedProcess({
      pid: 7,
      token: "owned:1",
      child: fake.child,
      release: async () => { order.push("release") },
      stop: () => {},
    })

    fake.exit(0, null)
    await owned.exited
    order.push("observed")

    expect(order).toEqual(["release", "observed"])
  })

  test("releases ownership once no matter how many callers await the settlement", async () => {
    let releases = 0
    const fake = fakeChild()
    const owned = createOwnedProcess({
      pid: 7,
      token: "owned:1",
      child: fake.child,
      release: async () => { releases += 1 },
      stop: () => {},
    })

    fake.exit(3, null)
    const [first, second] = await Promise.all([owned.exited, owned.exited])

    expect(first).toEqual({ code: 3, signal: null, statusOf: "payload", ownership: "surrendered" })
    expect(second).toEqual({ code: 3, signal: null, statusOf: "payload", ownership: "surrendered" })
    expect(releases).toBe(1)
  })

  test("asks the container to stop once and yields one settlement", async () => {
    let stops = 0
    const fake = fakeChild()
    const owned = createOwnedProcess({
      pid: 7,
      token: "owned:1",
      child: fake.child,
      release: async () => {},
      stop: () => {
        stops += 1
        fake.exit(null, "SIGKILL")
      },
    })

    const [first, second] = await Promise.all([owned.terminate(), owned.terminate()])

    expect(stops).toBe(1)
    expect(first.signal).toBe("SIGKILL")
    expect(second).toBe(first)
  })

  test("neither settles nor releases while the container is still alive", async () => {
    let released = false
    let settled = false
    const fake = fakeChild()
    const owned = createOwnedProcess({
      pid: 7,
      token: "owned:1",
      child: fake.child,
      release: async () => { released = true },
      // A container whose leader exited while a descendant held the group has
      // not ended: its supervisor is still emptying it, so nothing settles.
      stop: () => {},
    })
    void owned.exited.then(() => { settled = true })

    void owned.terminate()
    await Bun.sleep(5)

    expect(settled).toBe(false)
    expect(released).toBe(false)

    fake.exit(0, null)
    await owned.exited

    expect(released).toBe(true)
  })

  test("reports an unacknowledged release instead of a settlement nobody proved", async () => {
    const fake = fakeChild()
    const owned = createOwnedProcess({
      pid: 7,
      token: "owned:1",
      child: fake.child,
      release: async () => { throw new Error("guardian is gone") },
      stop: () => {},
    })

    fake.exit(0, null)

    // The container is gone, so its exit status is real. The lease is not: the
    // owner reads this and keeps holding the container instead of reporting a
    // settlement the guardian never acknowledged.
    expect(await owned.exited).toEqual({ code: 0, signal: null, statusOf: "payload", ownership: "unacknowledged" })
  })

  test("says when the status is a dead supervisor's rather than the payload's", async () => {
    const fake = fakeChild()
    const owned = createOwnedProcess({
      pid: 7,
      token: "owned:1",
      child: fake.child,
      release: async () => {},
      stop: () => {},
    })

    fake.exit(null, "SIGKILL", "supervisor")

    expect(await owned.exited).toEqual({ code: null, signal: "SIGKILL", statusOf: "supervisor", ownership: "surrendered" })
  })
})

interface BridgeBackendProbe {
  readonly backend: OwnedProcessBackend
  readonly launched: number[]
  readonly admitted: number[]
  readonly stopped: number[]
  /** Ends one container the way an outside kill does, so a test can act as the
   *  guardian emptying what a generation still held. */
  end(pid: number): void
}

/** Containers without processes: every launch answers with a child the test
 *  drives, so the bridge is exercised without spawning anything. A stop exits
 *  the child, which is what a real container's supervisor does. */
function bridgeBackend(): BridgeBackendProbe {
  const launched: number[] = []
  const admitted: number[] = []
  const stopped: number[] = []
  const children = new Map<number, ReturnType<typeof fakeChild>>()
  let nextPid = 100
  const stop = (pid: number): void => {
    stopped.push(pid)
    children.get(pid)?.exit(null, "SIGTERM")
    children.delete(pid)
  }
  const container = ({ pid }: ContainerRef): ManagedContainer => ({ signal: () => {}, populated: () => children.has(pid) })
  return {
    launched,
    admitted,
    stopped,
    end: stop,
    backend: {
      launch() {
        const pid = ++nextPid
        const fake = fakeChild()
        children.set(pid, fake)
        launched.push(pid)
        return {
          pid,
          child: fake.child,
          admit: () => { admitted.push(pid) },
          stop: () => { stop(pid) },
          handOver: async () => "unacknowledged",
        }
      },
      async reach(command) {
        return {
          close: () => {},
          handBack: () => {},
          async adopt() {
            const fake = fakeChild()
            children.set(command.pid, fake)
            return {
              kind: "adopted",
              container: { pid: command.pid, child: fake.child, stop: () => { stop(command.pid) }, handOver: async () => "unacknowledged" },
            }
          },
        }
      },
      emptyUnserved: async () => true,
      container,
      ending: container,
      inspect: ({ pid }) => ({ kind: "container", identity: `identity-${pid}` }),
      forget: () => {},
    },
  }
}

interface BridgeProbe {
  readonly scope: LauncherScope
  /** The Worker half's lifetime signal, which the owner's end of the
   *  generation aborts. */
  readonly lifetime: AbortSignal
  readonly bridge: OwnedProcessBridge
  readonly commands: GuardianCommand[]
  readonly backend: BridgeBackendProbe
  readonly serverPort: MessagePort
  readonly workerPort: MessagePort
  /** Which commands the main-side guardian answers, so a test can hold a
   *  bridged call open for exactly as long as it needs to. */
  readonly control: { answers: "all" | "none" | "release-only" }
  /** The generations this control opened, the tokens each still leases, and
   *  the pids its close ended. */
  readonly generations: { readonly leased: Set<string>; readonly ended: number[]; closed: boolean }[]
}

/** A guardian control that keeps the one record a real guardian keeps: what a
 *  generation still leases, and what closing it ends. Closing a generation
 *  stops the containers of the tokens it still holds, which is the kill the
 *  real guardian performs. */
function bridgeProbe(options: { readonly closeDeadlineMs?: number; readonly requestDeadlineMs?: number } = {}): BridgeProbe {
  const channel = new MessageChannel()
  const commands: GuardianCommand[] = []
  const backend = bridgeBackend()
  const control: BridgeProbe["control"] = { answers: "all" }
  const generations: BridgeProbe["generations"] = []
  const guardian: GuardianControl = {
    pid: () => Promise.resolve(GUARDIAN_PID),
    openGeneration: () => {
      const leases = new Map<string, number>()
      const record: BridgeProbe["generations"][number] = { leased: new Set(), ended: [], closed: false }
      generations.push(record)
      return Promise.resolve({
        pid: () => Promise.resolve(GUARDIAN_PID),
        request: async (command: GuardianCommand): Promise<GuardianLeaseOutcome> => {
          commands.push(command)
          const held = control.answers === "none" || (control.answers === "release-only" && command.kind === "adopt")
          if (held) return await new Promise<GuardianLeaseOutcome>(() => {})
          if (command.kind === "adopt") {
            leases.set(command.token, command.pid)
            record.leased.add(command.token)
            return { kind: "adopted", token: command.token }
          }
          leases.delete(command.token)
          record.leased.delete(command.token)
          return { kind: "released", token: command.token }
        },
        close: (): Promise<OwnershipClosure> => {
          record.closed = true
          for (const pid of leases.values()) {
            record.ended.push(pid)
            backend.end(pid)
          }
          leases.clear()
          record.leased.clear()
          return Promise.resolve({ settled: true })
        },
      })
    },
  }
  const bridge = serveOwnedProcessBridge({
    port: channel.port1,
    closeDeadlineMs: options.closeDeadlineMs ?? 500,
    guardian,
  })
  const peer = connectOwnedProcessBridge({
    port: channel.port2,
    backend: backend.backend,
    requestDeadlineMs: options.requestDeadlineMs ?? 500,
  })
  return { scope: peer.launcher, lifetime: peer.lifetime, bridge, commands, backend, control, generations, serverPort: channel.port1, workerPort: channel.port2 }
}

describe("owned process bridge", () => {
  test("admits a Worker-side payload only after the main-side guardian adopted it", async () => {
    const probe = bridgeProbe()

    const owned = await probe.scope.spawnOwned(["/bin/sh", "-c", "true"])

    expect(probe.commands).toHaveLength(1)
    expect(probe.commands[0]).toMatchObject({ kind: "adopt", pid: owned.pid })
    expect(probe.backend.admitted).toEqual([owned.pid])
    await probe.bridge.close()
  })

  test("carries the guardian's identity across the bridge so a Worker container watches it", async () => {
    const probe = bridgeProbe()
    const launched: string[] = []
    probe.serverPort.addEventListener("message", (event: MessageEvent) => {
      const data = event.data
      if (typeof data === "object" && data !== null && "kind" in data && data.kind === "guardian-pid") launched.push("asked")
    })

    await probe.scope.spawnOwned(["/bin/sh", "-c", "true"])

    expect(launched).toEqual(["asked"])
    await probe.bridge.close()
  })

  test("adopts a handed-over command through the main-side guardian, which then ends it with the generation", async () => {
    const probe = bridgeProbe()

    const answer = await probe.scope.adoptOwned({ token: "owned:handed-over", pid: 7070, channel: "/scratch/h0123456789", recordPath: "/scratch/none", userDataRoot: "/scratch/.flywheel" })

    expect(answer).toMatchObject({ kind: "adopted", owned: { pid: 7070, token: "owned:handed-over" } })
    expect(probe.commands).toEqual([{ kind: "adopt", token: "owned:handed-over", pid: 7070, stopHold: null }])
    expect(await probe.bridge.close()).toEqual({ settled: true })
    expect(probe.backend.stopped).toEqual([7070])
  })

  test("surrenders ownership through the bridge when the container exits", async () => {
    const probe = bridgeProbe()

    const owned = await probe.scope.spawnOwned(["/bin/sh", "-c", "true"])
    await owned.terminate()

    expect(probe.commands.map((command) => command.kind)).toEqual(["adopt", "release"])
    expect(probe.generations[0]?.leased.size).toBe(0)
    await probe.bridge.close()
  })

  test("generation close aborts the Worker's lifetime, then settles the containers the Worker still owns before it resolves", async () => {
    const probe = bridgeProbe()
    const owned = await probe.scope.spawnOwned(["/bin/sh", "-c", "sleep 60"])
    const stoppedAtAbort: number[][] = []
    probe.lifetime.addEventListener("abort", () => { stoppedAtAbort.push([...probe.backend.stopped]) })

    expect(await probe.bridge.close()).toEqual({ settled: true })
    // The Worker's work hears that its generation ended before any command
    // it launched is ended.
    expect(stoppedAtAbort).toEqual([[]])
    expect(probe.lifetime.reason).toBeInstanceOf(DOMException)
    expect(probe.backend.stopped).toEqual([owned.pid])
    expect(probe.commands.map((command) => command.kind)).toEqual(["adopt", "release"])
    await expect(probe.scope.spawnOwned(["/bin/sh", "-c", "true"])).rejects.toThrow("launcher scope is closed")
  })

  test("generation close ends at its deadline when the peer never answers", async () => {
    const probe = bridgeProbe({ closeDeadlineMs: 30 })
    probe.workerPort.close()

    const started = Date.now()

    // Nothing was ever adopted through this bridge, so a peer that cannot
    // answer still leaves nothing owned.
    expect(await probe.bridge.close()).toEqual({ settled: true })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("the guardian ends what a dead peer's generation still leased, and the close proves it", async () => {
    const probe = bridgeProbe({ closeDeadlineMs: 30 })
    const owned = await probe.scope.spawnOwned(["/bin/sh", "-c", "sleep 60"])
    // The thread died with its port: it can neither settle its container nor
    // answer the close request, so the generation is the only thing that can
    // end what it left behind. In this one-process probe the Worker half also
    // sees its channel end and fails closed on its own container, which a real
    // dead thread could not; the lease it never released is what the guardian
    // must end, so the guardian's record is the assertion, not the backend's.
    probe.workerPort.close()

    expect(await probe.bridge.close()).toEqual({ settled: true })
    expect(probe.generations[0]?.closed).toBe(true)
    expect(probe.generations[0]?.ended).toEqual([owned.pid])
    expect(probe.backend.stopped).toContain(owned.pid)
  })

  test("a call that overruns its deadline releases its slot and leaves the bridge usable", async () => {
    const probe = bridgeProbe({ requestDeadlineMs: 20 })
    probe.control.answers = "none"

    await expect(probe.scope.spawnOwned(["/bin/sh", "-c", "true"])).rejects.toThrow(/deadline/i)
    // The launch that never got an answer never ran either: its container is
    // stopped rather than left behind.
    expect(probe.backend.stopped).toEqual(probe.backend.launched)

    probe.control.answers = "all"
    const owned = await probe.scope.spawnOwned(["/bin/sh", "-c", "true"])

    expect(probe.backend.admitted).toEqual([owned.pid])
    expect(await probe.bridge.close()).toEqual({ settled: true })
  })

  test("compensates an adoption it abandoned, so a late lease owns nothing", async () => {
    const probe = bridgeProbe({ requestDeadlineMs: 20 })
    probe.control.answers = "release-only"

    await expect(probe.scope.spawnOwned(["/bin/sh", "-c", "true"])).rejects.toThrow(/deadline/i)
    await Bun.sleep(20)

    const [adopted, compensating] = probe.commands
    expect(adopted).toMatchObject({ kind: "adopt" })
    expect(compensating).toEqual({ kind: "release", token: adopted?.token ?? "" })
    await probe.bridge.close()
  })

  test("closing the bridge fails every call still waiting on it", async () => {
    const probe = bridgeProbe({ closeDeadlineMs: 30, requestDeadlineMs: 10_000 })
    probe.control.answers = "none"
    const launching = probe.scope.spawnOwned(["/bin/sh", "-c", "true"])
    await Bun.sleep(5)

    const started = Date.now()
    await probe.bridge.close()

    // The channel is gone, so the wait ends with it instead of parking on a
    // reply that can never arrive.
    await expect(launching).rejects.toThrow(/closed/i)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("refuses a bridge frame the peer could not have produced", async () => {
    const probe = bridgeProbe()
    const wrongVersion = { v: 2, kind: "lease", id: 1, command: { kind: "adopt", token: "a", pid: 9, stopHold: null } }
    const wrongCommand = { v: 1, kind: "lease", id: 1, command: { kind: "adopt", token: "a", pid: 9, stopHold: null, generation: "gen:theirs" } }
    const wrongId = { v: 1, kind: "lease", id: 0, command: { kind: "adopt", token: "a", pid: 9, stopHold: null } }
    const { serverPort: port } = probe
    port.postMessage(wrongVersion)
    // A peer cannot name a generation: the command vocabulary has no such key,
    // so a frame carrying one is not this protocol's.
    port.postMessage(wrongCommand)
    port.postMessage(wrongId)
    await Bun.sleep(10)

    expect(probe.commands).toEqual([])
    await probe.bridge.close()
  })
})

describe("thread process probe", () => {
  test("reads /proc as the Worker does, where only a single-threaded zombie or a missing entry is absent", () => {
    const stat = (pid: number, state: string, threads: number): string => `${pid} (bash) ${state} 1 4242 4242 0 -1 0 0 0 0 0 0 0 0 0 20 0 ${threads} 0 777 0 0`
    const files = new Map<string, string | Error>([
      ["/proc/4242/stat", stat(4242, "Z", 1)],
      ["/proc/4243/stat", stat(4243, "Z", 3)],
      ["/proc/4244/stat", Object.assign(new Error("gone"), { code: "ENOENT" })],
      ["/proc/4245/stat", Object.assign(new Error("denied"), { code: "EACCES" })],
    ])
    const readFile = (path: string): string => {
      const file = files.get(path) ?? new Error(`unscripted read of ${path}`)
      if (typeof file !== "string") throw file
      return file
    }
    const { imports, expression } = threadProcessProbeSource("linux")
    // The Worker binds this name through its import; here the test binds it.
    expect(imports).toContain("threadProbeReadFile")
    // oxlint-disable-next-line no-new-func -- boundary: evaluates the exact source the Worker runs, with its one import bound to a fake
    const probe: ThreadProcessProbe = new Function("threadProbeReadFile", `return ${expression}`)(readFile)

    expect(probe.identify(4242)).toEqual({ kind: "absent" })
    expect(probe.identify(4243)).toEqual({ kind: "process", identity: "4243 4242 777" })
    expect(probe.identify(4244)).toEqual({ kind: "absent" })
    expect(probe.identify(4245)).toEqual({ kind: "unproven" })
  })
})
