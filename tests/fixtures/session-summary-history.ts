import { Database } from "bun:sqlite"
import { join } from "node:path"

import type { StoredFact } from "../../src/infra/event-store-types.js"
import { configureSqliteEventStore } from "../../src/infra/sqlite-event-store-core.js"
import { resolveEventStoreDbFile } from "../../src/infra/paths.js"
import { WORKSPACE_STATE_EPOCH } from "../../src/orchestration/workspace-state-retirement.js"

export const SESSION_SUMMARY_FIXTURE_FACT_TYPES = [
  "budget.process.started",
  "budget.invocation.recorded",
  "budget.stream.completed",
  "model.context.measured",
  "model.usage.measured",
  "model.turn.completed",
  "session.duration.recorded",
  "file.changed",
  "session.created",
  "session.child.linked",
] as const

export interface SessionSummaryFixtureDimensions {
  readonly relevantFacts: number
  readonly semanticUsageIds: number
  readonly sessions: number
}

const FIXTURE_SESSION_COUNT = 633

/** The kind the fixture gives each session: a chat root, then one workflow in
 *  ten, one chat in eleven, and a subagent child everywhere else. */
export function fixtureSessionKind(index: number): "chat" | "workflow" | "subagent" {
  if (index === 0) return "chat"
  return index % 10 === 0 ? "workflow" : index % 11 === 0 ? "chat" : "subagent"
}

/** The session each fixture session launches from. Every other workflow
 *  launches from the root chat, and the ownership migration keeps that
 *  parent. The other workflows launch inside the subagent tree like any other
 *  child. When that parent is not a chat, the migration adopts the workflow
 *  into a new chat, so the summary replay applies a second ancestry edge after
 *  the workflow's usage. */
function fixtureParentIndex(index: number): number {
  return fixtureSessionKind(index) === "workflow" && index % 20 === 10 ? 0 : Math.floor((index - 1) / 2)
}

const FIXTURE_SESSIONS = Array.from({ length: FIXTURE_SESSION_COUNT }, (_, index) => index)
const FIXTURE_WORKFLOWS = FIXTURE_SESSIONS.filter((index) => fixtureSessionKind(index) === "workflow")
const FIXTURE_ADOPTING_CHATS = FIXTURE_WORKFLOWS.filter((index) => fixtureSessionKind(fixtureParentIndex(index)) !== "chat").length

export const LARGE_SESSION_SUMMARY_HISTORY = {
  relevantFacts: 530_000,
  semanticUsageIds: 59_000,
  sessions: FIXTURE_SESSION_COUNT,
  /** The fixture's chats plus the chats that the migration creates to adopt
   *  workflows whose launch parent is not a chat. */
  listedSessions: FIXTURE_SESSIONS.filter((index) => fixtureSessionKind(index) === "chat").length + FIXTURE_ADOPTING_CHATS,
  workflows: FIXTURE_WORKFLOWS.length,
  adoptingChats: FIXTURE_ADOPTING_CHATS,
  createFacts(): Iterable<StoredFact> {
    return generateLargeSessionSummaryHistory()
  },
} as const

/** Materialize the lazy large-history generator as one real workspace event
 * store. The returned dimensions come from inserted rows, not manifest
 * constants, so the performance scenario can refuse a partial fixture before
 * it starts any clock. */
export function createSessionSummaryHistoryFixture(projectRoot: string): SessionSummaryFixtureDimensions {
  const dbFile = resolveEventStoreDbFile(projectRoot)
  const db = new Database(dbFile, { create: true })
  let relevantFacts = 0
  const semanticUsageIds = new Set<string>()
  const sessions = new Set<string>()
  try {
    configureSqliteEventStore(db)
    const putSequence = db.query("insert or ignore into event_sequence (aggregate_id, seq) values (?, ?)")
    for (let index = 0; index < LARGE_SESSION_SUMMARY_HISTORY.sessions; index++) {
      const sessionId = `session-${index}`
      putSequence.run(`session:${sessionId}`, LARGE_SESSION_SUMMARY_HISTORY.relevantFacts)
      putSequence.run(`conversation:conversation-${sessionId}`, 1)
    }
    const insert = db.query(`
      insert into event (
        position, id, aggregate_id, seq, type, version, timestamp, actor,
        session_id, run_id, parent_event_id, caused_by_event_id, payload
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?)
    `)
    db.transaction(() => {
      for (const fact of LARGE_SESSION_SUMMARY_HISTORY.createFacts()) {
        insert.run(
          fact.position,
          fact.id,
          fact.aggregateId,
          fact.seq,
          fact.type,
          fact.version,
          fact.timestamp,
          fact.actor,
          fact.sessionId,
          JSON.stringify(fact.payload),
        )
        relevantFacts++
        sessions.add(fact.sessionId)
        const semanticId = fact.version === 5 ? fact.payload.attemptId : fact.payload.usageEntryId
        if (fact.type === "model.usage.measured" && typeof semanticId === "string") semanticUsageIds.add(semanticId)
      }
      let position = relevantFacts + 1
      for (let index = 0; index < LARGE_SESSION_SUMMARY_HISTORY.sessions; index++) {
        const sessionId = `session-${index}`
        const conversationId = `conversation-${sessionId}`
        insert.run(
          position, `search-tree-${index}`, `conversation:${conversationId}`, 0,
          "chat.tree.created", 1, position, "flywheel", sessionId,
          JSON.stringify({ conversationId, createdAt: "2026-01-01T00:00:00.000Z" }),
        )
        position++
        insert.run(
          position,
          `search-fact-${index}`,
          `conversation:${conversationId}`,
          1,
          "chat.entries.appended",
          1,
          position,
          "flywheel",
          sessionId,
          JSON.stringify({
            conversationId,
            entries: [{
              kind: "message",
              id: `search-entry-${index}`,
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { kind: "user", content: `summary fixture searchable marker ${index}` },
            }],
          }),
        )
        position++
      }
      db.exec(`pragma user_version = ${WORKSPACE_STATE_EPOCH}`)
    }).immediate()
  } finally {
    db.close()
  }
  return { relevantFacts, semanticUsageIds: semanticUsageIds.size, sessions: sessions.size }
}

