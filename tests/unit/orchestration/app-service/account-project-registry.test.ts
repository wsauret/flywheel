import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { canonicalPathWithMissingTail } from "../../../../src/infra/canonical-path"
import { asAsyncEventAppender } from "../../../../src/infra/event-store-types"
import { accountEventStoreDbFile, resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { createAccountProjectRegistry, type AccountProjectRegistry } from "../../../../src/orchestration/app-service/account-project-registry"

const registries: AccountProjectRegistry[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(registries.splice(0).map((item) => item.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flywheel-account-projects-"))
  roots.push(root)
  const userDataRoot = join(root, "account")
  const firstProject = join(root, "first")
  const secondProject = join(root, "second")
  mkdirSync(firstProject)
  mkdirSync(secondProject)
  return { userDataRoot, firstProject, secondProject }
}

function registry(userDataRoot: string, now?: () => number): AccountProjectRegistry {
  const value = createAccountProjectRegistry({ userDataRoot, now })
  registries.push(value)
  return value
}

describe("account project registry", () => {
  it("keeps one opaque id for canonical root spellings, replaces metadata, and separates roots", async () => {
    const { userDataRoot, firstProject, secondProject } = fixture()
    let timestamp = 10
    const projects = registry(userDataRoot, () => timestamp)

    const first = await projects.record({ projectRoot: join(firstProject, "."), label: "First" })
    timestamp = 20
    const updated = await projects.record({ projectRoot: firstProject, label: "Renamed" })
    const second = await projects.record({ projectRoot: secondProject, label: "Second" })

    expect(updated).toEqual({ id: first.id, projectRoot: canonicalPathWithMissingTail(firstProject), label: "Renamed", lastAttachedAt: 20 })
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.id).not.toBe(first.id)
    expect(await projects.list()).toEqual([updated, second])
  })

  it("replays concurrent record and forget commits and notifies watchers without losing other rows", async () => {
    const { userDataRoot, firstProject, secondProject } = fixture()
    const first = registry(userDataRoot, () => 10)
    const second = registry(userDataRoot, () => 20)
    await first.record({ projectRoot: firstProject, label: "First" })
    await first.record({ projectRoot: secondProject, label: "Second" })
    const observed: string[][] = []
    const unwatch = first.watch((rows) => observed.push(rows.map((row) => row.label)))

    await Promise.all([
      second.record({ projectRoot: secondProject, label: "Second updated" }),
      first.forget(firstProject),
    ])

    const canonicalSecond = canonicalPathWithMissingTail(secondProject)
    expect(await first.list()).toEqual([expect.objectContaining({ projectRoot: canonicalSecond, label: "Second updated" })])
    expect(await second.list()).toEqual([expect.objectContaining({ projectRoot: canonicalSecond, label: "Second updated" })])
    expect(observed.at(-1)).toEqual(["Second updated"])
    unwatch()
  })

  it("forgets a project whose directory is gone, so no surface offers it again", async () => {
    const { userDataRoot, firstProject, secondProject } = fixture()
    const projects = registry(userDataRoot)
    await projects.record({ projectRoot: firstProject, label: "First" })
    await projects.record({ projectRoot: secondProject, label: "Second" })
    rmSync(secondProject, { recursive: true })
    expect((await projects.list()).map((project) => project.label)).toEqual(["First"])
    // The forget is recorded: a directory made again at that path is a new
    // project only once the machine opens it there.
    mkdirSync(secondProject)
    expect((await registry(userDataRoot).list()).map((project) => project.label)).toEqual(["First"])
  })

  it("rejects malformed owned facts during strict replay", async () => {
    const { userDataRoot, firstProject } = fixture()
    const store = createSqliteEventStore(accountEventStoreDbFile(userDataRoot))
    await asAsyncEventAppender(store).append({
      aggregateId: "account-project-registry",
      type: "account.project.registration.updated",
      version: 1,
      timestamp: 1,
      actor: "system",
      sessionId: "account",
      payload: { projectRoot: firstProject, status: "known" },
    })
    store.close()

    await expect(registry(userDataRoot).list()).rejects.toThrow("Missing key")
  })

  it("keeps each lane's replacement handoffs apart, reads them back, retires them, and leaves a row of an unknown version in place", async () => {
    const { userDataRoot, firstProject, secondProject } = fixture()
    const accounts = createAccountProjectRegistry({ userDataRoot })
    registries.push(accounts)
    const handoff = { handoffId: "h1", requestedAt: 5, predecessorPid: 4242, projectRoots: [firstProject, secondProject], phoneAwakeRoots: [secondProject] }
    await accounts.recordReplacementHandoff("installed", handoff)
    expect(accounts.replacementHandoffs("installed")).toEqual([{ version: 2, ...handoff }])
    expect(accounts.replacementHandoffs("dev")).toEqual([])
    // A rewrite adds a project the first write missed.
    await accounts.recordReplacementHandoff("installed", { ...handoff, projectRoots: [firstProject], phoneAwakeRoots: [] })
    expect(accounts.replacementHandoffs("installed")).toEqual([{ version: 2, ...handoff, projectRoots: [firstProject], phoneAwakeRoots: [] }])
    await accounts.retireReplacementHandoff("installed", "h1")
    expect(accounts.replacementHandoffs("installed")).toEqual([])

    const store = createSqliteEventStore(accountEventStoreDbFile(userDataRoot))
    store.putInFlight("serve:installed", "account.replacement_handoff", "h3", { version: 3, handoffId: "h3", requestedAt: 6, predecessorPid: 1, projectRoots: [], phoneAwakeRoots: [], sessions: [] })
    expect(accounts.replacementHandoffs("installed")).toEqual([])
    expect(store.readInFlight("serve:installed", "account.replacement_handoff")).toHaveLength(1)
    store.close()
  })

  // A version 1 row is what a build before the command handover leaves its
  // successor across an update.
  it("reads a version 1 handoff row as naming no project held awake for the phone", async () => {
    const { userDataRoot, firstProject } = fixture()
    const accounts = createAccountProjectRegistry({ userDataRoot })
    registries.push(accounts)
    const store = createSqliteEventStore(accountEventStoreDbFile(userDataRoot))
    store.putInFlight("serve:installed", "account.replacement_handoff", "h1", { version: 1, handoffId: "h1", requestedAt: 5, predecessorPid: 4242, projectRoots: [firstProject] })
    store.close()

    expect(accounts.replacementHandoffs("installed")).toEqual([
      { version: 2, handoffId: "h1", requestedAt: 5, predecessorPid: 4242, projectRoots: [firstProject], phoneAwakeRoots: [] },
    ])
  })

  it("does not open a project event store when the registry is empty", () => {
    const { userDataRoot, firstProject } = fixture()
    registry(userDataRoot)

    expect(existsSync(resolveEventStoreDbFile(firstProject))).toBeFalse()
    expect(existsSync(accountEventStoreDbFile(userDataRoot))).toBeTrue()
  })
})
