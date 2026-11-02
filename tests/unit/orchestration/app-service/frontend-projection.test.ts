import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SubagentSessionRowSchema } from "../../../../src/protocol/session-catalog-protocol-schemas.js"
import {
  createFrontendProjection,
  projectSessionView,
  type SessionChange,
} from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeSummaryProjection } from "../../../../src/orchestration/app-service/runtime-summary-projection.js"
import { projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import type { SessionEntry } from "../../../../src/orchestration/session-store/types.js"
import { toSessionView } from "../../../../src/orchestration/session-store/view.js"
import {
  chatEntry,
  chatRunner,
  durableRow,
  durableSessionFromCatalogRow,
  fakeManager,
  fakeSessionStore,
  managerWithSessions,
  pendingQuestion,
  subagentEntry,
  workflowEntry,
} from "./_frontend-projection-fixtures.js"

async function awaitProjectionFlush(): Promise<void> {
  await Bun.sleep(1)
}

describe("frontend projection", () => {
  test("live chat entry with no runner projects chat identity and input metadata", async () => {
    const projection = createFrontendProjection({ projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map([["chat-1", chatEntry()]])),
      manager: managerWithSessions([durableRow("chat-1")]),
    })

    expect((await projection.snapshot()).rows[0]).toMatchObject({
      id: "chat-1",
      kind: "chat",
      inputMode: { kind: "chat" },
    })
  })

  test("live workflow agent detail projects identity without entering the catalog or leaking runner objects", async () => {
    const projection = createFrontendProjection({ projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map([["workflow-1", workflowEntry()]])),
      manager: managerWithSessions([durableRow("workflow-1", { kind: "workflow-agent", command: "workflow-agent", workflowMembership: { kind: "attempt", workflowId: "flow", attemptId: "attempt" } })]),
    })

    expect((await projection.snapshot()).rows).toEqual([])
    expect(await projection.liveCatalogRow("workflow-1")).toBeNull()
    const row = projectSessionView(toSessionView("workflow-1", workflowEntry(), "active"), "/workspace").row

    expect(row).toMatchObject({
      id: "workflow-1",
      kind: "workflow-agent",
      inputMode: { kind: "message" },
    })
    expect("workflow" in row).toBe(false)
    expect(JSON.stringify(row)).not.toContain("backend-only")
    expect(JSON.stringify(row)).not.toContain("runner")
  })

  test("a child is never a catalog row: no snapshot row, no baseline row, and no session change, while a chat in the same store lists", async () => {
    const child = durableRow("child-1", { kind: "subagent", command: "subagent", launchedFrom: { parentSessionId: "chat-1", toolUseId: "tool-1" }, parentSessionId: "chat-1" })
    const cold = durableRow("cold-child", { kind: "subagent", command: "subagent", launchedFrom: { parentSessionId: "chat-1", toolUseId: "tool-2" }, parentSessionId: "chat-1" })
    const chat = durableRow("chat-1", { childSessionIds: ["child-1", "cold-child"] })
    const store = fakeSessionStore(new Map<string, SessionEntry>([["child-1", subagentEntry()]]))
    const manager = managerWithSessions([chat, child, cold])
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager })

    expect((await projection.snapshot()).rows.map((row) => row.id)).toEqual(["chat-1"])
    expect(await projection.liveCatalogRow("child-1")).toBeNull()
    expect(await projection.catalogRow("cold-child")).toBeNull()
    // The child still projects for its own detail, with its admitted actions.
    expect(projectSessionView(toSessionView("child-1", subagentEntry(), "active"), "/workspace").row).toMatchObject({ kind: "subagent", admittedActions: ["session.delete"] })
    for (const [status, outcome] of [
      [undefined, undefined], ["created", undefined], ["paused", undefined], ["interrupted", undefined],
      ["completed", "completed"], ["partial", "partial"], ["failed", "failed"], ["stopped", "stopped"], ["cancelled", "cancelled"],
    ] as const) {
      const evidence = status === undefined ? {} : { childRun: { run: { status }, continuationAuthorized: false } }
      for (const projected of [
        projectSessionCatalogRow(child, evidence),
        projectSessionView(toSessionView("child-1", subagentEntry(), "inactive"), "/workspace", evidence).row,
      ]) {
        if (projected.kind !== "subagent") throw new Error("Expected a subagent row")
        expect(projected.runOutcome).toBe(outcome)
        expect(Object.hasOwn(projected, "runOutcome")).toBe(outcome !== undefined)
        expect(Schema.decodeUnknownSync(SubagentSessionRowSchema)(projected).runOutcome).toBe(outcome)
      }
    }

    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    await awaitProjectionFlush()
    // A child streaming, a child's metadata changing, and a child leaving the
    // store reach no subscriber; the chat's own change still does.
    store.emitChange("child-1")
    manager.emitChange(["child-1", "cold-child"])
    await awaitProjectionFlush()
    expect(batches.flat()).toEqual([])
    chat.label = "renamed"
    manager.emitChange(["chat-1"])
    await awaitProjectionFlush()
    expect(batches.flat()).toEqual([{ kind: "added", row: expect.objectContaining({ id: "chat-1", title: "renamed" }) }])
    batches.length = 0
    manager.emitDeleted("cold-child")
    await awaitProjectionFlush()
    expect(batches.flat()).toEqual([])
    unsubscribe()
  })

  test("activeRuntimeCount counts only live chats", async () => {
    const projection = createFrontendProjection({ projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map<string, SessionEntry>([["chat-1", chatEntry()], ["workflow-1", workflowEntry()], ["child-1", subagentEntry()]]), 42),
      manager: managerWithSessions([durableRow("chat-1")]),
    })

    expect((await projection.snapshot()).rows).toHaveLength(1)
    expect((await projection.snapshot()).activeRuntimeCount).toBe(1)
  })

  test("foreground SessionView projection carries presentation with loading totals", () => {
    const entry = chatEntry({
      runner: chatRunner("chat-1"),
      outputBlocks: () => [{ kind: "text", id: "text-1", content: "hello", timestamp: 1 }, pendingQuestion()],
      tokens: 123,
      cost: 4.56,
      contextPercent: 78,
      runnerState: "streaming",
      streamingStartedAt: 999,
    })
    const view = toSessionView("chat-1", entry, "active")
    const projected = projectSessionView(view, "/workspace")

    expect(projected.row.title).toBe(view.description)
    expect(projected.row.shortTitle).toBe(view.shortDescription)
    expect(projected.row.lifecycleState).toBe(view.lifecycleState)
    expect(projected.row.totalsLoading).toBe(true)
    expect(projected.row.totalTokens).toBeUndefined()
    expect(projected.row.totalCost).toBeUndefined()
    expect(projected.row.contextPercent).toBeUndefined()
    expect("metrics" in projected.row).toBe(false)
    expect("runtime" in projected.row).toBe(false)
  })

  test("foreground rows do not expose partial price totals", () => {
    const projected = projectSessionView(toSessionView("chat-1", chatEntry({ cost: 1.25, billedCost: 0.5, priceUnavailable: true }), "active"), "/workspace")
    expect(projected.row).toMatchObject({ totalsLoading: true })
    expect(projected.row.totalCost).toBeUndefined()
    expect(projectSessionCatalogRow({ ...durableRow("cold-1"), totalCost: 1.25, totalBilledCost: 0.5, priceUnavailable: true })).toMatchObject({ totalsLoading: true })
  })

  test("live presentation remains authoritative while totals load", async () => {
    const projection = createFrontendProjection({ projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map([["chat-1", chatEntry({ tokens: 222, cost: 3.14, contextPercent: 44, accumulatedActiveMs: 5678 })]])),
      manager: managerWithSessions([durableRow("chat-1", {
        lifecycleState: "active",
        totalCost: 0,
        totalTokens: 0,
        contextPercent: 0,
        durationMs: 0,
      })]),
    })

    expect((await projection.snapshot()).rows[0]).toMatchObject({
      id: "chat-1",
      title: "Projected chat",
      activity: "absent",
      totalsLoading: true,
    })
  })

  test("partial durable aggregates become loading rows", async () => {
    const diffStats = { added: 5, modified: 6, removed: 7 }

    expect(projectSessionCatalogRow({ ...durableRow("durable-1"), diffStats })).toMatchObject({ totalsLoading: true })

    const projection = createFrontendProjection({ projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map([["chat-1", chatEntry()]])),
      manager: fakeManager({
        listMetadata: async () => ({
          sessions: [{ ...durableRow("chat-1"), diffStats }],
          errors: [],
        }),
      }),
    })

    expect((await projection.snapshot()).rows[0]?.diffStats).toBeUndefined()
  })

  test("a late catalog subscription publishes summaries that completed after the startup snapshot", async () => {
    const session = durableRow("cold-1")
    const ready = projectSessionCatalogRow({
      ...session,
      totalCost: 0,
      totalBilledCost: 0,
      priceUnavailable: false,
      totalTokens: 0,
      contextPercent: 0,
      contextPromptTokens: 0,
      durationMs: 0,
      diffStats: { added: 2, modified: 1, removed: 0 },
    })
    const summaries = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async () => ({ rows: [projectSessionCatalogRow(session)], errors: [], totalsLoading: true, generationSpeeds: {} }),
        waitForTotals: async () => ({ rows: [ready], errors: [], totalsLoading: false, generationSpeeds: {} }),
      },
      sessionPlacements: { placement: async () => null, observe: () => {} },
      onStored: () => () => {},
    })
    const projection = createFrontendProjection({
      projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map()),
      manager: managerWithSessions([session]),
      summaries,
      maxSnapshotHz: 1000,
    })

    expect((await projection.snapshot()).rows[0]).toMatchObject({ id: session.id, totalsLoading: true })
    await Bun.sleep(0)
    await summaries.settled()

    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    await awaitProjectionFlush()

    expect(batches.flat()).toContainEqual({
      kind: "added",
      row: expect.objectContaining({
        id: session.id,
        totalsLoading: false,
        diffStats: { added: 2, modified: 1, removed: 0 },
      }),
    })
    unsubscribe()
    projection.dispose()
    summaries.dispose()
  })

  test("durable and live catalog rows keep the recorded directory after it is removed", async () => {
    // A row's paths mean what they meant when recorded (PI-INTERACTION-005):
    // removing the directory never re-reads them against the project root.
    const recorded = mkdtempSync(join(tmpdir(), "flywheel-catalog-cwd-"))
    rmSync(recorded, { recursive: true, force: true })
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    const manager = managerWithSessions([durableRow("chat-1", { executionCwd: recorded }), durableRow("durable-1", { executionCwd: recorded })])
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager, maxSnapshotHz: 1000 })

    expect((await projection.snapshot()).rows.map((row) => row.executionCwd)).toEqual([recorded, recorded])

    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    await awaitProjectionFlush()
    entries.set("chat-1", { ...chatEntry(), shortDescription: "Changed" })
    store.emitChange("chat-1")
    manager.emitChange(["chat-1"])
    await awaitProjectionFlush()
    expect(batches.at(-1)?.[0]).toMatchObject({ kind: "updated", row: { id: "chat-1", executionCwd: recorded } })
    unsubscribe()
  })

  test("durable and live catalog rows carry createdAt from metadata", async () => {
    const createdAt = "2025-12-31T00:00:00.000Z"

    expect(projectSessionCatalogRow({ ...durableRow("durable-1"), createdAt }).createdAt).toBe(createdAt)

    const projection = createFrontendProjection({ projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map([["chat-1", chatEntry()]])),
      manager: fakeManager({
        listMetadata: async () => ({
          sessions: [{ ...durableRow("chat-1"), createdAt }],
          errors: [],
        }),
      }),
    })

    expect((await projection.snapshot()).rows[0]?.createdAt).toBe(createdAt)
  })

  test("live snapshots do not request scoped aggregate folds", async () => {
    const diffStats = { added: 1, modified: 0, removed: 0 }
    const scopedReads: string[][] = []
    const projection = createFrontendProjection({ projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map([["chat-1", chatEntry()]])),
      manager: fakeManager({
        listForIds: async (ids) => {
          scopedReads.push([...ids])
          return { sessions: [{ ...durableRow("chat-1"), diffStats }], errors: [] }
        },
        listMetadata: async () => ({
          sessions: [durableRow("chat-1")],
          errors: [],
        }),
      }),
    })

    expect((await projection.snapshot()).rows).toEqual([expect.objectContaining({ id: "chat-1", totalsLoading: true })])
    expect((await projection.snapshot()).rows[0]?.diffStats).toBeUndefined()
    expect(scopedReads).toEqual([])
  })

  test("a manager signal republishes only the changed durable row without live stat reads", async () => {
    const scopedReads: string[][] = []
    const diffStats = { added: 1, modified: 0, removed: 0 }
    let durableRows = [durableRow("durable-1")]
    const store = fakeSessionStore(new Map<string, SessionEntry>([["chat-1", chatEntry()]]))
    const manager = fakeManager({
      listForIds: async (ids) => {
        scopedReads.push([...ids])
        return {
          sessions: [{ ...durableRow("chat-1"), diffStats }, ...durableRows].filter((row) => ids.includes(row.id)),
          errors: [],
        }
      },
      listMetadata: async () => ({ sessions: [durableRow("chat-1"), ...durableRows], errors: [] }),
    })
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    scopedReads.length = 0

    durableRows = [{ ...durableRow("durable-1"), label: "renamed" }]
    manager.emitChange(["durable-1"])
    await awaitProjectionFlush()

    expect(scopedReads).toEqual([["durable-1"]])
    const changes = batches.flat()
    const durableChange = changes.find((change) => change.kind !== "removed" && change.row.id === "durable-1")
    expect(durableChange).toEqual({ kind: "added", row: expect.objectContaining({ id: "durable-1", title: "renamed" }) })
    unsubscribe()
  })

  test("a live session going durable re-emits as a metadata-only updated row, not a removal", async () => {
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    const projection = createFrontendProjection({ projectRoot: tmpdir(),
      sessionStore: store,
      manager: managerWithSessions([durableRow("chat-1")]),
    })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    entries.delete("chat-1")
    store.emitChange()
    await awaitProjectionFlush()

    expect(batches.flat()).toEqual([{ kind: "updated", row: expect.objectContaining({ id: "chat-1", lifecycleState: "inactive" }) }])
    unsubscribe()
  })

  test("telemetry-only facts emit no per-session change; a visible field emits one updated change carrying that one catalog row", async () => {
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager: managerWithSessions([durableRow("chat-1")]) })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    entries.set("chat-1", { ...chatEntry(), streamingToolText: { "tool-1": { content: "partial" } } })
    store.emitChange("chat-1")
    await awaitProjectionFlush()
    expect(batches).toHaveLength(0)

    entries.set("chat-1", { ...chatEntry(), shortDescription: "Updated" })
    store.emitChange("chat-1")
    await awaitProjectionFlush()
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(1)
    expect(batches[0]?.[0]).toMatchObject({ kind: "updated", row: { id: "chat-1" } })
    unsubscribe()
  })

  test("an unchanged notify re-serializes nothing; only the moved session's row is re-projected", async () => {
    let stableReads = 0
    const stableBase = chatEntry()
    // A getter on a field the summary projection reads (`description`) counts how
    // many times the unchanged session is re-projected/re-serialized per flush.
    const stable: SessionEntry = {
      ...stableBase,
      get description() {
        stableReads += 1
        return "Stable chat"
      },
    }
    const entries = new Map<string, SessionEntry>([["stable", stable], ["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager: managerWithSessions([durableRow("stable"), durableRow("chat-1")]) })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    // Notify with nothing changed: no revision moved, so no row is re-projected.
    await awaitProjectionFlush()
    const baselineReads = stableReads
    store.emitChange()
    await awaitProjectionFlush()
    expect(batches).toHaveLength(0)
    expect(stableReads).toBe(baselineReads)

    // Move only chat-1: the stable session's revision is unchanged, so its row is
    // neither re-projected nor re-serialized, and only chat-1 is emitted.
    entries.set("chat-1", { ...chatEntry(), shortDescription: "Changed" })
    store.emitChange("chat-1")
    await awaitProjectionFlush()
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual([{ kind: "updated", row: expect.objectContaining({ id: "chat-1" }) }])
    expect(stableReads).toBe(baselineReads)
    unsubscribe()
  })

  test("per-session changes are coalesced under burst catch-up into one batch", async () => {
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager: managerWithSessions([durableRow("chat-1")]), maxSnapshotHz: 1_000 })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    for (let i = 1; i <= 5; i += 1) {
      entries.set("chat-1", { ...chatEntry(), shortDescription: `Changed ${i}` })
      store.emitChange("chat-1")
    }

    await awaitProjectionFlush()
    expect(batches).toHaveLength(1)
    await Bun.sleep(2)
    expect(batches).toHaveLength(1)
    expect(batches.flat().every((c) => c.kind === "updated")).toBe(true)
    unsubscribe()
  })

  test("deleting a durable-only session the diff never keyed still emits removed (writer signal is the authority)", async () => {
    let sessions = [durableRow("durable-1")]
    const manager = fakeManager({ listMetadata: async () => ({ sessions, errors: [] }) })
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: fakeSessionStore(new Map()), manager })
    await projection.snapshot()
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    // No flush has run yet, so the diff never keyed durable-1; the deletion
    // erases the metadata row a re-read would need, so only the manager's
    // deleted signal can produce the removal.
    sessions = []
    manager.emitDeleted("durable-1")
    await awaitProjectionFlush()

    expect(batches).toEqual([[{ kind: "removed", sessionId: "durable-1" }]])
    unsubscribe()
  })

  test("a deletion of an already-keyed durable session emits exactly one removed", async () => {
    let sessions = [durableRow("durable-1"), durableRow("durable-2")]
    const manager = fakeManager({
      listMetadata: async () => ({ sessions, errors: [] }),
      listForIds: async (ids) => ({ sessions: sessions.filter((row) => ids.includes(row.id)), errors: [] }),
    })
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: fakeSessionStore(new Map()), manager, maxSnapshotHz: 1000 })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    manager.emitChange(["durable-1", "durable-2"])
    await Bun.sleep(5)

    sessions = sessions.filter((row) => row.id !== "durable-1")
    manager.emitDeleted("durable-1")
    await Bun.sleep(5)

    const removals = batches.flat().filter((change) => change.kind === "removed")
    expect(removals).toEqual([{ kind: "removed", sessionId: "durable-1" }])
    unsubscribe()
  })

  test("cold degraded chat catalog rows remain visible without a resident runner", async () => {
    const degraded = {
      ...durableRow("chat-degraded"),
      degraded: true as const,
      unavailableFields: ["authProfileId"],
    }
    const projection = createFrontendProjection({
      projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map()),
      manager: managerWithSessions([degraded]),
    })

    expect((await projection.snapshot()).rows).toEqual([
      expect.objectContaining({ id: "chat-degraded", degraded: true, activity: "absent" }),
    ])
  })

  test("a live session with no durable metadata projects no catalog row: metadata owns the execution directory", async () => {
    const projection = createFrontendProjection({ projectRoot: tmpdir(),
      sessionStore: fakeSessionStore(new Map([["chat-1", chatEntry()]])),
      manager: fakeManager(),
    })

    expect((await projection.snapshot()).rows).toEqual([])
    expect(await projection.catalogRow("chat-1")).toBeNull()
    expect(await projection.liveCatalogRow("chat-1")).toBeNull()
  })

  test("a session whose per-id manager read tears mid-deletion still projects from the listed row", async () => {
    // The catalog listing and the per-id read are two reads of the same
    // authority. A session deleted between them must not throw the whole
    // diff away: the listed row is a complete projection input on its own.
    const manager = managerWithSessions([durableRow("torn-1"), durableRow("chat-1")], {
      read: async (id) => (id === "torn-1" ? null : durableSessionFromCatalogRow(durableRow("chat-1"))),
    })
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager, maxSnapshotHz: 1000 })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    entries.set("torn-1", chatEntry())
    manager.emitChange(["torn-1"])
    await Bun.sleep(5)

    // chat-1 was live at subscribe time, so the snapshot already carries it; the
    // torn session must still arrive as a change, and nothing may be removed.
    const added = batches.flat().filter((change) => change.kind === "added").map((change) => change.row.id)
    expect(added).toEqual(["torn-1"])
    expect(batches.flat().filter((change) => change.kind === "removed")).toEqual([])
    unsubscribe()
  })

  test("one unprojectable session degrades only itself and recovers when its row heals", async () => {
    let poisoned = true
    const badRow = () => {
      const row = durableRow("bad-1")
      if (!poisoned) return row
      return Object.defineProperty({ ...row }, "label", {
        get(): string { throw new Error("poisoned row") },
        enumerable: true,
      })
    }
    const manager = fakeManager({
      listMetadata: async () => ({ sessions: [badRow(), durableRow("ok-1")], errors: [] }),
      listForIds: async (ids) => ({ sessions: [badRow(), durableRow("ok-1")].filter((session) => ids.includes(session.id)), errors: [] }),
    })
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: fakeSessionStore(new Map()), manager, maxSnapshotHz: 1000 })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    manager.emitChange(["bad-1", "ok-1"])
    await Bun.sleep(5)
    expect(batches.flat()).toEqual([{ kind: "added", row: expect.objectContaining({ id: "ok-1" }) }])

    poisoned = false
    manager.emitChange(["bad-1"])
    await Bun.sleep(5)
    const added = batches.flat().filter((change) => change.kind === "added").map((change) => change.row.id).sort()
    expect(added).toEqual(["bad-1", "ok-1"])
    unsubscribe()
  })

  test("an affected metadata read failure retains the ID and recovers on a later store signal", async () => {
    let failing = true
    const manager = fakeManager({
      listForIds: async (ids) => {
        if (failing) throw new Error("catalog read failed")
        return { sessions: [durableRow("late-1")].filter((row) => ids.includes(row.id)), errors: [] }
      },
    })
    const store = fakeSessionStore(new Map())
    const projection = createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager, maxSnapshotHz: 1000 })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })

    manager.emitChange(["late-1"])
    await Bun.sleep(5)
    expect(batches).toEqual([])

    failing = false
    store.emitChange()
    await Bun.sleep(5)
    expect(batches.flat()).toEqual([{ kind: "added", row: expect.objectContaining({ id: "late-1" }) }])
    unsubscribe()
  })
})