/** Create an explicit stale summary watermark immediately before a cold
 * rebuild request. */
export function createStaleSessionSummaryIndex(projectRoot: string): void {
  const db = new Database(join(projectRoot, ".flywheel", "session-summary.sqlite"), { create: true })
  try {
    db.exec(`
      pragma user_version = 3;
      create table session_summary_watermark (position integer not null);
      insert into session_summary_watermark values (0);
    `)
  } finally {
    db.close()
  }
}

export function sessionSummaryFact(
  position: number,
  sessionId: string,
  type: string,
  version: number,
  payload: Record<string, unknown>,
): StoredFact {
  return {
    aggregateId: `session:${sessionId}`,
    sessionId,
    type,
    version,
    actor: type.startsWith("model.") ? "provider" : "flywheel",
    timestamp: position,
    payload,
    position,
    id: `fact-${position}`,
    seq: position - 1,
  }
}

export function createdFact(position: number, sessionId: string, kind: "chat" | "workflow" | "subagent", parentSessionId?: string): StoredFact {
  return sessionSummaryFact(position, sessionId, "session.created", 1, {
    kind,
    command: kind,
    ...(kind === "workflow" ? { workflowDefinitionId: "fixture-workflow" } : { conversationId: `conversation-${sessionId}` }),
    label: sessionId,
    lastUpdated: "2026-01-01T00:00:00.000Z",
    lifecycleState: "inactive",
    ...(parentSessionId ? { launchedFrom: { parentSessionId, toolUseId: `tool-${sessionId}` } } : {}),
  })
}

/** The creation of a workflow agent `sessionId` that `workflowId` launched
 *  from `parentSessionId`, as one attempt of the workflow. */
export function memberCreated(sessionId: string, workflowId: string, parentSessionId: string): StoredFact {
  const fact = createdFact(0, sessionId, "subagent", parentSessionId)
  return {
    ...fact,
    version: 6,
    payload: {
      label: sessionId,
      lastUpdated: "2026-01-01T00:00:00.000Z",
      lifecycleState: "inactive",
      createdAt: "2026-01-01T00:00:00.000Z",
      launchedFrom: { parentSessionId, conversationId: `conversation-${parentSessionId}`, toolUseId: `tool-${sessionId}` },
      conversationId: `agent-${sessionId}`,
      kind: "workflow-agent",
      command: "workflow-agent",
      workflowMembership: { kind: "attempt", workflowId, attemptId: `attempt-${sessionId}` },
      importedResources: { workflowId, conversationId: `agent-${sessionId}` },
    },
  }
}

export function linkedFact(position: number, parentSessionId: string, childSessionId: string): StoredFact {
  return sessionSummaryFact(position, parentSessionId, "session.child.linked", 1, {
    childSessionId,
    lastUpdated: "2026-01-01T00:00:00.000Z",
  })
}

export function usageV4Fact(position: number, sessionId: string, semanticId: string, cost = 2): StoredFact {
  return sessionSummaryFact(position, sessionId, "model.usage.measured", 4, {
    usageEntryId: semanticId,
    costUsdDelta: cost,
    billedCostUsdDelta: cost,
    inputTokensDelta: 100,
    outputTokensDelta: 10,
    cacheReadTokensDelta: 0,
    cacheCreateTokensDelta: 0,
    reasoningTokensDelta: 0,
    budgetStreamId: `stream-${semanticId}`,
  })
}

