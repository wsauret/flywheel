import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { contentEvidence } from "../../../src/infra/content-evidence"
import { canonicalDirectory } from "../../../src/infra/directory-authorities"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../src/infra/event-store-types"
import { resolveEventStoreDbFile, resolveSessionSummaryDbFile } from "../../../src/infra/paths"
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../src/infra/runtime-fact-mapper"
import { collectSkillLoadStats } from "../../../src/orchestration/modules/learning/skill-load-stats"
import { createConversationTree, tryOpenConversationTree } from "../../../src/orchestration/session/conversation/conversation-tree-handle"
import { createSessionManager } from "../../../src/orchestration/session/manager"
import { acquireSessionSummaryIndex } from "../../../src/orchestration/session/session-summary-index"
import { appendSkillLoadHistory, generateFixtureWorkspace, giantTranscript, RELEASE_WORKLOAD, SCROLL_WORKLOAD, SKILL_HISTORY_SESSION_ID, type FixtureWorkload } from "../../release/fixtures/generate-store"

const GIANT_SESSION_ID = "fixture-giant"
const GIANT_CONVERSATION_ID = `${GIANT_SESSION_ID}-conversation`
const TERMINAL_ANNOTATION = "End of giant fixture transcript."
/** The smallest workload that crosses each batch boundary of the writers.
 *  The giant transcript holds 20 cycles of 4 chat turns and one tool round
 *  trip (11 entries), then 3 chat turns and the terminal annotation: 227
 *  entries, so 3 append batches of 100 with a partial last batch, and 20
 *  oversized tool results. 1,001 history calls make 2 tool batches of 1,000
 *  with a partial last batch. */
const SMALL_WORKLOAD = { lightSessions: 3, giantEntries: 227, historyHeavyToolCalls: 1001 } satisfies FixtureWorkload

/** Canonical JSON in which only publication wall clocks and the temporary workspace path vary. */
function canonicalPublicationJson(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (["createdAt", "activatedAt", "lastUpdated"].includes(key)) return "<time>"
    if (key === "executionCwd") return "<root>"
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  })
}

let workDir: string | undefined

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  workDir = undefined
})

async function currentWriterVersion(file: string, conversationId: string) {
  const store = createSqliteEventStore(file)
  try {
    const tree = await createConversationTree({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    try {
      const projectRoot = canonicalDirectory(dirname(file), "current fixture producer probe")
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      await manager.createChat({ id: conversationId, conversationId: `${conversationId}-metadata-conversation` })
      await tree.appendMessage({ kind: "user", content: "Current producer marker" })
      const facts = store.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] })
      expect(facts).toHaveLength(1)
      const sessions = store.read({ aggregateId: `session:${conversationId}`, types: ["session.created"] })
      expect(sessions).toHaveLength(1)
      return { chat: facts[0]?.version, session: sessions[0]?.version }
    } finally {
      tree.getStorage().dispose()
    }
  } finally {
    store.close()
  }
}

/** The version the runtime's own tool-input writer produces today. */
function currentToolInputVersion(): number {
  const [fact] = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("tool.input.completed", {
    tool_use: { id: "probe", name: "bash", input: {}, execution: { mode: "foreground", trace_kind: "tool" }, provider_call_id: "probe", provider_tool_name: "bash", executable_tool_name: "bash" },
    model_request_id: "probe-request",
  }))
  if (!fact) throw new Error("the runtime mapper wrote no tool input fact")
  return fact.version
}

