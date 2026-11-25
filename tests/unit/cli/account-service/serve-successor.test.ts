import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { runServe } from "../../../../src/cli/account-service/serve.js"
import { SERVE_EXIT } from "../../../../src/cli/account-service/serve-contract.js"
import { restartRefusal } from "../../../../src/cli/account-service/serve-next-service.js"
import { RESTART_NO_STARTER_REASON, RESTART_TASK_SCHEDULER_REASON, restartLaunchMissingReason } from "../../../../src/protocol/client/runtime/copy/service-restart-copy.js"
import { serveLaneFor } from "../../../../src/infra/cli-subprocess.js"
import { createPersistentProcessManager } from "../../../../src/infra/supervision/persistent/persistent-process-manager.js"
import { accountServeRecordPath, accountServeSocketPath } from "../../../../src/infra/paths.js"
import { ServeLifetime } from "../../../../src/orchestration/app-service/account/serve-lifetime.js"
import { IDLE_SERVE, unusedLauncher } from "./_serve-fixtures.js"
import { socketTemporaryRoot } from "../../../helpers/directories.js"

const lane = serveLaneFor(process.execPath)
let temporaryRoot: string | undefined

afterEach(() => {
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

describe("a resident account service that a newer build retires", () => {
  test.each([
    ["that no service manager started starts its own successor once its address is free", false, ["successor started with the address free"]],
    ["that its service manager started leaves the restart to the manager", true, []],
  ] as const)("%s", async (_name, startedByManager, expected) => {
    temporaryRoot = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-serve-succ-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const manager = createPersistentProcessManager()
    const events: string[] = []
    const addressHeld = () => fs.existsSync(accountServeSocketPath(userDataRoot, lane)) || fs.existsSync(accountServeRecordPath(userDataRoot, lane))
    let exitCode: number | undefined
    try {
      // No client is connected, and the account's `current` build is newer
      // than the one this service runs.
      exitCode = await runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, unusedLauncher(), manager, false, {
        ...IDLE_SERVE,
        residency: async () => ({ resident: true, followsRegistration: false, startsRegisteredJob: false }),
        serveLifetime: () => new ServeLifetime({ resident: true }),
        ownBuildId: () => "old",
        installedBuild: () => ({ buildId: "new", version: "1.0.0" }),
        buildCheckMs: 20,
        registrationRefresh: () => ({ atStart: async () => "serve", afterListening: async () => {}, atBuildTick: async () => false, startedByManager: () => startedByManager }),
        startSuccessor: async () => { events.push(`successor started with the address ${addressHeld() ? "held" : "free"}`) },
      })
    } finally {
      manager.releaseAll()
      write.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.restart)
    expect(events).toEqual([...expected])
  }, 15_000)
})

describe("why a web client's restart would bring no successor", () => {
  const launches = (): string | undefined => undefined
  test.each([
    ["a service its manager started on macOS", { resident: true, startedByManager: true }, "darwin", undefined],
    ["a service its manager started on Linux", { resident: true, startedByManager: true }, "linux", undefined],
    ["a service Task Scheduler started, which is not proven to restart it", { resident: true, startedByManager: true }, "win32", RESTART_TASK_SCHEDULER_REASON],
    ["a resident service no manager started, which starts its own", { resident: true, startedByManager: false }, "win32", undefined],
    ["a service a client started, which nothing restarts", { resident: false, startedByManager: false }, "darwin", RESTART_NO_STARTER_REASON],
  ] as const)("%s", (_name, service, platform, expected) => {
    expect(restartRefusal(service, platform, launches)).toBe(expected)
  })

  test("a resident service that starts its own successor refuses while the program it would run is missing", () => {
    const missing = restartLaunchMissingReason("/scratch/flywheel")
    expect(restartRefusal({ resident: true, startedByManager: false }, "darwin", () => missing)).toBe(missing)
    // A manager-started service never runs the check: its manager starts the successor.
    expect(restartRefusal({ resident: true, startedByManager: true }, "darwin", () => missing)).toBeUndefined()
  })
})
