import { describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"

import { Redacted } from "effect"

import { readRuntimeIdentity, requestAccountReplacement, type RuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { runServe, type ServeSeams } from "../../../src/cli/serve.js"
import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { Log } from "../../../src/infra/log.js"
import { accountServeDir, accountServeRecordPath, accountServeSocketPath } from "../../../src/infra/paths.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import * as sourceSnapshot from "../../../src/infra/source-snapshot.js"
import { readOrCreateAccountAttachToken } from "../../../src/orchestration/app-service/account-attach-token.js"
import { checkoutProtocolVersion, sourceBuildId } from "../../../src/orchestration/app-service/runtime-executable.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { ServeLifetime } from "../../../src/orchestration/app-service/serve-lifetime.js"
import { IDLE_SERVE, shortAccountHomes, unusedLauncher } from "./_serve-fixtures.js"

// A serve run in this test process runs through Bun, so it serves the dev lane.
const lane = serveLaneFor(process.execPath)
const shortAccountHome = shortAccountHomes()

const SNAPSHOT = { checkout: "/scratch/checkout", digest: "0123456789abcdef" }

/** An account home for one dev serve, and where the serve publishes its
 *  identity record. */
function devHome(): ReturnType<typeof shortAccountHome> & { readonly identityPath: string } {
  const home = shortAccountHome("fw-snapshot-")
  fs.mkdirSync(accountServeDir(home.userDataRoot, lane), { recursive: true })
  return { ...home, identityPath: accountServeRecordPath(home.userDataRoot, lane) }
}

/** A source whose checkout never differs from its snapshot: a cutover is
 *  weighed by the service's build alone. */
const UNCHANGED: sourceSnapshot.ServiceSource = { snapshot: SNAPSHOT, refusedSource: undefined, sweepOthers: async () => {}, cutoverAnswer: (build) => build }

/** Runs a dev serve in `home` whose entry reports `source`, and answers the
 *  serve's exit code, how many times the entry was reported, and the
 *  identity record the serve published when it listened. `whileListening`
 *  starts once the serve listens, and the serve retires once nothing holds
 *  it after that. */
async function serveFrom(
  home: ReturnType<typeof devHome>,
  source: sourceSnapshot.ServiceSource,
  whileListening?: () => Promise<void>,
  extraSeams: Partial<ServeSeams> = {},
): Promise<{ readonly exitCode: number; readonly reports: number; readonly published: RuntimeIdentity | undefined }> {
  const reported = spyOn(sourceSnapshot, "reportSourceEntry").mockReturnValue(source)
  let published: RuntimeIdentity | undefined
  const client = Promise.withResolvers<void>()
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (String(chunk).includes('"flywheel":"serve.listening"')) {
      published = readRuntimeIdentity(home.identityPath)
      void (whileListening?.() ?? Promise.resolve()).then(client.resolve, client.reject)
    }
    return true
  })
  // A serve with a client to wait for is held until that client is done,
  // and then retires on the idle grace once nothing holds it.
  const seams: ServeSeams = whileListening === undefined ? { ...IDLE_SERVE, ...extraSeams } : { ...IDLE_SERVE, ...extraSeams, serveLifetime: () => new ServeLifetime({ resident: client.promise.then(() => false, () => false), startupGraceMs: 20, idleGraceMs: 10 }) }
  const manager = createPersistentProcessManager()
  try {
    const exitCode = await runServe([], { executionCwd: home.accountHome, projectRoot: home.accountHome, accountHome: home.accountHome, userDataRoot: home.userDataRoot }, unusedLauncher(), manager, false, seams)
    if (whileListening !== undefined) await client.promise
    return { exitCode, reports: reported.mock.calls.length, published }
  } finally {
    manager.releaseAll()
    write.mockRestore()
    reported.mockRestore()
  }
}

