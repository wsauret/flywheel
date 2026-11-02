import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { runServe } from "../../../src/cli/serve.js"
import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { accountServeRecordPath, accountServeSocketPath } from "../../../src/infra/paths.js"
import { ServeLifetime } from "../../../src/orchestration/app-service/serve-lifetime.js"
import { IDLE_SERVE, unusedLauncher } from "./_serve-fixtures.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

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
        residency: async () => ({ resident: true, followsRegistration: false }),
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
