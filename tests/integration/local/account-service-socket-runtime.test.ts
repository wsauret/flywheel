import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"

import { isRuntimeListening, readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountServeRecordPath, accountServeSocketPath, projectWebTokenPath } from "../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { attachAccountProject, createIsolatedAccountRuntimeAttach, isolatedHubOrigin, joinIsolatedAccountService } from "./_account-service.js"
import { removeWhenReleased } from "../../helpers/remove-when-released.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

// The isolated account service is started through this process's bun, so it serves this process's lane.
const LANE = serveLaneFor(process.execPath)

// Canonical, because the service address is a hash of the account data root
// string. The service derives that root through the same realpath the account
// home takes, so an uncanonicalized root here names a different address than
// the one it serves.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-account-socket-")))
const accountHome = path.join(TMP, "home")
const userDataRoot = path.join(accountHome, ".flywheel")

/** The origin of a project's browser endpoint as the service reports it: the
 *  link its hub offers once the project serves its page. The service binds
 *  the project's preferred port only when that port is free, and another
 *  program may answer there, so the test never derives the port itself. The
 *  hub offers the link only after the source run builds the web client, which
 *  takes up to half a minute, so the deadline bounds that build. */
async function waitForBrowserOrigin(projectRoot: string): Promise<string> {
  const label = path.basename(projectRoot)
  const deadline = Date.now() + 45_000
  for (;;) {
    const page = await (await fetch(`${isolatedHubOrigin(accountHome)}/`, { redirect: "manual" })).text()
    const link = new RegExp(`href="([^"]+)" aria-label="Open ${label}"`).exec(page)?.[1]
    if (link !== undefined) return new URL(link.replaceAll("&amp;", "&")).origin
    if (Date.now() >= deadline) throw new Error(`the hub offers no link to ${label}`)
    await Bun.sleep(50)
  }
}

/** Stops the isolated service and waits for its process to exit, which the
 *  temporary home below must outlive: the drain closes projects and runs their
 *  maintenance. The exit is the signal, not the identity record. A service that
 *  runs its graceful path withdraws the record before it drains, but a
 *  terminated one never does, and Windows has no signal that runs that path for
 *  another process. `flywheel kill` owns the same asymmetry: it clears the
 *  rendezvous of a service that is gone rather than waiting to be told. */
async function stopAccountService(): Promise<void> {
  const identity = readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))
  if (!identity) return
  try {
    process.kill(identity.pid, "SIGTERM")
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
  }
  await joinIsolatedAccountService(userDataRoot)
  fs.rmSync(accountServeRecordPath(userDataRoot, LANE), { force: true })
}

afterAll(async () => {
  await stopAccountService()
  // A terminated service leaves its project executors to their guardians,
  // which end them after the kill grace. Until then the executors hold their
  // project stores open, and Windows refuses to remove an open file.
  removeWhenReleased(TMP, 30_000)
}, 60_000)

