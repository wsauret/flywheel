import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAccountRuntimeAttach, displayedRuntimeIdentity, requestAccountReplacement, type RuntimeAttachSeams, type RuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import type { TerminalSuccessor } from "../../../src/cli/terminal-handoff.js"
import { AGENT_SESSION_ENV, serveLaneFor, sourceCheckout, type SourceSnapshotLocation } from "../../../src/infra/cli-subprocess.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

describe("a client's cutover request", () => {
  test("a cutover request that the service does not answer within its deadline reads as busy", async () => {
    const root = mkdtempSync(join(tmpdir(), "fw-cutover-"))
    const socketPath = join(root, "serve.sock")
    let closed = false
    // A service that accepts the request and never answers it.
    const server = Bun.listen({ unix: socketPath, socket: { data() {}, close() { closed = true } } })
    try {
      expect(await requestAccountReplacement(socketPath, "credential", "cutover", 20)).toBe("busy")
      const isClosed = (): boolean => closed
      for (let waited = 0; !isClosed() && waited < 1_000; waited += 5) await Bun.sleep(5)
      expect(isClosed()).toBe(true)
    } finally {
      server.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** The build every service and client below runs. A source run's build
 *  names only its protocol, so a source edit leaves it unchanged. */
const BUILD = `source:protocol-${RUNTIME_PROTOCOL_VERSION}`

/** A snapshot of the checkout this client runs from. */
const OWN_SNAPSHOT: SourceSnapshotLocation = { checkout: sourceCheckout(), digest: "0123456789abcdef" }

/** The identity record of a dev service of this client's build, published
 *  by `pid`. */
function devService(pid: number, sourceSnapshot?: SourceSnapshotLocation): RuntimeIdentity {
  return { pid, holder: { kind: "without-identity", pid }, version: "0.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: BUILD, ...(sourceSnapshot === undefined ? {} : { sourceSnapshot }) }
}

/** A dev client in an account home of its own, with `seams` in place of the
 *  service it finds and `follow` in place of the terminal's re-execution. */
function devClient(seams: RuntimeAttachSeams, follow?: (successor: TerminalSuccessor) => Promise<never>) {
  const root = temporaryDirectory("flywheel-attach-source-")
  return createAccountRuntimeAttach({ projectRoot: root, executionCwd: root, accountHome: root, userDataRoot: join(root, ".flywheel"), allowPersistentProcesses: true, ...(follow === undefined ? {} : { follow }) }, { installedBuildId: () => BUILD, sleep: async () => {}, ...seams })
}

describe("a dev client's source cutover", () => {
  test("asks a service that runs from a snapshot of the client's own checkout once, at the client's first attach, and never at a reconnect", async () => {
    expect(serveLaneFor(process.execPath)).toBe("dev")
    let cutovers = 0
    const attach = devClient({
      isRuntimeListening: async () => true,
      readRuntimeIdentity: () => devService(1, OWN_SNAPSHOT),
      requestReplacement: async () => {
        cutovers += 1
        return "busy"
      },
    })

    await attach.ensure(() => {})
    await attach.ensure(() => {})

    expect(cutovers).toBe(1)
  })

  test("never asks when an agent's command started the client, whatever its build or source", async () => {
    let cutovers = 0
    process.env[AGENT_SESSION_ENV] = "agent-session"
    try {
      await devClient({
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => devService(1, OWN_SNAPSHOT),
        installedBuildId: () => "source:protocol-999",
        requestReplacement: async () => {
          cutovers += 1
          return "retiring"
        },
      }).ensure(() => {})
    } finally {
      Reflect.deleteProperty(process.env, AGENT_SESSION_ENV)
    }

    expect(cutovers).toBe(0)
  })

  test("never asks a service of another checkout, or one whose record names no snapshot, which a service before snapshots writes", async () => {
    let cutovers = 0
    const requestReplacement = async (): Promise<"busy"> => {
      cutovers += 1
      return "busy"
    }
    for (const identity of [devService(1, { checkout: join(sourceCheckout(), "..", "another-checkout"), digest: "0123456789abcdef" }), devService(1)]) {
      await devClient({ isRuntimeListening: async () => true, readRuntimeIdentity: () => identity, requestReplacement }).ensure(() => {})
    }

    expect(cutovers).toBe(0)
  })

  test("launches a service of the current source only once the service of the same build that answered retiring no longer listens", async () => {
    const events: string[] = []
    let probes = 0
    const attach = devClient({
      isRuntimeListening: async () => {
        probes += 1
        events.push(`probe:${probes}`)
        return probes < 3
      },
      readRuntimeIdentity: () => devService(1, OWN_SNAPSHOT),
      requestReplacement: async () => {
        events.push("retiring")
        return "retiring"
      },
      launchRuntime: async () => { events.push("launch") },
    })

    await attach.ensure(() => {})

    expect(events).toEqual(["probe:1", "retiring", "probe:2", "probe:3", "launch"])
  })

  test("joins the service whose record names another pid once the one that answered retiring has left, launches none, and resolves with the successor's identity", async () => {
    let reads = 0
    let launches = 0
    let cutovers = 0
    const attach = devClient({
      isRuntimeListening: async () => true,
      // The successor that another client started runs from a newer snapshot.
      readRuntimeIdentity: () => {
        reads += 1
        return reads <= 2 ? devService(1, OWN_SNAPSHOT) : { ...devService(2, { ...OWN_SNAPSHOT, digest: "fedcba9876543210" }), displayBuildId: "fedcba9876543210" }
      },
      requestReplacement: async () => {
        cutovers += 1
        return "retiring"
      },
      launchRuntime: async () => { launches += 1 },
    })

    const reached = await attach.ensure(() => {})

    expect(cutovers).toBe(1)
    expect(reads).toBe(4)
    expect(launches).toBe(0)
    expect(reached?.pid).toBe(2)
    if (reached === undefined) throw new Error("the attach reached no service")
    expect(displayedRuntimeIdentity(reached)).toEqual({ version: "0.0.0", buildId: "fedcba9876543210" })
  })
})

describe("a person's restart", () => {
  /** A terminal's follow that records where it was asked to go and then
   *  fails to start it, so the restart settles. */
  const recordingFollow = (followed: TerminalSuccessor[]) => async (successor: TerminalSuccessor): Promise<never> => {
    followed.push(successor)
    throw new Error("followed")
  }

  test("asks the service of the client's own build that serves, waits it out while it is busy, launches its successor, and follows into the checkout's entry", async () => {
    const events: string[] = []
    const followed: TerminalSuccessor[] = []
    let probes = 0
    let launched = false
    const attach = devClient({
      isRuntimeListening: async () => {
        if (launched) return true
        probes += 1
        events.push(`probe:${probes}`)
        return probes < 3
      },
      readRuntimeIdentity: () => devService(launched ? 2 : 1),
      requestReplacement: async (_socketPath, _credential, intent) => {
        events.push(intent)
        return "busy"
      },
      launchRuntime: async () => {
        launched = true
        events.push("launch")
      },
    }, recordingFollow(followed))

    await expect(attach.restart()).rejects.toThrow("followed")

    expect(events).toEqual(["probe:1", "restart", "probe:2", "probe:3", "launch"])
    expect(followed).toHaveLength(1)
    expect(followed[0]?.command.at(-1)).toBe(join(sourceCheckout(), "scripts", "dev.ts"))
    expect(followed[0]?.env).toEqual({})
  })

  test("that the service refuses rejects with the service's reason, starts nothing, and never follows", async () => {
    const followed: TerminalSuccessor[] = []
    let launches = 0
    const attach = devClient({
      isRuntimeListening: async () => true,
      readRuntimeIdentity: () => devService(1),
      requestReplacement: async () => { throw new Error("The account service closed before it answered the restart request") },
      launchRuntime: async () => { launches += 1 },
    }, recordingFollow(followed))

    await expect(attach.restart()).rejects.toThrow("closed before it answered the restart request")
    expect(launches).toBe(0)
    expect(followed).toEqual([])
  })

  test("whose service answers retiring and never leaves fails at the shutdown bound, starts nothing, and never follows", async () => {
    const followed: TerminalSuccessor[] = []
    let clock = 0
    let launches = 0
    const attach = devClient({
      isRuntimeListening: async () => true,
      readRuntimeIdentity: () => devService(1),
      requestReplacement: async () => "retiring",
      launchRuntime: async () => { launches += 1 },
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
    }, recordingFollow(followed))

    await expect(attach.restart()).rejects.toThrow("the account service did not stop within its shutdown bound")
    expect(launches).toBe(0)
    expect(followed).toEqual([])
  })

  test("requested again while one is in flight joins it: one request, one launch, one follow", async () => {
    const followed: TerminalSuccessor[] = []
    let requests = 0
    let launches = 0
    const attach = devClient({
      isRuntimeListening: async () => launches > 0 || requests === 0,
      readRuntimeIdentity: () => devService(launches > 0 ? 2 : 1),
      requestReplacement: async () => {
        requests += 1
        return "retiring"
      },
      launchRuntime: async () => { launches += 1 },
    }, recordingFollow(followed))

    const first = attach.restart()
    const second = attach.restart()

    await expect(first).rejects.toThrow("followed")
    await expect(second).rejects.toThrow("followed")
    expect(requests).toBe(1)
    expect(launches).toBe(1)
    expect(followed).toHaveLength(1)
  })
})