describe("release skill-load history", () => {
  test("records each load as a current tool call with its result, and leaves the tail after the snapshot unseen", async () => {
    workDir = mkdtempSync(join(tmpdir(), "flywheel-release-skill-history-"))
    const projectRoot = join(workDir, "project")
    mkdirSync(projectRoot)
    await appendSkillLoadHistory(projectRoot, workDir, {
      prefix: [{ skillId: "planning", loads: 3 }, { skillId: "testing", loads: 2 }],
      unseenTail: [{ skillId: "planning", loads: 1 }, { skillId: "shipping", loads: 2 }],
    })
    const store = createSqliteEventStore(resolveEventStoreDbFile(canonicalDirectory(projectRoot, "skill history reader")))
    try {
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      expect((await manager.read(SKILL_HISTORY_SESSION_ID))?.kind).toBe("chat")
      const inputs = store.read({ aggregateId: `session:${SKILL_HISTORY_SESSION_ID}`, types: ["tool.input.completed"] })
      expect(inputs).toHaveLength(8)
      expect(new Set(inputs.map((fact) => fact.version))).toEqual(new Set([currentToolInputVersion()]))
      const results = store.read({ aggregateId: `session:${SKILL_HISTORY_SESSION_ID}`, types: ["tool.result.recorded"] })
      expect(results.map((fact) => fact.payload.toolUseId)).toEqual(inputs.map((fact) => fact.payload.toolUseId))

      const snapshots = store.read({ aggregateId: "session:skill-pruner", types: ["skill.loads.snapshotted"] })
      expect(snapshots.map((fact) => fact.payload.stats)).toEqual([[
        expect.objectContaining({ skillId: "planning", loads: 3 }),
        expect.objectContaining({ skillId: "testing", loads: 2 }),
      ]])
      const stats = await collectSkillLoadStats(asAsyncEventReadSurface(store))
      expect(Object.fromEntries([...stats].map(([skillId, { loads }]) => [skillId, loads]))).toEqual({ planning: 4, testing: 2, shipping: 2 })
    } finally {
      store.close()
    }
  })

  test("writes no snapshot when the history has no unseen tail", async () => {
    workDir = mkdtempSync(join(tmpdir(), "flywheel-release-skill-prefix-"))
    await appendSkillLoadHistory(workDir, workDir, { prefix: [{ skillId: "planning", loads: 2 }] })
    const store = createSqliteEventStore(resolveEventStoreDbFile(canonicalDirectory(workDir, "skill prefix reader")))
    try {
      expect(store.read({ aggregateId: "session:skill-pruner", types: ["skill.loads.snapshotted"] })).toEqual([])
      expect((await collectSkillLoadStats(asAsyncEventReadSurface(store))).get("planning")?.loads).toBe(2)
    } finally {
      store.close()
    }
  })
})

