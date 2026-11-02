import { expect, test } from "bun:test"
import { copyFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { temporaryDirectories, testDirectories } from "../../helpers/directories.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { assertMutationEvidence } from "../../../src/infra/mutation-evidence.js"
import { inspectUpgradeFixture } from "../../release/fixtures/workflow-agent-previous-shape.js"
import snapshot from "../../release/fixtures/workflow-agent-small-previous-shape.json"
import { firstOpenEvidence, readUpgradeMemoryEvidence, readUpgradeState, secondOpenFailures, upgradeMemoryMetrics, upgradeReadiness } from "../../release/scenarios/workflow-agent-upgrade.js"

const temporary = temporaryDirectories()

function fixture(root: string): string {
  prepareWorkspaceState(testDirectories(root)).generation.release()
  const dbFile = resolveEventStoreDbFile(root)
  const store = createSqliteEventStore(dbFile)
  try {
    for (const row of snapshot.content) if (row.sessionContentNode === 1) store.stageSessionContentNodes(row.sessionId, [{ sha256: row.sha256, node: JSON.parse(row.content) }])
    store.appendBatch(snapshot.events.map(event => ({
      ...event,
      contentRows: snapshot.content.filter(row => row.sessionId === event.sessionId),
    })))
    for (const row of snapshot.inFlight) store.putInFlight(row.sessionId, row.kind, row.key, row.payload)
  } finally { store.close() }
  return dbFile
}

test("frozen pre-D bytes contain real generations, tools, content, children, and follow-ups", () => {
  const root = temporary("upgrade-shape-")
  const dbFile = fixture(root)
  expect(inspectUpgradeFixture(dbFile)).toMatchObject({ workflows: 2, generations: 8, followUps: 2, toolCalls: 16, contentBytes: 8192, nestedChildren: 2, admittedDeletions: 0 })
  expect(readUpgradeState(dbFile)).toMatchObject({ convertedWorkflows: 0, convertedGenerations: 0, followUps: 0, providerRequests: 0 })
  prepareWorkspaceState(testDirectories(root)).generation.release()
  const first = readUpgradeState(dbFile)
  expect(secondOpenFailures(first, first, "candidate")).toEqual([])
  const changed = { ...first, fingerprint: "different retained facts" }
  expect(secondOpenFailures(first, changed, "candidate")).toEqual(["second open changed durable facts, accounting, retained input, or notices"])
  expect(secondOpenFailures(first, changed, "baseline")).toEqual([])
  expect(first).toMatchObject({ convertedWorkflows: 2, convertedGenerations: 8, followUps: 2, residualGapCount: 0, providerRequests: 0 })
  expect(inspectUpgradeFixture(dbFile).toolCalls).toBe(16)
  const store = createSqliteEventStore(dbFile)
  try {
    const output = store.read({ types: ["tool.execution_output.recorded"] }).find(row => row.payload.mutationEvidence !== undefined)!
    assertMutationEvidence(output.payload.mutationEvidence, sha256 => store.readSessionContentNode!(output.sessionId, sha256))
  } finally { store.close() }
  prepareWorkspaceState(testDirectories(root)).generation.release()
  expect(readUpgradeState(dbFile)).toEqual(first)
})

test("an admitted old deletion excludes its workflow without rewriting its authorized plan", () => {
  const root = temporary("upgrade-deletion-")
  const dbFile = fixture(root)
  const store = createSqliteEventStore(dbFile)
  const plan = { version: 1, rootSessionId: "upgrade-0", edges: [] }
  store.putInFlight("upgrade-0", "session.subagent_recursive_deletion", "upgrade-0", plan)
  store.close()
  const copy = join(temporary("upgrade-copy-"), "previous.sqlite")
  copyFileSync(dbFile, copy)
  expect(inspectUpgradeFixture(copy).admittedDeletions).toBe(1)
  const admittedDeletions = readUpgradeState(dbFile).admittedDeletions
  expect(admittedDeletions).toEqual([{
    session_id: "upgrade-0", kind: "session.subagent_recursive_deletion", key: "upgrade-0", payload: JSON.stringify(plan),
  }])
  prepareWorkspaceState(testDirectories(root)).generation.release()
  expect(readUpgradeState(dbFile)).toMatchObject({ convertedWorkflows: 1, convertedGenerations: 4, followUps: 1 })
  expect(readUpgradeState(dbFile).admittedDeletions).toEqual(admittedDeletions)
})

test("conversion heap uses its state owner and includes synchronous peaks, not executor RSS", () => {
  const memory = upgradeMemoryMetrics([
    { runId: "open", role: "project-executor", pid: 3, cadenceMs: 100, samples: [{ timestampMs: 10, heapUsed: 999e6, rss: 999e6 }] },
    { runId: "open", role: "project-state", pid: 2, cadenceMs: 100, samples: [
      { timestampMs: 10, heapUsed: 1e6, rss: 2e6, phase: "workspace.begin" },
      { timestampMs: 11, heapUsed: 2e6, rss: 3e6, phase: "conversion.begin" },
      { timestampMs: 12, heapUsed: 8 * 1024 * 1024, rss: 16 * 1024 * 1024, phase: "conversion.workflow" },
      { timestampMs: 15, heapUsed: 2e6, rss: 3e6, phase: "conversion.end" },
      { timestampMs: 20, heapUsed: 1e6, rss: 2e6, phase: "workspace.end" },
    ] },
  ], "open")
  expect(memory).toEqual({ peakHeapMiB: 8, peakRssMiB: 16, conversionMs: 4 })
  expect(() => upgradeMemoryMetrics([], "open")).toThrow("state-owner")
})

test("an executor record that its shutdown kill left empty does not hide the startup records", () => {
  const directory = temporary("upgrade-memory-")
  const owner = { runId: "open", role: "project-state", pid: 2, cadenceMs: 100, samples: [{ timestampMs: 10, heapUsed: 1, rss: 2 }] }
  const summary = { runId: "open", role: "session-summary", pid: 2, cadenceMs: 100, samples: [{ timestampMs: 11, heapUsed: 1, rss: 2, phase: "summary.begin" }] }
  writeFileSync(join(directory, "project-state-2.json"), JSON.stringify(owner))
  writeFileSync(join(directory, "session-summary-2.json"), JSON.stringify(summary))
  writeFileSync(join(directory, "project-executor-3.json"), "")
  expect(readUpgradeMemoryEvidence(directory).sort((a, b) => a.role.localeCompare(b.role))).toEqual([owner, summary])
})

test("an interrupted first open keeps frame evidence without inventing readiness", () => {
  const failed = upgradeReadiness({
    metrics: { "startup.large.firstFrameMs": 12, "startup.large.sessionListMs": 84_000 },
    failures: ["runtime event lane silent past deadline"],
  }, "first")
  expect(failed.firstFrameMs).toBe(12)
  expect(failed.readyMs).toBeUndefined()
  expect(failed.failures).toContain("first: runtime event lane silent past deadline")
  expect(failed.failures).toContain("first: upgrade readiness requires chat input mode ready and a hydrated catalog")
  expect(upgradeReadiness({
    metrics: { "startup.large.readyMs": 80, "startup.large.sessionListMs": 90 }, failures: ["chat.open failed"],
  }, "first").readyMs).toBeUndefined()
  expect(upgradeReadiness({
    metrics: { "startup.large.firstFrameMs": 12, "startup.large.readyMs": 80, "startup.large.sessionListMs": 90 }, failures: [],
  }, "first").readyMs).toBe(90)
  const root = temporary("upgrade-interrupted-")
  const state = readUpgradeState(fixture(root))
  const collected = firstOpenEvidence({
    ...failed, runId: "first",
    evidence: [{ runId: "first", role: "project-state", pid: 2, cadenceMs: 100, samples: [
      { timestampMs: 10, heapUsed: 8 * 1024 ** 2, rss: 16 * 1024 ** 2, phase: "conversion.begin" },
      { timestampMs: 14, heapUsed: 4 * 1024 ** 2, rss: 12 * 1024 ** 2, phase: "conversion.end" },
    ] }],
  }, state)
  expect(collected.metrics).toEqual({
    "workflowAgentMigration.firstFrameMs": 12,
    "workflowAgentMigration.peakHeapMiB": 8,
    "workflowAgentMigration.peakRssMiB": 16,
    "workflowAgentMigration.conversionMs": 4,
    "workflowAgentMigration.convertedWorkflows": 0,
    "workflowAgentMigration.convertedGenerations": 0,
    "workflowAgentMigration.residualGapCount": 0,
  })
  expect(collected.failures).toContain("Error: first open has no summary-rebuild interval")
  expect(collected.failures).toContain("first: runtime event lane silent past deadline")
})
