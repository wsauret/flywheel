import { describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { awaitServeHandshake, createAccountRuntimeAttach, type RuntimeAttachSeams } from "../../../src/cli/runtime-attach.js"
import { accountServeErrorLogPath } from "../../../src/infra/paths.js"
import { recordServiceStartFailure } from "../../../src/infra/update/service-start-record.js"
import { ACCOUNT_DRAIN_HARD_EXIT_MS } from "../../../src/orchestration/app-service/runtime-shutdown.js"
import { AccountServiceInstallationError } from "../../../src/orchestration/app-service/service-manager-command.js"
import { ServeStartupFailure } from "../../../src/protocol/serve-handshake.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const directory = temporaryDirectories()
/** The moment the client asks the service manager for the service. */
const REQUESTED_AT = 1_800_000_000_000
const REFUSAL = { kind: "address-access", path: "/Users/me/.flywheel/serve/serve.sock", code: "EACCES" } as const

/** A client of the installed lane whose registered service never listens,
 *  on a clock that only its own waits move. `onRequest` runs at each start
 *  request, before the manager answers. */
function registeredServiceThatNeverListens(onRequest: (userDataRoot: string) => void) {
  const root = directory("flywheel-attach-start-failure-")
  const userDataRoot = join(root, ".flywheel")
  let now = REQUESTED_AT
  let requests = 0
  const seams: RuntimeAttachSeams = {
    isRuntimeListening: async () => false,
    readRuntimeIdentity: () => undefined,
    installedBuildId: () => "current",
    startInstalledService: async () => {
      requests += 1
      onRequest(userDataRoot)
      return true
    },
    sleep: async (milliseconds) => { now += milliseconds },
    now: () => now,
    launchRuntime: async () => { throw new Error("a client never launches a copy of a registered service") },
  }
  const attach = createAccountRuntimeAttach({ projectRoot: root, executionCwd: root, accountHome: root, userDataRoot, allowPersistentProcesses: true }, seams)
  return {
    userDataRoot,
    failure: () => attach.ensure(() => {}).then(() => undefined, (error: unknown) => error),
    requests: () => requests,
    waitedMs: () => now - REQUESTED_AT,
  }
}

/** A failure of the lane's streak. `parkedAt` names when the lane last
 *  parked, when it has. */
function recordFailure(userDataRoot: string, { parkedAt, ...failure }: { readonly lastAt: number; readonly cause: string; readonly refusal?: unknown; readonly parkedAt?: number }): void {
  recordServiceStartFailure(userDataRoot, () => ({ since: failure.lastAt - 130_000, starts: 4, causeKind: "refused", ...failure, ...(parkedAt === undefined ? {} : { parked: { since: parkedAt, lastAt: parkedAt, starts: 1 } }) }))
}

describe("a start the client asked the service manager for", () => {
  test("ends the wait at once with the recorded cause and refusal when the lane parked after the request", async () => {
    let first = true
    const client = registeredServiceThatNeverListens((userDataRoot) => {
      if (first) recordFailure(userDataRoot, { lastAt: REQUESTED_AT, cause: "X", refusal: REFUSAL, parkedAt: REQUESTED_AT })
      first = false
    })

    const failure = await client.failure()

    expect(failure).toBeInstanceOf(ServeStartupFailure)
    expect(failure).toMatchObject({ message: "X", refusal: REFUSAL })
    // A parked service runs only the start a request asks for, so the client
    // asks no second time.
    expect(client.requests()).toBe(1)
    expect(client.waitedMs()).toBeLessThan(ACCOUNT_DRAIN_HARD_EXIT_MS)
  })

  test("reports at its deadline the cause of a failure recorded after the request", async () => {
    const client = registeredServiceThatNeverListens((userDataRoot) => {
      recordFailure(userDataRoot, { lastAt: REQUESTED_AT, cause: "the account store could not be opened" })
    })

    const failure = await client.failure()

    expect(failure).toBeInstanceOf(ServeStartupFailure)
    expect(failure).toMatchObject({ message: "the account store could not be opened", refusal: undefined })
    expect(client.waitedMs()).toBeGreaterThanOrEqual(ACCOUNT_DRAIN_HARD_EXIT_MS)
  })

  test("keeps waiting when the failure after the request did not park, though the lane parked before the request", async () => {
    const settling = { kind: "claim-settling", path: "/Users/me/.flywheel/serve/serve.start.lock.reclaim" } as const
    const client = registeredServiceThatNeverListens((userDataRoot) => {
      recordFailure(userDataRoot, { lastAt: REQUESTED_AT, cause: "the start lock's claim is empty", refusal: settling, parkedAt: REQUESTED_AT - 30_000 })
    })

    const failure = await client.failure()

    expect(failure).toMatchObject({ message: "the start lock's claim is empty", refusal: settling })
    expect(client.waitedMs()).toBeGreaterThanOrEqual(ACCOUNT_DRAIN_HARD_EXIT_MS)
  })

  test("ignores a failure recorded before the request, even a parked one, and names the build the manager runs", async () => {
    const client = registeredServiceThatNeverListens(() => {})
    recordFailure(client.userDataRoot, { lastAt: REQUESTED_AT - 30_000, cause: "an earlier failure", refusal: REFUSAL, parkedAt: REQUESTED_AT - 30_000 })

    const failure = await client.failure()

    expect(failure).not.toBeInstanceOf(ServeStartupFailure)
    expect(failure).toMatchObject({ message: "the registered account service did not start listening within 75 seconds; the service manager runs build current" })
    expect(client.waitedMs()).toBeGreaterThanOrEqual(ACCOUNT_DRAIN_HARD_EXIT_MS)
  })

  test("adds what the service's error log received after the request when nothing is recorded", async () => {
    const client = registeredServiceThatNeverListens((userDataRoot) => {
      appendFileSync(accountServeErrorLogPath(userDataRoot), "panic: boom\n")
    })
    const errorLog = accountServeErrorLogPath(client.userDataRoot)
    mkdirSync(dirname(errorLog), { recursive: true })
    writeFileSync(errorLog, "panic: an earlier start\n")

    const failure = await client.failure()

    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : ""
    expect(message).toStartWith("the registered account service did not start listening within 75 seconds; the service manager runs build current")
    expect(message).toContain("panic: boom")
    expect(message).not.toContain("an earlier start")
  })

  test("leaves out the service's error log when a start trimmed it after the request, because what it kept can all be older", async () => {
    const earlier = "panic: an earlier start\n"
    const client = registeredServiceThatNeverListens((userDataRoot) => {
      // The start keeps only the tail of a log that grew too large.
      writeFileSync(accountServeErrorLogPath(userDataRoot), earlier)
    })
    const errorLog = accountServeErrorLogPath(client.userDataRoot)
    mkdirSync(dirname(errorLog), { recursive: true })
    writeFileSync(errorLog, earlier.repeat(4))

    const failure = await client.failure()

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: "the registered account service did not start listening within 75 seconds; the service manager runs build current" })
  })
})

