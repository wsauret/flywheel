import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redacted } from "effect"
import { awaitServeHandshake, createAccountRuntimeAttach, readRuntimeIdentity, type RuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { ACCOUNT_DRAIN_HARD_EXIT_MS } from "../../../src/orchestration/app-service/runtime-shutdown.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountServeTokenPath } from "../../../src/infra/paths.js"
import { createAccountAttachReader } from "../../../src/protocol/account-attach.js"
import { encodeServeStartFailure, ServeStartupFailure } from "../../../src/protocol/serve-handshake.js"
import { startupPhase } from "../../../src/protocol/startup-steps.js"
import type { RuntimeStartupStatus } from "../../../src/protocol/app-service-types.js"

/** What a launched service is apart from its output: these cases read its
 *  stdout and never its error output. */
const LAUNCHED = {
  command: ["flywheel", "serve"],
  metadata: () => ({ startedAtMs: 0, status: "running" as const, stdoutBytes: 0, stderrBytes: 0 }),
}

describe("account runtime attach", () => {
  test("targets its own lane's account socket and authenticates the canonical project", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-"))
    try {
      const attach = createAccountRuntimeAttach({ projectRoot: root, executionCwd: root, accountHome: root, userDataRoot: join(root, ".flywheel"), allowPersistentProcesses: true })
      expect(attach.lane).toBe(serveLaneFor(process.execPath))
      const credential = (await Bun.file(accountServeTokenPath(join(root, ".flywheel"), attach.lane)).text()).trim()
      const accepted = createAccountAttachReader({ credential: Redacted.make(credential), canonicalizeProjectRoot: (projectRoot) => projectRoot }).push(attach.connectionPreface())
      expect(accepted).toMatchObject({ kind: "accepted", intent: "runtime" })
      expect(attach.socketPath).toContain("serve")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("reports the failure the service wrote even when its exit lands in the same instant", async () => {
    const spool = new TextEncoder().encode(`${JSON.stringify({ flywheel: "serve.startup.failed", error: "Failed to start server. Is port 41000 in use?" })}\n`)
    let reads = 0
    const started = {
      ...LAUNCHED,
      // The first read sees an empty spool; the write and the exit land together before the second.
      read: (_stream: "stdout" | "stderr", offset: number) => {
        reads += 1
        return reads === 1 || offset >= spool.length ? { data: new Uint8Array(), nextOffset: offset, eof: false } : { data: spool.subarray(offset), nextOffset: spool.length, eof: false }
      },
      exited: Promise.resolve(1),
      stop: async () => "terminated" as const,
    }
    const failure = await awaitServeHandshake(started, () => {}, new AbortController().signal, "current").then(() => undefined, (error: unknown) => error)
    // The shape every earlier build writes names no refusal, so a client shows the lane's reset.
    expect(failure).toMatchObject({ message: "Failed to start server. Is port 41000 in use?", refusal: undefined })
  })

  // The refusal is what lets every client name the remedy that works.
  test("carries the refusal the service named in its failure record", async () => {
    const refusal = { kind: "address-access", path: "/Users/me/.flywheel/serve/serve.sock", code: "EACCES" } as const
    const spool = new TextEncoder().encode(encodeServeStartFailure("the account service address answered EACCES to a connection", refusal))
    const started = {
      ...LAUNCHED,
      read: (_stream: "stdout" | "stderr", offset: number) => offset >= spool.length ? { data: new Uint8Array(), nextOffset: offset, eof: false } : { data: spool.subarray(offset), nextOffset: spool.length, eof: false },
      exited: Promise.resolve(75),
      stop: async () => "terminated" as const,
    }
    const failure = await awaitServeHandshake(started, () => {}, new AbortController().signal, "current").then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ServeStartupFailure)
    expect(failure).toMatchObject({ message: "the account service address answered EACCES to a connection", refusal })
  })

  test("stops the service it launched when the client begins to exit before that service listens", async () => {
    // The service this client depended on ended before the signal reached the
    // client, so the client launched a replacement. The signal arrives while
    // the replacement is still starting.
    const shutdown = new AbortController()
    const stops: string[] = []
    const started = {
      ...LAUNCHED,
      read: (_stream: "stdout" | "stderr", offset: number) => ({ data: new Uint8Array(), nextOffset: offset, eof: false }),
      exited: new Promise<number>(() => {}),
      stop: async () => {
        stops.push("stop")
        return "terminated" as const
      },
    }
    const handshake = awaitServeHandshake(started, () => {}, shutdown.signal, "current")
    shutdown.abort(new Error("this client is shutting down and starts no account service"))

    await expect(handshake).rejects.toThrow(/shutting down/)
    expect(stops).toEqual(["stop"])
  })

  test("leaves a service that already reported listening to run", async () => {
    const shutdown = new AbortController()
    const spool = new TextEncoder().encode(`${JSON.stringify({ flywheel: "serve.listening", version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, pid: 1, lane: "installed" })}\n`)
    let stopped = false
    const started = {
      ...LAUNCHED,
      read: (_stream: "stdout" | "stderr", offset: number) => ({ data: spool.subarray(offset), nextOffset: spool.length, eof: false }),
      exited: new Promise<number>(() => {}),
      stop: async () => {
        stopped = true
        return "terminated" as const
      },
    }

    await awaitServeHandshake(started, () => {}, shutdown.signal, "current")
    shutdown.abort(new Error("this client is shutting down and starts no account service"))
    expect(stopped).toBe(false)
  })

  test("requests cutover instead of accepting the same protocol from another build", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-cutover-"))
    const cutovers: string[] = []
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "old" }),
        installedBuildId: () => "current",
        requestReplacement: async () => {
          cutovers.push("requested")
          return "busy"
        },
      })

      await attach.ensure(() => {})

      expect(cutovers).toEqual(["requested"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("attaches without cutover when the service build matches current", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-matching-"))
    let cutovers = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "current" }),
        installedBuildId: () => "current",
        requestReplacement: async () => {
          cutovers += 1
          return "busy"
        },
      })

      await attach.ensure(() => {})

      expect(cutovers).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("asks the service manager for the registered service before launching one", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-service-"))
    const events: string[] = []
    let probes = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => {
          probes += 1
          events.push(`probe:${probes}`)
          // The registered service answers on the second poll after its start.
          return events.includes("service-start") && probes >= 3
        },
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "current" }),
        installedBuildId: () => "current",
        startRegisteredService: async () => {
          events.push("service-start")
          return true
        },
        sleep: async () => {},
        launchRuntime: async () => { events.push("launch") },
      })

      await attach.ensure(() => {})

      expect(events).toEqual(["probe:1", "service-start", "probe:2", "probe:3"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("asks the service manager first even when the current build cannot be read, and waits for the job's identity record", async () => {
    // A `current` link that does not read names no build, and the registered
    // job is still the one starter. The job listens before it writes its
    // identity record, so the first read after it listens finds none.
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-unread-current-"))
    const events: string[] = []
    let identityReads = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => events.includes("service-start"),
        readRuntimeIdentity: () => {
          identityReads += 1
          return identityReads === 1 ? undefined : { pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "registered" }
        },
        installedBuildId: () => undefined,
        startRegisteredService: async () => {
          events.push("service-start")
          return true
        },
        sleep: async () => {},
        launchRuntime: async () => { events.push("launch") },
      })

      await attach.ensure(() => {})

      expect(events).toEqual(["service-start"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("launches a service itself when no registration answers", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-unregistered-"))
    const events: string[] = []
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => false,
        readRuntimeIdentity: () => undefined,
        installedBuildId: () => "current",
        startRegisteredService: async () => {
          events.push("service-start")
          return false
        },
        sleep: async () => {},
        launchRuntime: async () => { events.push("launch") },
      })

      await attach.ensure(() => {})

      expect(events).toEqual(["service-start", "launch"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("never launches a copy of its own while the registration is loaded and enabled, and reports a start that never listened", async () => {
    // The registered job is the one starter. A client-owned twin would hold
    // the address while the registered job parks or respawns against it.
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-silent-service-"))
    const events: string[] = []
    let now = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => false,
        readRuntimeIdentity: () => undefined,
        installedBuildId: () => "current",
        startRegisteredService: async () => {
          events.push(`service-start@${now}`)
          return true
        },
        sleep: async (milliseconds) => { now += milliseconds },
        now: () => now,
        launchRuntime: async () => { events.push("launch") },
      })

      // The wait covers the previous instance's whole drain and the
      // manager's restart after it.
      await expect(attach.ensure(() => {})).rejects.toThrow("the registered account service did not start listening within 75 seconds")

      expect(events).not.toContain("launch")
      expect(now).toBeGreaterThanOrEqual(ACCOUNT_DRAIN_HARD_EXIT_MS)
      // While nothing listens, the manager is asked again now and then, so a
      // job that parked or waits out a restart delay starts promptly.
      expect(events[0]).toBe("service-start@0")
      expect(events.length).toBeGreaterThan(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("reports a manager that refuses a loaded registration instead of launching a copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-refused-service-"))
    const events: string[] = []
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => false,
        readRuntimeIdentity: () => undefined,
        installedBuildId: () => "current",
        startRegisteredService: async () => { throw new Error("launchctl kickstart failed (exit 113)") },
        sleep: async () => {},
        launchRuntime: async () => { events.push("launch") },
      })

      await expect(attach.ensure(() => {})).rejects.toThrow("launchctl kickstart failed (exit 113)")
      expect(events).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("keeps waiting for the registered job when a repeated start request fails", async () => {
    // The first request settled who starts the service; a later refusal is
    // only logged, and the job that listens is the one this client joins.
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-repeat-refused-"))
    const events: string[] = []
    let now = 0
    let requests = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => now >= 12_000,
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "current" }),
        installedBuildId: () => "current",
        startRegisteredService: async () => {
          requests += 1
          if (requests > 1) throw new Error("launchctl kickstart failed (exit 5)")
          return true
        },
        sleep: async (milliseconds) => { now += milliseconds },
        now: () => now,
        launchRuntime: async () => { events.push("launch") },
      })

      await attach.ensure(() => {})

      expect(requests).toBeGreaterThan(1)
      expect(events).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("launches the service itself once no registration is loaded and enabled any more", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-unloaded-"))
    const events: string[] = []
    let now = 0
    let requests = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => false,
        readRuntimeIdentity: () => undefined,
        installedBuildId: () => "current",
        startRegisteredService: async () => {
          requests += 1
          return requests === 1
        },
        sleep: async (milliseconds) => { now += milliseconds },
        now: () => now,
        launchRuntime: async () => { events.push(`launch@${now}`) },
      })

      await attach.ensure(() => {})

      expect(requests).toBe(2)
      expect(events).toEqual([expect.stringMatching(/^launch@\d+$/)])
      expect(now).toBeLessThan(10_000)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("waits for a retiring listener to disappear before launching current", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-retiring-"))
    const events: string[] = []
    let probes = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => {
          probes += 1
          events.push(`probe:${probes}`)
          return probes < 3
        },
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "old" }),
        installedBuildId: () => "current",
        requestReplacement: async () => {
          events.push("retiring")
          return "retiring"
        },
        sleep: async () => {},
        launchRuntime: async () => { events.push("launch") },
      })

      await attach.ensure(() => {})

      expect(events).toEqual(["probe:1", "retiring", "probe:2", "probe:3", "launch"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("an ensure that is waiting when the client shuts down never starts or launches a service", async () => {
    // `flywheel kill` ends a client and its service together. A client that
    // was already waiting for that service to leave finds the address empty
    // after it began its own exit, and a launch then leaves a fresh service of
    // this client's build running with nobody attached to it.
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-shutdown-"))
    const events: string[] = []
    let serving = true
    const waiting = Promise.withResolvers<void>()
    const leave = Promise.withResolvers<void>()
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => serving,
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "old" }),
        installedBuildId: () => "current",
        requestReplacement: async () => "retiring",
        startRegisteredService: async () => {
          events.push("service-start")
          return true
        },
        sleep: async () => {
          waiting.resolve()
          await leave.promise
        },
        launchRuntime: async () => { events.push("launch") },
      })

      const ensuring = attach.ensure(() => {})
      await waiting.promise
      attach.close()
      serving = false
      leave.resolve()

      await expect(ensuring).rejects.toThrow(/shutting down/)
      await expect(attach.ensure(() => {})).rejects.toThrow(/shutting down/)
      expect(events).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("accepts a current-build successor that another client starts during retirement", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-successor-"))
    let identityReads = 0
    let now = 0
    let launches = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => {
          identityReads += 1
          return {
            pid: identityReads === 1 ? 1 : 2,
            holder: { kind: "without-identity", pid: identityReads === 1 ? 1 : 2 },
            version: identityReads === 1 ? "1.0.0" : "1.1.0",
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            buildId: identityReads === 1 ? "old" : "current",
          }
        },
        installedBuildId: () => "current",
        requestReplacement: async () => "retiring",
        sleep: async () => {},
        now: () => { now += 50_000; return now },
        launchRuntime: async () => { launches += 1 },
      })

      const reached = await attach.ensure(() => {})

      // The record read once the attach settled names the successor, never
      // the service that retired.
      expect(identityReads).toBe(3)
      expect(reached?.buildId).toBe("current")
      expect(launches).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("waits for the published v0.0.9 service poll when cutover is unsupported", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-legacy-cutover-"))
    let probes = 0
    let launches = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => {
          probes += 1
          return probes < 3
        },
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "0.0.9", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "old" }),
        installedBuildId: () => "current",
        requestReplacement: async () => { throw new Error("connection closed") },
        sleep: async () => {},
        launchRuntime: async () => { launches += 1 },
      })

      await attach.ensure(() => {})

      expect(probes).toBe(3)
      expect(launches).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("keeps a published v0.0.9 service when work outlives its next build poll", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-legacy-busy-"))
    let now = 0
    let launches = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "0.0.9", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "old" }),
        installedBuildId: () => "current",
        requestReplacement: async () => { throw new Error("connection closed") },
        sleep: async () => {},
        now: () => { now += 70_000; return now },
        launchRuntime: async () => { launches += 1 },
      })

      await attach.ensure(() => {})

      expect(launches).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("asks another build to retire whatever protocol it speaks and waits out its work when it cannot serve this client", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-older-protocol-"))
    const events: string[] = []
    let probes = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => {
          probes += 1
          events.push(`probe:${probes}`)
          return probes < 3
        },
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "0.0.10", protocolVersion: RUNTIME_PROTOCOL_VERSION - 3, buildId: "old" }),
        installedBuildId: () => "current",
        requestReplacement: async () => {
          events.push("cutover")
          return "busy"
        },
        sleep: async () => {},
        launchRuntime: async () => { events.push("launch") },
      })

      const statuses: RuntimeStartupStatus[] = []
      await attach.ensure((status) => {
        statuses.push(status)
        events.push(status.kind === "phase" ? `phase:${status.label}` : `failed:${status.error}`)
      })

      expect(events).toEqual(["probe:1", "cutover", "phase:Starting account service", "probe:2", "probe:3", "launch"])
      // The account service is the first step on the one startup bar.
      expect(statuses).toEqual([{ kind: "phase", ...startupPhase({ step: "account-service" }) }])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("joins the successor another client starts while an older-protocol service finishes its work", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-older-protocol-successor-"))
    let identityReads = 0
    let launches = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => {
          identityReads += 1
          return identityReads < 3
            ? { pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "0.0.10", protocolVersion: RUNTIME_PROTOCOL_VERSION - 3, buildId: "old" }
            : { pid: 2, holder: { kind: "without-identity", pid: 2 }, version: "0.0.10", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "current" }
        },
        installedBuildId: () => "current",
        requestReplacement: async () => "busy",
        sleep: async () => {},
        launchRuntime: async () => { launches += 1 },
      })

      const reached = await attach.ensure(() => {})

      expect(identityReads).toBe(4)
      expect(reached?.pid).toBe(2)
      expect(launches).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("faults on a protocol the client cannot speak only when the service is not superseded", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-protocol-fault-"))
    let cutovers = 0
    try {
      const attach = createAccountRuntimeAttach({
        projectRoot: root,
        executionCwd: root,
        accountHome: root,
        userDataRoot: join(root, ".flywheel"),
        allowPersistentProcesses: true,
      }, {
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "0.0.10", protocolVersion: RUNTIME_PROTOCOL_VERSION - 3, buildId: "current" }),
        installedBuildId: () => "current",
        requestReplacement: async () => {
          cutovers += 1
          return "busy"
        },
      })

      await expect(attach.ensure(() => {})).rejects.toThrow(`the account service speaks protocol ${RUNTIME_PROTOCOL_VERSION - 3} and this client requires ${RUNTIME_PROTOCOL_VERSION}`)
      expect(cutovers).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe("a lane's identity record", () => {
  const record = { pid: 41, v: 1, start: "7", version: "source", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: `source:protocol-${RUNTIME_PROTOCOL_VERSION}` }
  const read = (content: string) => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-identity-record-"))
    try {
      writeFileSync(join(root, "serve.json"), content)
      return readRuntimeIdentity(join(root, "serve.json"))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  const today: RuntimeIdentity = { pid: 41, version: "source", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: `source:protocol-${RUNTIME_PROTOCOL_VERSION}`, holder: { kind: "identified", pid: 41, identity: { v: 1, start: "7" } } }

  test("names the source snapshot a dev service runs from", () => {
    expect(read(JSON.stringify({ ...record, sourceSnapshot: { checkout: "/scratch/checkout", digest: "0123456789abcdef" } })))
      .toEqual({ ...today, sourceSnapshot: { checkout: "/scratch/checkout", digest: "0123456789abcdef" } })
  })

  test("reads a record without a snapshot, which a service before snapshots and every installed service writes, as it always has", () => {
    expect(read(JSON.stringify(record))).toEqual(today)
    expect(read(JSON.stringify({ ...record, sourceSnapshot: { checkout: "/scratch/checkout" } }))).toEqual(today)
  })
})