describe("account service socket runtime", () => {
  test("becomes attach-ready and serves authenticated reads for distinct projects", async () => {
    fs.mkdirSync(userDataRoot, { recursive: true })
    const projectA = path.join(TMP, "project-a")
    const projectB = path.join(TMP, "project-b")
    fs.mkdirSync(path.join(projectA, ".git"), { recursive: true })
    fs.mkdirSync(path.join(projectB, ".git"), { recursive: true })

    const base = { accountHome, userDataRoot, allowPersistentProcesses: false }
    const attach = createIsolatedAccountRuntimeAttach({
      ...base,
      executionCwd: projectA,
      projectRoot: projectA,
    })
    const phases: string[] = []
    await attach.ensure((status) => {
      if (status.kind === "phase") phases.push(status.label)
    })

    expect(phases).toContain("Starting account service")
    // A connection, not the path's presence, proves the service: `existsSync`
    // reads a Windows named pipe whose every instance is taken as a missing path.
    expect(await isRuntimeListening(accountServeSocketPath(userDataRoot, LANE))).toBe(true)
    expect(readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))?.pid).toBeGreaterThan(0)
    const clientA = await attachAccountProject({ ...base, executionCwd: projectA, projectRoot: projectA })
    const clientB = await attachAccountProject({ ...base, executionCwd: projectB, projectRoot: projectB })
    try {
      expect((await clientA.client.query({ type: "snapshot" })).rows).toEqual([])
      expect((await clientB.client.query({ type: "snapshot" })).rows).toEqual([])

      // A terminal attach starts browser serving too: no browser-intent
      // request is needed to bind the endpoint, and reading the hub opens nothing.
      for (const project of [projectA, projectB]) {
        const browserEndpoint = await fetch(`${await waitForBrowserOrigin(project)}/`)
        expect(browserEndpoint.status).toBe(200)
      }
      await attach.openProject()

      const opened = await clientA.client.dispatch({ type: "chat.open" })
      expect(opened.ok).toBe(true)
      expect((await clientA.client.query({ type: "snapshot" })).rows).toHaveLength(1)
      expect((await clientB.client.query({ type: "snapshot" })).rows).toEqual([])
    } finally {
      await Promise.all([clientA.dispose(), clientB.dispose()])
    }
  }, 60_000)

  test("a failed browser start leaves terminal access usable and retries after the cause is repaired", async () => {
    const projectRoot = path.join(TMP, "project-browser-repair")
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    const tokenPath = projectWebTokenPath(userDataRoot, projectRoot)
    fs.mkdirSync(tokenPath, { recursive: true })
    const options = { accountHome, userDataRoot, projectRoot, executionCwd: projectRoot, allowPersistentProcesses: false }
    const attach = createIsolatedAccountRuntimeAttach(options)
    const client = await attachAccountProject(options)
    try {
      expect((await client.client.query({ type: "snapshot" })).rows).toEqual([])
      await expect(attach.openProject()).rejects.toThrow()
      fs.rmSync(tokenPath, { recursive: true })
      await attach.openProject()
      const endpoint = await fetch(`${await waitForBrowserOrigin(projectRoot)}/`)
      expect(endpoint.status).toBe(200)
      expect((await client.client.query({ type: "snapshot" })).rows).toEqual([])
    } finally {
      await client.dispose()
    }
  }, 60_000)

  test("a project that reaches readiness runs its startup maintenance, whose every write lands through the project's state Worker", async () => {
    fs.mkdirSync(userDataRoot, { recursive: true })
    const projectRoot = path.join(TMP, "project-maintenance")
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    const directories = { accountHome, userDataRoot, projectRoot, executionCwd: projectRoot }
    // A store an earlier build left: rows of a retired family beside a live
    // fact, and an index the schema retired.
    const prepared = prepareWorkspaceState(directories)
    const store = createSqliteEventStore(prepared.dbFile)
    const retired = { aggregateId: "maintenance-probe", sessionId: "maintenance-probe", type: "file.read", version: 1, timestamp: 1, actor: "flywheel", payload: {} }
    store.append(retired)
    store.append(retired)
    store.append({ ...retired, type: "test.fact" })
    store.close()
    prepared.generation.release()
    const seeded = new Database(prepared.dbFile)
    seeded.exec("create index event_parent_tool_fact_idx on event(aggregate_id, type, position)")
    seeded.close()

    const read = () => {
      const db = new Database(prepared.dbFile, { readonly: true })
      try {
        return {
          types: db.query<{ type: string }, []>("select type from event order by position").all().map((row) => row.type),
          retiredIndex: db.query<{ name: string }, []>("select name from sqlite_master where type = 'index' and name = 'event_parent_tool_fact_idx'").get() !== null,
        }
      } finally {
        db.close()
      }
    }
    // The attached client opens the project with its first call and holds it
    // open while its maintenance runs.
    const client = await attachAccountProject(directories)
    try {
      expect((await client.client.query({ type: "snapshot" })).rows).toEqual([])
      // The Learning corpus pass is the job's last step, and its completion
      // is a fact its lease writes through the same writer as every other step.
      const deadline = Date.now() + 30_000
      let state = read()
      while (!state.types.includes("skill.cleanup.completed") && Date.now() < deadline) {
        await Bun.sleep(50)
        state = read()
      }
      expect(state.types).toContain("skill.cleanup.completed")
      expect(state.types).toContain("skill.loads.snapshotted")
      expect(state.types).not.toContain("file.read")
      expect(state.types).toContain("test.fact")
      expect(state.retiredIndex).toBe(false)
    } finally {
      await client.dispose()
    }
  }, 60_000)
})