describe("a start the service manager did not answer", () => {
  test("is a requested start: the client waits for the registered job to listen and launches no copy", async () => {
    // Right after an install, launchd held `kickstart` past its bound and
    // started the job seconds later.
    const root = directory("flywheel-attach-unanswered-start-")
    let now = 0
    const requests: number[] = []
    const attach = createAccountRuntimeAttach({ projectRoot: root, executionCwd: root, accountHome: root, userDataRoot: join(root, ".flywheel"), allowPersistentProcesses: true }, {
      isRuntimeListening: async () => requests.length > 0 && now >= 10_000,
      readRuntimeIdentity: () => ({ pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "1.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId: "current" }),
      installedBuildId: () => "current",
      startInstalledService: async () => {
        requests.push(now)
        throw new AccountServiceInstallationError("launchctl kickstart did not answer", { unanswered: true })
      },
      sleep: async (milliseconds) => { now += milliseconds },
      now: () => now,
      launchRuntime: async () => { throw new Error("a client never launches a copy of a registered service") },
    })

    await attach.ensure(() => {})

    expect(requests[0]).toBe(0)
    expect(now).toBeGreaterThanOrEqual(10_000)
  })

  test("is different from a refusal, which still fails the attach", async () => {
    const client = registeredServiceThatNeverListens(() => { throw new AccountServiceInstallationError("launchctl kickstart failed (exit 5)") })

    const failure = await client.failure()

    expect(failure).toMatchObject({ message: "launchctl kickstart failed (exit 5)" })
    expect(client.requests()).toBe(1)
  })
})

describe("a service this client launched", () => {
  test("that exits with no failure record is reported with its executable, its build, and its last whole lines of error output", async () => {
    // The window of the last output starts inside the long first line, which
    // is left out rather than shown cut.
    const stderr = new TextEncoder().encode(`${"x".repeat(5_000)}\nflywheel: failed to start: boom\n`)
    const started = {
      command: ["/Users/me/.local/bin/flywheel", "serve"],
      metadata: () => ({ startedAtMs: 0, status: "exited" as const, stdoutBytes: 0, stderrBytes: stderr.length }),
      read: (stream: "stdout" | "stderr", offset: number, maxBytes: number) => {
        const data = stream === "stderr" ? stderr.subarray(offset, offset + maxBytes) : new Uint8Array()
        return { data, nextOffset: offset + data.length, eof: true }
      },
      exited: Promise.resolve(1),
      stop: async () => "terminated" as const,
    }

    const failure = await awaitServeHandshake(started, () => {}, new AbortController().signal, "0.3.1-abc123").then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : ""
    expect(message).toContain("exited with code 1")
    expect(message).toContain("/Users/me/.local/bin/flywheel")
    expect(message).toContain("0.3.1-abc123")
    expect(message).toContain("flywheel: failed to start: boom")
    expect(message).not.toContain("xx")
    // The notice shows the first line of a cause, so all of it is one line.
    expect(message).not.toContain("\n")
  })
})