describe("release performance fixture", () => {
  // The unit test writes a small workload, so this pins the size that the
  // release scenarios measure: a shrunk default would pass every other test.
  test("keeps the release workload at the size the scenarios measure", () => {
    expect(RELEASE_WORKLOAD.lightSessions).toBe(300)
    expect(2 * RELEASE_WORKLOAD.historyHeavyToolCalls).toBeGreaterThanOrEqual(30_000)
    const giant = giantTranscript()
    expect(giant).toHaveLength(4000)
    expect(giant.filter((entry) => entry.kind === "toolResult")).toHaveLength(363)
    const rich = giantTranscript(SCROLL_WORKLOAD.giantEntries, SCROLL_WORKLOAD.giantContent)
    const answers = rich.filter(entry => entry.kind === "assistant").map(entry => entry.content)
    expect(answers.some(content => typeof content === "string" && content.includes("```ts"))).toBe(true)
    expect(answers.some(content => typeof content === "string" && content.includes("| Column | Value |"))).toBe(true)
    expect(answers.some(content => typeof content === "string" && content.includes("  - nested point:"))).toBe(true)
    expect(rich.filter(entry => entry.kind === "toolResult")).not.toHaveLength(0)
  })

  test("writes the shared historical workload without dropping the giant transcript tail", async () => {
    workDir = mkdtempSync(join(tmpdir(), "flywheel-release-fixture-"))
    const probeRoot = join(workDir, "current-producer")
    mkdirSync(probeRoot)
    const probeFile = join(probeRoot, "current-producer.sqlite")
    const productionVersion = await currentWriterVersion(probeFile, "before-fixture")
    const summary = await generateFixtureWorkspace(workDir, SMALL_WORKLOAD)
    const store = createSqliteEventStore(join(workDir, ".flywheel", "flywheel.sqlite"))
    const summaryIndex = acquireSessionSummaryIndex(
      resolveSessionSummaryDbFile(canonicalDirectory(workDir, "historical fixture summary reader")),
      asAsyncEventReadSurface(store),
      { shared: false },
    )

    try {
      // Captured from the pre-D publisher on 2026-10-17, before fixture extraction.
      // This covers all 12 publications, including parent calls, links, and sequences.
      const workflowFacts = store.read({}).filter((fact) =>
        fact.sessionId.includes("-child-") || fact.type === "session.child.linked"
        || (fact.type === "tool.input.completed" && fact.payload.toolName === "workflow"))
      const publications = workflowFacts.map(({ aggregateId, sessionId, type, version, actor, payload, seq }) =>
        ({ aggregateId, sessionId, type, version, actor, payload, seq }))
      expect(workflowFacts).toHaveLength(96)
      expect(contentEvidence(canonicalPublicationJson(publications)).sha256)
        .toBe("cd2c034f29dd18f06932bedce731931fb3c14ff72ba03a4ddcb4651868d5051c")

      const summaries = await summaryIndex.readImmediate(["fixture-giant", "fixture-reconciliation-child-0"])
      expect(summaries.status).toBe("ready")
      expect([...summaries.summaries.keys()]).toEqual(["fixture-giant", "fixture-reconciliation-child-0"])
      expect(summary.lightSessions).toBe(3)
      expect(summary.giantEntries).toBe(227)
      const lightSessions = store.read({ types: ["session.created"] }).filter((fact) =>
        typeof fact.payload.name === "string" && fact.payload.name.startsWith("Fixture chat "))
      expect(lightSessions).toHaveLength(3)

      const projectRoot = canonicalDirectory(workDir, "historical fixture reader")
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      const childIds = Array.from({ length: 8 }, (_, index) => `fixture-reconciliation-child-${index}`)
      const parent = await manager.read("fixture-reconciliation-parent")
      expect(parent?.childSessionIds).toEqual(childIds)
      for (const childId of childIds) {
        const facts = store.read({ aggregateId: `session:${childId}`, types: ["session.created"] })
        expect(facts).toHaveLength(1)
        expect(facts[0]?.version).toBe(3)
        // The published state Worker has no launchedFrom.conversationId in its
        // catalog wire schema, so the shared fixture leaves the key out.
        expect(facts[0]?.payload.launchedFrom).toEqual({
          parentSessionId: "fixture-reconciliation-parent",
          workflowDefinitionId: "implement",
          toolCallId: `workflow-${childId}`,
          description: `Reconciliation child ${childIds.indexOf(childId)}`,
        })
        const child = await manager.read(childId)
        expect(child).toMatchObject({
          kind: "workflow",
          workflowDefinitionId: "implement",
          launchedFrom: {
            parentSessionId: "fixture-reconciliation-parent",
            workflowDefinitionId: "implement",
            toolUseId: `workflow-${childId}`,
          },
        })
      }

      // Every history call and every workflow launch call is on the parent.
      const heavyParentId = "fixture-history-heavy-parent"
      expect(summary.heavyParentToolFacts).toBe(2 * 1001 + 4)
      expect(store.read({ aggregateId: `session:${heavyParentId}`, types: ["tool.input.completed", "tool.result.recorded"] }))
        .toHaveLength(summary.heavyParentToolFacts)
      const heavyInputs = store.read({ aggregateId: `session:${heavyParentId}`, types: ["tool.input.completed"] })
      expect(new Set(heavyInputs.map((fact) => fact.version))).toEqual(new Set([currentToolInputVersion()]))
      const heavyChildIds = Array.from({ length: 4 }, (_, index) => `fixture-history-heavy-child-${index}`)
      expect((await manager.read(heavyParentId))?.childSessionIds).toEqual(heavyChildIds)
      for (const childId of heavyChildIds) {
        const launch = store.read({ aggregateId: `session:${heavyParentId}`, types: ["tool.input.completed"], toolUseIds: [`workflow-${childId}`] })
        expect(launch).toHaveLength(1)
      }

      const giantFacts = store.read({ aggregateId: `conversation:${GIANT_CONVERSATION_ID}` })
      const appendFacts = giantFacts.filter((fact) => fact.type === "chat.entries.appended")
      expect(appendFacts.every((fact) => fact.version === 2)).toBe(true)

      const references = appendFacts.flatMap((fact) => {
        const entries = Array.isArray(fact.payload.entries) ? fact.payload.entries : []
        return entries.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null || !("message" in entry)) return []
          const message = entry.message
          if (typeof message !== "object" || message === null || !("content" in message) || !Array.isArray(message.content)) return []
          return message.content.filter((part: unknown): part is { type: "text_reference"; sha256: string; bytes: number } =>
            typeof part === "object" && part !== null
            && "type" in part && part.type === "text_reference"
            && "sha256" in part && typeof part.sha256 === "string"
            && "bytes" in part && typeof part.bytes === "number")
        })
      })
      expect(references).toHaveLength(20)
      for (const reference of references) {
        const content = store.toolContent.resolve(GIANT_SESSION_ID, reference.sha256)
        expect(content).not.toBeNull()
        expect(contentEvidence(content ?? "")).toMatchObject({ sha256: reference.sha256, bytes: reference.bytes })
      }

      const giantTree = await tryOpenConversationTree({ conversationId: GIANT_CONVERSATION_ID, sessionId: GIANT_SESSION_ID, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      expect(giantTree).not.toBeNull()
      try {
        const state = await giantTree?.getState()
        expect(state?.degraded.length).toBe(0)
        const branch = await giantTree?.getBranch() ?? []
        expect(branch).toHaveLength(227)
        expect(branch.at(-1)).toMatchObject({ kind: "message", message: { kind: "system", content: TERMINAL_ANNOTATION } })
      } finally {
        giantTree?.getStorage().dispose()
      }

      expect(await currentWriterVersion(probeFile, "after-fixture")).toEqual(productionVersion)
    } finally {
      await summaryIndex.dispose()
      store.close()
    }
  })
})
