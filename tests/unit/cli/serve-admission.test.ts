/** A start of the account service admits the work that can convert durable
 *  state (project opens, the account module services, and the update
 *  coordinator) only once its start is confirmed, so the rollback (ARCH-RUNTIME-015)
 *  never returns from a start that converted state. */

import { describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { runServe } from "../../../src/cli/serve.js"
import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { errorMessage } from "../../../src/infra/error-message.js"
import { Log } from "../../../src/infra/log.js"
import { accountServeSocketPath } from "../../../src/infra/paths.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { createAccountProjectRegistry } from "../../../src/orchestration/app-service/account-project-registry.js"
import { claimProjectServing } from "../../../src/orchestration/app-service/project-serving-lane.js"
import { ServeLifetime } from "../../../src/orchestration/app-service/serve-lifetime.js"
import type { AccountUpdates } from "../../../src/orchestration/update/account-updates.js"
import * as accountRelay from "../../../src/orchestration/modules/remote/account-relay-service.js"
import { countStart, IDLE_SERVE, shortAccountHomes, startRecordText, unusedLauncher, waitFor } from "./_serve-fixtures.js"

// A serve run in this test process serves the lane of this process's executable.
const lane = serveLaneFor(process.execPath)
const accountHome = shortAccountHomes()

/** An update coordinator that runs nothing and reports its start. */
function reportingUpdates(started: () => void): AccountUpdates {
  return {
    status: () => ({ revision: 0, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "idle" } }),
    setAutoInstall: async () => ({ ok: true }),
    refreshPolicy: () => {},
    start: started,
    subscribe: () => () => {},
    dispose: async () => {},
  }
}

/** An account with a counted start of its installed build and one known
 *  project, which a hub can ask the service to open. */
async function accountWithProject(prefix: string) {
  const { root, accountHome: home, userDataRoot } = accountHome(prefix)
  const projectRoot = path.join(root, "project")
  fs.mkdirSync(projectRoot, { recursive: true })
  await countStart(userDataRoot)
  const registry = createAccountProjectRegistry({ userDataRoot })
  const project = await registry.record({ projectRoot, label: "project" })
  await registry.dispose()
  return { directories: { executionCwd: root, projectRoot: root, accountHome: home, userDataRoot }, userDataRoot, projectRoot, projectId: project.id }
}

/** Waits for the serve's listening record, and fails at once when the serve
 *  ends before it listens. */
async function listening(output: readonly string[], serving: Promise<number>): Promise<void> {
  const ended = serving.then(
    (code) => { throw new Error(`the serve ended with ${code} before it listened`) },
    (error: unknown) => { throw new Error(`the serve failed before it listened: ${errorMessage(error)}`) },
  )
  // The serve's later end settles this branch, which nothing then reads.
  ended.catch(() => {})
  await Promise.race([waitFor(() => output.some((chunk) => chunk.includes('"flywheel":"serve.listening"'))), ended])
}

describe("a start of the account service", () => {
  test("starts the update coordinator and lets an open that the hub requested proceed only once the start record confirms the start at its listen", async () => {
    const { directories, userDataRoot, projectRoot, projectId } = await accountWithProject("fw-serve-admit-")
    // The test holds the project in the other lane, so the open that
    // proceeds is refused at its claim and opens nothing.
    const releaseOtherLane = await claimProjectServing(projectRoot, lane === "installed" ? "dev" : "installed")
    // The listen confirms the start's count, so the record no longer counts it.
    const listened = () => !("unlistened" in JSON.parse(startRecordText(userDataRoot)))
    // Whether the start record had confirmed the start when each began.
    let updatesStarted: boolean | undefined
    let openProceeded: boolean | undefined
    // The open publishes its slot, which holds the serve, before it claims.
    class RecordingLifetime extends ServeLifetime {
      override setProjectCount(count: number): void {
        if (count > 0) openProceeded ??= listened()
        super.setProjectCount(count)
      }
    }
    const opened = Promise.withResolvers<unknown>()
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const manager = createPersistentProcessManager()
    try {
      const serving = runServe([], directories, unusedLauncher(), manager, false, {
        ...IDLE_SERVE,
        serveLifetime: () => new RecordingLifetime({ resident: true }),
        startHub: (options) => {
          void options.openProject(projectId).then(opened.resolve, opened.resolve)
          return { origin: "http://127.0.0.1:41000", held: () => true, stop() {} }
        },
        createUpdates: () => reportingUpdates(() => { updatesStarted ??= listened() }),
      })
      await listening(output, serving)
      expect(errorMessage(await opened.promise)).toContain("lane")
      expect({ updatesStarted, openProceeded }).toEqual({ updatesStarted: true, openProceeded: true })
      process.emit("SIGINT", "SIGINT")
      expect(await serving).toBe(SERVE_EXIT.restart)
    } finally {
      manager.releaseAll()
      write.mockRestore()
      releaseOtherLane()
    }
  }, 15_000)

  test("whose composition fails after its hub started stops the hub, and the open that the hub requested claims nothing", async () => {
    const { directories, userDataRoot, projectRoot, projectId } = await accountWithProject("fw-serve-failed-")
    const events: string[] = []
    const opened = Promise.withResolvers<unknown>()
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const watch = spyOn(fs, "watch")
    const manager = createPersistentProcessManager()
    try {
      await expect(runServe([], directories, unusedLauncher(), manager, false, {
        ...IDLE_SERVE,
        startHub: (options) => {
          void options.openProject(projectId).then(opened.resolve, opened.resolve)
          watch.mockImplementationOnce(() => { throw new Error(`Cannot watch ${userDataRoot}`) })
          return { origin: "http://127.0.0.1:41000", held: () => true, stop() { events.push("hub stopped") } }
        },
      })).rejects.toThrow(`Cannot watch ${userDataRoot}`)
      expect(events).toEqual(["hub stopped"])
      expect(await opened.promise).toBeInstanceOf(Error)
      expect(fs.existsSync(path.join(projectRoot, ".flywheel"))).toBe(false)
    } finally {
      manager.releaseAll()
      watch.mockRestore()
      write.mockRestore()
    }
  }, 15_000)

  test("whose account module service cannot start keeps listening and serving without it, and records one warning", async () => {
    const { root, accountHome: home, userDataRoot } = accountHome("fw-serve-module-")
    await countStart(userDataRoot)
    const relay = spyOn(accountRelay, "createAccountRelayService").mockImplementation(() => { throw new Error("the relay service cannot start") })
    const warn = spyOn(Log.create({ service: "account-service-runtime" }), "warn")
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const manager = createPersistentProcessManager()
    try {
      const serving = runServe([], { executionCwd: root, projectRoot: root, accountHome: home, userDataRoot }, unusedLauncher(), manager, false, {
        ...IDLE_SERVE,
        serveLifetime: () => new ServeLifetime({ resident: true }),
        createUpdates: () => reportingUpdates(() => {}),
      })
      await listening(output, serving)
      await waitFor(() => warn.mock.calls.length > 0)
      expect(warn.mock.calls).toEqual([["account module configuration could not be applied", { module: "remote", error: "the relay service cannot start" }]])
      const client = await Bun.connect({ unix: accountServeSocketPath(userDataRoot, lane), socket: { data() {} } })
      client.end()
      process.emit("SIGINT", "SIGINT")
      expect(await serving).toBe(SERVE_EXIT.restart)
    } finally {
      manager.releaseAll()
      write.mockRestore()
      warn.mockRestore()
      relay.mockRestore()
    }
  }, 15_000)
})