describe("a dev service's source snapshot", () => {
  test("is named in the service's identity record", async () => {
    expect(lane).toBe("dev")

    const { reports, published } = await serveFrom(devHome(), UNCHANGED)

    expect(reports).toBe(1)
    expect(published?.sourceSnapshot).toEqual(SNAPSHOT)
  }, 15_000)

  test("has its checkout's other snapshots swept once the service has published its identity record, and the service never waits for the sweep", async () => {
    const home = devHome()
    const sweeps: Array<RuntimeIdentity | undefined> = []

    // A sweep that never settles: the service stops on its own regardless.
    const { exitCode } = await serveFrom(home, {
      ...UNCHANGED,
      sweepOthers: () => {
        sweeps.push(readRuntimeIdentity(home.identityPath))
        return new Promise(() => {})
      },
    })

    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(sweeps).toEqual([expect.objectContaining({ pid: process.pid, sourceSnapshot: SNAPSHOT })])
  }, 15_000)

  test("is replaced when a new client's cutover request finds that its checkout's source changed, and the replacement's record names that trigger", async () => {
    const home = devHome()
    const change = { kind: "source changed", checkout: SNAPSHOT.checkout, ownDigest: SNAPSHOT.digest, currentDigest: "fedcba9876543210" } as const
    // The source asks for its replacement through the request the service
    // hands it, as a source whose checkout changed does.
    const { answers, exitCode, requests } = await cutoverOf(home, { ...UNCHANGED, cutoverAnswer: (_build, request) => (beforeRetire) => request(change, beforeRetire) })

    expect(answers).toEqual(["retiring"])
    expect(exitCode).toBe(SERVE_EXIT.restart)
    expect(requests).toEqual([{ trigger: "source changed", ...change }])
  }, 15_000)

  test("stays when its checkout's protocol changes: neither the build tick nor a cutover request weighs the checkout's build", async () => {
    // An agent's protocol bump in the checkout once replaced the dev service
    // under every running session (2026-10-02). The service runs an earlier
    // protocol than this checkout declares, and it reads the checkout with
    // the production reader, not a seam's build.
    expect(checkoutProtocolVersion()).toBe(RUNTIME_PROTOCOL_VERSION)
    const { answers, exitCode, requests } = await cutoverOf(devHome(), UNCHANGED, "cutover", {
      ownBuildId: () => sourceBuildId(RUNTIME_PROTOCOL_VERSION - 1),
      installedBuild: undefined,
      buildCheckMs: 5,
    })

    expect(answers).toEqual(["busy"])
    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(requests).toEqual([])
  }, 15_000)

  test("stays when a new client's cutover request finds that its checkout holds the snapshot's source", async () => {
    const { answers, exitCode, requests } = await cutoverOf(devHome(), UNCHANGED)

    expect(answers).toEqual(["busy"])
    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(requests).toEqual([])
  }, 15_000)
})

describe("a person's restart request", () => {
  test("replaces a service whose build and source are both unchanged, and the replacement's record names the restart", async () => {
    const { answers, exitCode, requests } = await cutoverOf(devHome(), UNCHANGED, "restart")

    expect(answers).toEqual(["retiring"])
    expect(exitCode).toBe(SERVE_EXIT.restart)
    expect(requests).toEqual([{ trigger: "restart requested", kind: "restart requested" }])
  }, 15_000)
})

/** Runs a dev serve whose entry reports `source`, sends it one client's
 *  `intent` request once it listens, and answers what the request heard,
 *  the serve's exit code, and each replacement request the serve recorded. */
async function cutoverOf(home: ReturnType<typeof devHome>, source: sourceSnapshot.ServiceSource, intent: "cutover" | "restart" = "cutover", extraSeams: Partial<ServeSeams> = {}) {
  const answers: string[] = []
  const recorded = spyOn(Log.create({ service: "replacement-owner" }), "info").mockImplementation(() => {})
  try {
    const credential = Redacted.value(readOrCreateAccountAttachToken(home.userDataRoot, lane))
    const { exitCode } = await serveFrom(home, source, async () => {
      answers.push(await requestAccountReplacement(accountServeSocketPath(home.userDataRoot, lane), credential, intent))
    }, extraSeams)
    return { answers, exitCode, requests: recorded.mock.calls.filter(([message]) => message === "replacement requested").map(([, fields]) => fields) }
  } finally {
    recorded.mockRestore()
  }
}