export function usageV5Fact(position: number, sessionId: string, sequence: number, cost = 3): StoredFact {
  const hex = sequence.toString(16).padStart(12, "0")
  const attemptId = `00000000-0000-4000-8000-${hex}`
  return sessionSummaryFact(position, sessionId, "model.usage.measured", 5, {
    attemptId,
    occurredAt: "2026-01-01T00:00:00.000Z",
    profileId: "profile",
    attribution: { kind: "candidate", providerId: "provider", instanceId: "instance" },
    spendMode: "direct_api",
    credentialLineage: "00000000-0000-4000-8000-000000000001",
    model: "model",
    tokens: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    classification: "real_spend",
    price: { kind: "priced", estimatedUsd: cost, rateCard: {}, provenance: "fixture" },
    currency: "USD",
    budgetStreamId: `stream-${attemptId}`,
  })
}

export function usageCumulativeFact(position: number, sessionId: string, version: 1 | 2 | 3, cost: number): StoredFact {
  return sessionSummaryFact(position, sessionId, "model.usage.measured", version, {
    totalCostUsd: cost,
    billedCostUsd: cost,
    inputTokens: cost * 10,
    outputTokens: cost,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    reasoningTokens: 0,
    ...(version === 3 ? { budgetStreamId: "legacy-stream" } : {}),
  })
}

function* generateLargeSessionSummaryHistory(): Generator<StoredFact> {
  let position = 1
  yield createdFact(position++, "session-0", "chat")
  for (let index = 1; index < LARGE_SESSION_SUMMARY_HISTORY.sessions; index++) {
    const sessionId = `session-${index}`
    const kind = fixtureSessionKind(index)
    const parentId = `session-${fixtureParentIndex(index)}`
    const semanticIndex = index - 1
    yield linkedFact(position++, parentId, sessionId)
    yield semanticIndex % 2 === 0
      ? usageV4Fact(position++, sessionId, `usage-${semanticIndex}`, 1)
      : usageV5Fact(position++, sessionId, semanticIndex, 1)
    yield createdFact(position++, sessionId, kind, parentId)
  }
  for (let index = LARGE_SESSION_SUMMARY_HISTORY.sessions - 1; index < LARGE_SESSION_SUMMARY_HISTORY.semanticUsageIds; index++) {
    yield index % 2 === 0
      ? usageV4Fact(position++, `session-${index % LARGE_SESSION_SUMMARY_HISTORY.sessions}`, `usage-${index}`, 1)
      : usageV5Fact(position++, `session-${index % LARGE_SESSION_SUMMARY_HISTORY.sessions}`, index, 1)
  }
  for (let index = 0; index < LARGE_SESSION_SUMMARY_HISTORY.semanticUsageIds; index++) {
    yield index % 2 === 0
      ? usageV4Fact(position++, `session-${index % LARGE_SESSION_SUMMARY_HISTORY.sessions}`, `usage-${index}`, 1)
      : usageV5Fact(position++, `session-${index % LARGE_SESSION_SUMMARY_HISTORY.sessions}`, index, 1)
  }
  while (position <= LARGE_SESSION_SUMMARY_HISTORY.relevantFacts - 2) {
    const sessionId = `session-${position % LARGE_SESSION_SUMMARY_HISTORY.sessions}`
    yield summaryFillerFact(position, sessionId)
    position++
  }
  yield linkedFact(position++, "session-0", "session-1")
  yield createdFact(position, `session-${LARGE_SESSION_SUMMARY_HISTORY.sessions - 1}`, "subagent", "session-315")
}

function summaryFillerFact(position: number, sessionId: string): StoredFact {
  switch (position % 7) {
    case 0:
      return sessionSummaryFact(position, sessionId, "budget.process.started", 1, {})
    case 1:
      return sessionSummaryFact(position, sessionId, "budget.invocation.recorded", 1, { count: 1 })
    case 2:
      return sessionSummaryFact(position, sessionId, "budget.stream.completed", 2, { budgetStreamId: `fixture-stream-${sessionId}` })
    case 3:
      return sessionSummaryFact(position, sessionId, "model.context.measured", 1, {
        promptTokens: position % 1_000,
        contextWindow: 1_000,
      })
    case 4:
      return sessionSummaryFact(position, sessionId, "model.turn.completed", 1, {
        isError: false,
        totalCostUsd: 0,
        billedCostUsd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    case 5:
      return sessionSummaryFact(position, sessionId, "session.duration.recorded", 1, {
        accumulatedActiveMs: position % 100_000,
      })
    default:
      return sessionSummaryFact(position, sessionId, "file.changed", 1, {
        path: `${sessionId}.ts`,
        displayPath: `${sessionId}.ts`,
        changeKind: "modified",
        before: null,
        after: null,
        lineStats: { added: 1, modified: 1, removed: 1 },
      })
  }
}
