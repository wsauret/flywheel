import { Database } from "bun:sqlite"
import { describe, expect, test, afterEach } from "bun:test"
import { dbFile, readyBudget, sourceFor, removeIndexDirectories } from "./_summary-index-fixtures.js"
import { asAsyncEventReadSurface, CorruptEventRowError, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { acquireSessionSummaryIndex } from "../../../../src/orchestration/session/session-summary-index.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { readWorkflowUsage } from "../../../../src/orchestration/workflow-host/member-totals.js"
import {
  createdFact,
  linkedFact,
  sessionSummaryFact,
  usageCumulativeFact,
  usageV4Fact,
  usageV5Fact,
} from "../../../fixtures/session-summary-history.js"

afterEach(removeIndexDirectories)

/** One session's descendant totals as the ancestry queries select them. */
interface DescendantTotalsRow {
  readonly session_id: string
  readonly cost: number
  readonly billed: number
  readonly unavailable: number
  readonly input: number
  readonly output: number
}

function corruptRow(position: number, sessionId: string, type: string): CorruptEventRowError {
  return new CorruptEventRowError({
    aggregateId: `session:${sessionId}`, seq: position - 1, type, version: 1, timestamp: position,
    actor: type.startsWith("model.") ? "provider" : "flywheel", sessionId, eventId: `corrupt-${position}`, position, rawPayload: "{",
  }, "invalid JSON")
}

/** The ownership adoption fact on the workflow. Every producer appends it
 *  with a `session.child.linked` fact on the adopter in the same batch. */
function adoptedFact(position: number, workflowId: string, parentId: string, version = 1): StoredFact {
  return sessionSummaryFact(position, workflowId, "session.ownership.adopted", version, {
    parentSessionId: parentId, parentConversationId: `${parentId}-conversation`, toolUseId: `adopt-${workflowId}`, lastUpdated: "2026-01-01T00:00:00.000Z",
  })
}

describe("session summary ancestry", () => {
  test("counts direct member, nested child, and aggregate auxiliary usage once under the launching chat", async () => {
    const registered = sessionSummaryFact(2, "run", "workflow.run.registered", 1, {
      settings: { workflowDefinitionId: "demo", label: "Run", createdAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", roleAssignments: { defaults: {}, overrides: {} }, historicalResidualAggregateId: "session:run" },
      request: "Work", launchedFrom: { parentSessionId: "root", conversationId: "root-conversation", toolUseId: "launch" },
    })
    const member = sessionSummaryFact(3, "member", "session.created", 6, {
      kind: "workflow-agent", command: "workflow-agent", label: "Member", lifecycleState: "active",
      conversationId: "member-conversation", lastUpdated: "2026-01-01T00:00:00.000Z",
      launchedFrom: { parentSessionId: "root", toolUseId: "launch" },
      workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "a" },
    })
    const facts = [
      createdFact(1, "root", "chat"),
      { ...registered, aggregateId: "workflow:run" },
      member,
      linkedFact(4, "root", "member"),
      createdFact(5, "nested", "subagent", "member"),
      linkedFact(6, "member", "nested"),
      usageV4Fact(7, "member", "member-request", 3),
      usageV4Fact(8, "nested", "nested-request", 5),
      { ...usageV4Fact(9, "run", "review-request", 7), aggregateId: "workflow:run" },
      { ...usageV4Fact(10, "run", "review-request", 7), aggregateId: "workflow:run" },
      usageV4Fact(11, "run", "historical-residual-request", 11),
      sessionSummaryFact(12, "run", "session.representation.retired", 1, { migrationId: "workflow-agent-session-ownership", aggregateId: "workflow:run", recovery: [] }),
    ]
    const summary = await readyBudget(dbFile(), facts, "root")
    expect(summary?.budget?.totalCost).toBe(26)
    const store = createSqliteEventStore(dbFile())
    try {
      store.appendBatch(facts)
      const usage = await readWorkflowUsage(asAsyncEventReadSurface(store), "run")
      expect(usage.policy.totalCost).toBe(21)
      expect(usage.display.totalCost).toBe(26)
    } finally { store.close() }
  })

  test("counts previous-shape cumulative usage streams of a workflow aggregate and a subagent once under the launching chat", async () => {
    const registered = sessionSummaryFact(2, "run", "workflow.run.registered", 1, {
      settings: { workflowDefinitionId: "demo", label: "Run", createdAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", roleAssignments: { defaults: {}, overrides: {} } },
      request: "Work", launchedFrom: { parentSessionId: "root", conversationId: "root-conversation", toolUseId: "launch" },
    })
    const onRun = (fact: StoredFact): StoredFact => ({ ...fact, aggregateId: "workflow:run" })
    const facts = [
      createdFact(1, "root", "chat"),
      onRun(registered),
      createdFact(3, "agent", "subagent", "root"),
      linkedFact(4, "root", "agent"),
      onRun(usageCumulativeFact(5, "run", 3, 1)),
      onRun(usageCumulativeFact(6, "run", 3, 3)),
      usageCumulativeFact(7, "agent", 3, 2),
      usageCumulativeFact(8, "agent", 3, 5),
      usageCumulativeFact(9, "root", 3, 2),
    ]
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor(facts).source)
    try {
      await index.replay()
      const { summaries } = await index.readImmediate(["root", "workflow:run", "agent"])
      expect(summaries.get("workflow:run")?.budget).toMatchObject({ totalCost: 3, totalTokens: 33 })
      expect(summaries.get("agent")?.budget).toMatchObject({ totalCost: 5, totalTokens: 55 })
      expect(summaries.get("root")?.budget).toMatchObject({ totalCost: 10, totalTokens: 110 })
    } finally {
      await index.dispose()
    }
  })

  test("counts a descendant's terminal-only cumulative usage once under its parent", async () => {
    const facts = [
      createdFact(1, "root", "chat"),
      createdFact(2, "child", "subagent", "root"),
      linkedFact(3, "root", "child"),
      sessionSummaryFact(4, "child", "model.turn.completed", 1, {
        isError: false, totalCostUsd: 2, billedCostUsd: 2, usage: { input_tokens: 20, output_tokens: 2 },
      }),
      sessionSummaryFact(5, "child", "model.turn.completed", 1, {
        isError: false, totalCostUsd: 5, billedCostUsd: 5, usage: { input_tokens: 50, output_tokens: 5 },
      }),
    ]
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor(facts).source)
    try {
      await index.replay()
      const { summaries } = await index.readImmediate(["root", "child"])
      expect(summaries.get("child")?.budget).toMatchObject({ totalCost: 5, totalTokens: 55 })
      expect(summaries.get("root")?.budget).toMatchObject({ totalCost: 5, totalTokens: 55 })
    } finally {
      await index.dispose()
    }
  })

  test("keeps a descendant's v5 usage unchanged by its same-stream terminal reconciliation", async () => {
    const facts = [
      createdFact(1, "root", "chat"),
      createdFact(2, "child", "subagent", "root"),
      linkedFact(3, "root", "child"),
      usageV5Fact(4, "child", 1, 3),
      sessionSummaryFact(5, "child", "model.turn.completed", 1, {
        isError: false, totalCostUsd: 3, billedCostUsd: 3, usage: { input_tokens: 20, output_tokens: 5 },
      }),
    ]
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor(facts).source)
    try {
      await index.replay()
      const { summaries } = await index.readImmediate(["root", "child"])
      expect(summaries.get("child")?.budget).toMatchObject({ totalCost: 3, totalTokens: 25 })
      expect(summaries.get("root")?.budget).toMatchObject({ totalCost: 3, totalTokens: 25 })
    } finally {
      await index.dispose()
    }
  })

  test("propagates a descendant's malformed generic budget payload instead of reporting a partial total", async () => {
    const facts = [
      createdFact(1, "root", "chat"),
      createdFact(2, "child", "subagent", "root"),
      linkedFact(3, "root", "child"),
      usageV4Fact(4, "root", "root-usage", 2),
      sessionSummaryFact(5, "child", "model.usage.measured", 3, {}),
    ]
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor(facts).source)
    try {
      await index.replay()
      const { summaries } = await index.readImmediate(["root", "child"])
      expect(summaries.get("child")?.errors.budget).toBeDefined()
      expect(summaries.get("child")?.budget).toBeUndefined()
      expect(summaries.get("root")?.errors.descendants).toBeDefined()
      expect(summaries.get("root")?.budget).toBeUndefined()
    } finally {
      await index.dispose()
    }
  })

  test("preserves mixed V1-V5 local reducer state and materializes nested subagent totals once", async () => {
    const facts = [
      createdFact(1, "root", "chat"),
      linkedFact(2, "root", "middle"),
      usageV4Fact(3, "leaf", "leaf-v4", 4),
      usageV5Fact(4, "leaf", 1, 5),
      linkedFact(5, "middle", "leaf"),
      createdFact(6, "leaf", "subagent", "middle"),
      createdFact(7, "middle", "subagent", "root"),
      usageV4Fact(8, "leaf", "leaf-v4", 4),
      usageCumulativeFact(9, "root", 1, 1),
      usageCumulativeFact(10, "root", 2, 2),
      usageCumulativeFact(11, "root", 3, 3),
      usageV4Fact(12, "root", "root-v4", 4),
      usageV5Fact(13, "root", 2, 5),
      sessionSummaryFact(14, "root", "model.context.measured", 1, { promptTokens: 250, contextWindow: 1_000 }),
      sessionSummaryFact(15, "root", "session.duration.recorded", 1, { accumulatedActiveMs: 4_000 }),
      sessionSummaryFact(16, "root", "file.changed", 1, { path: "x.ts", displayPath: "x.ts", changeKind: "modified", before: null, after: null, toolUseId: "tool", lineStats: { added: 3, modified: 2, removed: 1 } }),
    ]
    const file = dbFile()
    const index = acquireSessionSummaryIndex(file, sourceFor(facts, 3).source)
    try {
      expect(await index.readImmediate(["root"])).toEqual({ status: "loading", throughPosition: 0, summaries: new Map() })
      await index.replay()
      const result = await index.readImmediate(["root"])
      expect(result.status).toBe("ready")
      expect(result.summaries.get("root")).toMatchObject({
        budget: { totalCost: 23, totalTokens: 325, contextPromptTokens: 250, contextPercent: 25 },
        duration: { accumulatedActiveMs: 4_000 },
        diffStats: { added: 3, modified: 2, removed: 1 },
      })
    } finally {
      await index.dispose()
    }
  })

  test("admits workflow and subagent ancestry and ignores duplicate, unlink, and deletion history", async () => {
    const facts = [
      createdFact(1, "root", "chat"),
      usageV4Fact(2, "late", "late", 2),
      linkedFact(3, "root", "late"),
      linkedFact(4, "root", "late"),
      createdFact(5, "late", "subagent", "root"),
      usageV4Fact(6, "workflow", "workflow", 7),
      createdFact(7, "workflow", "workflow", "root"),
      linkedFact(8, "root", "workflow"),
      usageV4Fact(9, "chat", "chat", 11),
      createdFact(10, "chat", "chat", "root"),
      linkedFact(11, "root", "chat"),
      sessionSummaryFact(12, "root", "session.child.unlinked", 1, { childSessionId: "late", lastUpdated: "2026-01-01T00:00:00.000Z" }),
      sessionSummaryFact(13, "late", "session.deleted", 1, { lastUpdated: "2026-01-01T00:00:00.000Z" }),
    ]
    expect((await readyBudget(dbFile(), facts, "root"))?.budget?.totalCost).toBe(9)
  })

  test("deduplicates late adoption paths and subsequent requests across reopen and rebuild", async () => {
    const unavailable = usageV5Fact(6, "leaf", 99, 0)
    const history = sourceFor([
      createdFact(1, "root", "chat"),
      createdFact(2, "workflow", "workflow", "root"),
      createdFact(3, "agent", "subagent", "root"),
      createdFact(4, "leaf", "subagent", "workflow"),
      usageV4Fact(5, "leaf", "first", 7),
      { ...unavailable, payload: { ...unavailable.payload, price: { kind: "unavailable", reason: "No rate" } } },
      adoptedFact(7, "workflow", "agent"),
      linkedFact(8, "agent", "workflow"),
      usageV4Fact(9, "leaf", "second", 3),
    ])
    const file = dbFile()
    for (let pass = 0; pass < 3; pass++) {
      if (pass === 2) {
        // An index of an earlier generation (3 or 4) holds totals that an
        // earlier build counted by its own rules, here one request counted
        // twice. A start that finds another generation discards the index and
        // folds the facts again.
        const db = new Database(file)
        db.exec("update session_summary_descendant set total_cost = total_cost * 2; pragma user_version = 4")
        db.close()
      }
      const index = acquireSessionSummaryIndex(file, history.source)
      try {
        await index.replay()
        const result = await index.readImmediate(["root", "workflow", "agent"])
        for (const id of ["root", "workflow", "agent"]) expect(result.summaries.get(id)?.budget).toMatchObject({ totalCost: 10, priceUnavailable: true })
      } finally { await index.dispose() }
    }
  })

  test("keeps incremental descendant totals equal to a full recompute across levels, late children, and a second parent", async () => {
    const facts = [
      createdFact(1, "root", "chat"),
      createdFact(2, "a", "subagent", "root"),
      usageV4Fact(3, "a", "a", 1),
      createdFact(4, "b", "subagent", "a"),
      usageV4Fact(5, "b", "b", 2),
      // A subtree that has usage before it joins the tree: the edge to x
      // arrives before x's kind, so x becomes counted on its creation.
      usageV4Fact(6, "y", "y", 4),
      linkedFact(7, "x", "y"),
      createdFact(8, "y", "subagent", "x"),
      usageV4Fact(9, "x", "x", 8),
      linkedFact(10, "b", "x"),
      createdFact(11, "x", "subagent", "b"),
      createdFact(12, "c", "workflow", "b"),
      usageV4Fact(13, "c", "c", 16),
      createdFact(14, "d", "subagent", "c"),
      usageV4Fact(15, "d", "d-1", 32),
      createdFact(16, "e", "chat", "a"),
      usageV4Fact(17, "e", "e", 64),
      // Two more parents for c: a new adopter, and a, which already reaches
      // c through b. Neither may count c's subtree twice.
      createdFact(18, "adopter", "chat"),
      linkedFact(19, "adopter", "c"),
      linkedFact(20, "a", "c"),
      usageV4Fact(21, "d", "d-2", 128),
      usageV4Fact(22, "y", "y-2", 256),
      usageV4Fact(23, "f", "f", 512),
      createdFact(24, "f", "subagent", "d"),
    ]
    const file = dbFile()
    expect((await readyBudget(file, facts, "root"))?.budget?.totalCost).toBe(959)
    const db = new Database(file, { readonly: true })
    try {
      const stored = db.query<DescendantTotalsRow, []>(`
        with sessions(session_id) as (select session_id from session_summary_kind union select parent_id from session_summary_edge)
        select sessions.session_id, coalesce(total_cost, 0) cost, coalesce(total_billed_cost, 0) billed, coalesce(price_unavailable, 0) unavailable,
          coalesce(input_tokens, 0) input, coalesce(output_tokens, 0) output
        from sessions left join session_summary_descendant using (session_id) order by sessions.session_id`).all()
      const rebuilt = db.query<DescendantTotalsRow, []>(`
        with recursive sessions(session_id) as (select session_id from session_summary_kind union select parent_id from session_summary_edge),
        counted(ancestor_id, session_id) as (
          select edge.parent_id, edge.child_id from session_summary_edge edge
          join session_summary_kind kind on kind.session_id = edge.child_id and kind.kind in ('subagent', 'workflow')
          union
          select counted.ancestor_id, edge.child_id from counted
          join session_summary_edge edge on edge.parent_id = counted.session_id
          join session_summary_kind kind on kind.session_id = edge.child_id and kind.kind in ('subagent', 'workflow')
        ),
        totals as (
          select ancestor_id session_id, sum(total_cost) total_cost, sum(total_billed_cost) total_billed_cost, max(price_unavailable) price_unavailable,
            sum(input_tokens) input_tokens, sum(output_tokens) output_tokens
          from counted join session_summary_direct using (session_id) group by ancestor_id
        )
        select sessions.session_id, coalesce(total_cost, 0) cost, coalesce(total_billed_cost, 0) billed, coalesce(price_unavailable, 0) unavailable,
          coalesce(input_tokens, 0) input, coalesce(output_tokens, 0) output
        from sessions left join totals using (session_id) order by sessions.session_id`).all()
      expect(stored.map((row) => row.session_id)).toEqual(["a", "adopter", "b", "c", "d", "e", "f", "root", "x", "y"])
      expect(stored).toEqual(rebuilt)
      expect(stored.find((row) => row.session_id === "adopter")?.cost).toBe(16 + 160 + 512)
    } finally {
      db.close()
    }
  })

  test("takes adoption ancestry only from the co-published link", async () => {
    const facts = [
      createdFact(1, "root", "chat"),
      createdFact(2, "workflow", "workflow", "root"),
      usageV4Fact(3, "workflow", "first", 2),
      corruptRow(4, "workflow", "session.ownership.adopted"),
      adoptedFact(5, "workflow", "adopter", 2),
      createdFact(6, "adopter", "chat"),
      linkedFact(7, "adopter", "workflow"),
      usageV4Fact(8, "workflow", "second", 3),
    ]
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor(facts).source)
    try {
      await index.replay()
      const result = await index.readImmediate(["root", "workflow", "adopter"])
      for (const id of ["root", "workflow", "adopter"]) {
        expect(result.summaries.get(id)?.errors).toEqual({})
        expect(result.summaries.get(id)?.budget?.totalCost).toBe(5)
      }
    } finally {
      await index.dispose()
    }
  })

  test("counts E7 mixed descendant inputs while keeping root context local", async () => {
    const facts = [
      createdFact(1, "root", "chat"),
      createdFact(2, "workflow", "workflow", "root"),
      createdFact(3, "agent", "subagent", "workflow"),
      createdFact(4, "sibling", "subagent", "root"),
      ...([["workflow", 20], ["agent", 3], ["sibling", 5]] as const).map(([id, input], i) => {
        const fact = usageV4Fact(5 + i, id, `usage-${i}`)
        return { ...fact, payload: { ...fact.payload, inputTokensDelta: input, outputTokensDelta: 0 } }
      }),
      sessionSummaryFact(8, "root", "model.context.measured", 1, { promptTokens: 9, contextWindow: 100 }),
    ]
    const result = await readyBudget(dbFile(), facts, "root")
    expect(result?.budget).toMatchObject({ totalTokens: 28, contextPromptTokens: 9, contextPercent: 9 })
  })

  test("propagates an earlier malformed usage error after late kind and edge metadata", async () => {
    const malformed = sessionSummaryFact(1, "child", "model.usage.measured", 4, {})
    const facts = [malformed, createdFact(2, "child", "workflow", "root"), linkedFact(3, "root", "child"), createdFact(4, "root", "chat"),
      adoptedFact(5, "child", "adopter"), linkedFact(6, "adopter", "child"),
    ]
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor(facts).source)
    try {
      await index.replay()
      const result = await index.readImmediate(["root", "child", "adopter"])
      expect(result.summaries.get("child")?.errors.descendants).toBeDefined()
      expect(result.summaries.get("root")?.errors.descendants).toBeDefined()
      expect(result.summaries.get("adopter")?.errors.descendants).toBeDefined()
      expect(result.summaries.get("root")?.budget).toBeUndefined()
    } finally {
      await index.dispose()
    }
  })

  test("marks every ancestor unknown when a descendant's ancestry is unreadable", async () => {
    const intermediate = (unreadable: StoredFact | CorruptEventRowError) => [
      createdFact(1, "root", "chat"),
      createdFact(2, "workflow", "workflow", "root"),
      usageV4Fact(3, "workflow", "first", 2),
      unreadable,
      usageV4Fact(5, "workflow", "second", 3),
    ]
    const linkedChild = (unreadable: StoredFact | CorruptEventRowError) => [
      createdFact(1, "root", "chat"),
      unreadable,
      linkedFact(3, "root", "child"),
      usageV4Fact(4, "child", "first", 2),
    ]
    for (const facts of [
      intermediate(sessionSummaryFact(4, "workflow", "session.child.linked", 1, {})),
      intermediate(corruptRow(4, "workflow", "session.child.linked")),
      linkedChild(sessionSummaryFact(2, "child", "session.created", 1, {})),
      linkedChild(corruptRow(2, "child", "session.created")),
    ]) {
      const root = await readyBudget(dbFile(), facts, "root")
      expect(root?.errors.descendants).toBeDefined()
      expect(root?.budget).toBeUndefined()
    }
  })

  test("records corruption by scope, advances, and propagates descendant budget failure", async () => {
    const facts = [
      createdFact(1, "root", "chat"),
      createdFact(2, "child", "subagent", "root"),
      corruptRow(3, "child", "model.usage.measured"),
      sessionSummaryFact(4, "child", "session.duration.recorded", 1, { accumulatedActiveMs: 9 }),
    ]
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor(facts).source)
    try {
      await index.replay()
      const result = await index.readImmediate(["root", "child"])
      expect(result.throughPosition).toBe(4)
      expect(result.summaries.get("root")?.budget).toBeUndefined()
      expect(result.summaries.get("root")?.errors.descendants).toContain("invalid JSON")
      expect(result.summaries.get("child")?.budget).toBeUndefined()
      expect(result.summaries.get("child")?.duration?.accumulatedActiveMs).toBe(9)
    } finally {
      await index.dispose()
    }
  })

  test("uses the child-leading edge index for ancestor propagation", async () => {
    const file = dbFile()
    await readyBudget(file, [createdFact(1, "root", "chat"), createdFact(2, "child", "subagent", "root")], "root")
    const db = new Database(file, { readonly: true })
    try {
      const plan = db.query<{ detail: string }, []>("explain query plan select parent_id from session_summary_edge where child_id = 'child'").all()
      expect(plan.some((row) => row.detail.includes("session_summary_edge_child_idx"))).toBe(true)
    } finally {
      db.close()
    }
  })
})
