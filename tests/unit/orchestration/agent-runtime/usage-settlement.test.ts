import { describe, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createUsageAuthority, UsageEntryConflictError } from "../../../../src/infra/llm/usage-authority.js"
import type { MeasuredUsageEntry, UsageEntry } from "../../../../src/infra/llm/usage-entry.js"
import { Log } from "../../../../src/infra/log.js"
import {
  createSessionUsageSettlement,
  createUsageSettlement,
  recoverSessionUsageSettlements,
  type UsageSettlementDraft,
  type UsageSettlementRetirement,
} from "../../../../src/orchestration/agent-runtime/usage-settlement.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { loadProviderRequestAuditFromEvents } from "../../../../src/orchestration/session/provider-request-audit-projection.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

const entry: MeasuredUsageEntry = {
  attemptId: "00000000-0000-4000-8000-000000000001",
  occurredAt: "2025-01-15T12:00:00.000Z",
  profileId: "profile-a",
  currency: "USD", coverage: "complete",
  attribution: { kind: "candidate", providerId: "anthropic_api" },
  spendMode: "direct_api",
  credentialLineage: "00000000-0000-4000-8000-000000000002",
  model: "claude-sonnet-4",
  tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 0 },
  classification: "real_spend",
  price: { kind: "priced", estimatedUsd: 0.25, rateCard: { inputPerMillionUsd: 3 }, provenance: "live" },
}

const unmeasuredEntry: UsageEntry = (() => {
  const { tokens: _tokens, price: _price, currency: _currency, ...attempt } = entry
  return { ...attempt, coverage: "unmeasured" }
})()

const draft: UsageSettlementDraft = {
  entry,
  budgetStreamId: "budget-stream-1",
  requestId: "request-1",
  identity: { providerSessionKey: "provider-session-1", conversationId: "conversation-1" },
  turn: 2,
  workflowAttemptId: "step-1",
  parentToolUseId: "tool-1",
}

const unmeasuredDraft: UsageSettlementDraft = { ...draft, entry: unmeasuredEntry }

function harness(options: {
  checkpointError?: Error
  append?: () => { readonly kind: "appended" | "duplicate" }
  publish?: (draft: UsageSettlementDraft, retirement: UsageSettlementRetirement) => Promise<{ readonly kind: "published" | "duplicate" }>
} = {}) {
  const calls: string[] = []
  const opened: string[] = []
  const checkpoints: Array<{ kind: string; key: string; payload: unknown }> = []
  const authority = {
    append: () => {
      calls.push("append")
      return options.append?.() ?? { kind: "appended" as const }
    },
    dispose: () => { calls.push("dispose") },
  }
  const settlement = createUsageSettlement({
    putInFlight: async (kind, key, payload) => {
      calls.push("checkpoint")
      checkpoints.push({ kind, key, payload })
      if (options.checkpointError) throw options.checkpointError
    },
    retire: async (retirement) => { calls.push(`retire:${retirement.op}`) },
    openAuthority: (profileId) => {
      calls.push("open")
      opened.push(profileId)
      return authority
    },
    publish: options.publish ?? (async (_draft, retirement) => {
      calls.push(`publish:${retirement.op}`)
      return { kind: "published" as const }
    }),
  })
  return { settlement, calls, opened, checkpoints }
}

describe("usage settlement", () => {
  test.each(["recovery-during-live", "concurrent", "ledger-committed"] as const)("publishes one mirror pair across live settlement and recovery: %s", async (mode) => {
    const directory = temporaryDirectory("flywheel-usage-settlement-")
    const store = createSqliteEventStore(join(directory, "events.sqlite"))
    const authority = createUsageAuthority({ dbFile: join(directory, "usage.sqlite"), profileId: entry.profileId })
    const writer = createSessionFactWriter({ sessionId: "parent", writer: asAsyncEventWriter(store) })
    const committed: UsageEntry[] = []
    const options = {
      owner: { kind: "session" as const, sessionId: "parent" },
      reader: asAsyncEventReadSurface(store),
      writer,
      acquireAuthority: async () => ({
        profileId: entry.profileId,
        authorityIncarnation: authority.incarnation(),
        append: authority.append,
        release: async () => {},
      }),
      onCommitted: (value: UsageEntry) => { committed.push(value) },
    }
    try {
      const live = createSessionUsageSettlement(options)
      const recovery = createSessionUsageSettlement(options)
      await live.begin(unmeasuredDraft)
      await live.checkpoint(draft)
      const checkpoint = store.readInFlight("parent", "usage.settlement")[0]!
      if (mode === "ledger-committed") expect(authority.append(entry)).toEqual({ kind: "appended" })
      if (mode === "concurrent") {
        await Promise.all([recovery.recover(checkpoint.payload), live.settle(entry.attemptId, { served: true })])
      } else {
        // A side question's next run recovers its parent's cells while the question's own attempt is still live.
        await recovery.recover(checkpoint.payload)
        if (mode === "recovery-during-live") expect(store.read({ sessionId: "parent" }).filter((fact) => fact.type === "model.usage.measured")).toHaveLength(0)
        await live.settle(entry.attemptId, { served: true })
      }
      await recovery.recover(checkpoint.payload)
      const facts = store.read({ sessionId: "parent" })
      expect(facts.filter((fact) => fact.type === "model.usage.recorded")).toHaveLength(1)
      expect(facts.filter((fact) => fact.type === "model.usage.measured")).toHaveLength(1)
      expect(loadProviderRequestAuditFromEvents(facts)).toMatchObject([{ requestId: draft.requestId, usage: { attemptId: entry.attemptId, coverage: "complete", inputTokens: entry.tokens.input } }])
      expect(authority.rangeEntries({ startMs: Date.parse(entry.occurredAt), endMs: Date.parse(entry.occurredAt) + 1 }).groups).toMatchObject([{ attempts: 1, unmeasuredAttempts: 0 }])
      expect(committed).toEqual([entry])
      expect(store.readInFlight("parent", "usage.settlement")).toHaveLength(0)
    } finally {
      writer.dispose()
      authority.dispose()
      store.close()
    }
  })

  test("session recovery leaves a cell to its live attempt when that attempt settles while recovery awaits an earlier cell", async () => {
    const directory = temporaryDirectory("flywheel-usage-settlement-recovery-")
    const store = createSqliteEventStore(join(directory, "events.sqlite"))
    const authority = createUsageAuthority({ dbFile: join(directory, "usage.sqlite"), profileId: entry.profileId })
    const writer = createSessionFactWriter({ sessionId: "parent", writer: asAsyncEventWriter(store) })
    const lease = async () => ({ profileId: entry.profileId, authorityIncarnation: authority.incarnation(), append: authority.append, release: async () => {} })
    const base = { owner: { kind: "session" as const, sessionId: "parent" }, reader: asAsyncEventReadSurface(store), writer }
    try {
      const crashed: UsageSettlementDraft = { ...unmeasuredDraft, requestId: "request-0", entry: { ...unmeasuredEntry, attemptId: "00000000-0000-4000-8000-000000000000" } }
      await writer.putInFlight!("usage.settlement", crashed.entry.attemptId, crashed)
      const live = createSessionUsageSettlement({ ...base, acquireAuthority: lease })
      await live.begin(unmeasuredDraft)
      let settledLive = false
      const recovering = { ...base, acquireAuthority: async () => {
        if (!settledLive) {
          settledLive = true
          await live.checkpoint(draft)
          await live.settle(entry.attemptId, { served: true })
        }
        return lease()
      } }
      await recoverSessionUsageSettlements(recovering, createSessionUsageSettlement(recovering))
      const measured = store.read({ sessionId: "parent" }).filter((fact) => fact.type === "model.usage.measured")
      expect(measured.map((fact) => [fact.payload.attemptId, fact.payload.coverage])).toEqual([[entry.attemptId, "complete"], [crashed.entry.attemptId, "unmeasured"]])
      expect(store.readInFlight("parent", "usage.settlement")).toHaveLength(0)
    } finally {
      writer.dispose()
      authority.dispose()
      store.close()
    }
  })

  test("publishes a served attempt without a usage report as one unmeasured record in the ledger and the session", async () => {
    const directory = temporaryDirectory("flywheel-usage-settlement-unmeasured-")
    const store = createSqliteEventStore(join(directory, "events.sqlite"))
    const authority = createUsageAuthority({ dbFile: join(directory, "usage.sqlite"), profileId: entry.profileId })
    const writer = createSessionFactWriter({ sessionId: "parent", writer: asAsyncEventWriter(store) })
    try {
      const settlement = createSessionUsageSettlement({
        owner: { kind: "session", sessionId: "parent" },
        reader: asAsyncEventReadSurface(store),
        writer,
        acquireAuthority: async () => ({ profileId: entry.profileId, authorityIncarnation: authority.incarnation(), append: authority.append, release: async () => {} }),
      })
      await settlement.begin(unmeasuredDraft)
      await settlement.settle(entry.attemptId, { served: true })
      const facts = store.read({ sessionId: "parent" })
      expect(facts.filter((fact) => fact.type === "model.usage.measured").map((fact) => [fact.version, fact.payload])).toEqual([[6, expect.objectContaining({ attemptId: entry.attemptId, coverage: "unmeasured" })]])
      expect(facts.find((fact) => fact.type === "model.usage.measured")?.payload).not.toHaveProperty("tokens")
      expect(loadProviderRequestAuditFromEvents(facts)).toMatchObject([{ usage: { coverage: "unmeasured", inputTokens: null, cacheReadInputTokens: null, promptTokens: null } }])
      expect(authority.rangeEntries({ startMs: Date.parse(entry.occurredAt), endMs: Date.parse(entry.occurredAt) + 1 }).groups).toMatchObject([{ attempts: 0, unmeasuredAttempts: 1, inputTokens: 0, estimatedUsd: 0 }])
    } finally {
      writer.dispose()
      authority.dispose()
      store.close()
    }
  })

  test("persists the unmeasured record before the wire attempt and replaces it with the measured record", async () => {
    const { settlement, calls, opened, checkpoints } = harness()
    await settlement.begin(unmeasuredDraft)
    expect(checkpoints).toEqual([{ kind: "usage.settlement", key: entry.attemptId, payload: unmeasuredDraft }])
    await settlement.checkpoint(draft)
    expect(checkpoints[1]).toEqual({ kind: "usage.settlement", key: entry.attemptId, payload: draft })
    await settlement.settle(entry.attemptId, { served: true })
    expect(calls).toEqual(["checkpoint", "checkpoint", "open", "append", "dispose", "publish:drop"])
    expect(opened).toEqual([entry.profileId])
  })

  test("an attempt the provider did not serve retires without opening the ledger or publishing facts", async () => {
    const { settlement, calls } = harness()
    await settlement.begin(unmeasuredDraft)
    await settlement.settle(entry.attemptId, { served: false })
    expect(calls).toEqual(["checkpoint", "retire:drop"])
  })

  test("recovers a measured checkpoint from a build before coverage, which named the workflow attempt stepId", async () => {
    const published: UsageSettlementDraft[] = []
    const { settlement } = harness({ publish: async (recovered) => {
      published.push(recovered)
      return { kind: "published" }
    } })
    const { workflowAttemptId: _current, ...rest } = draft
    const { coverage: _coverage, ...uncovered } = entry
    await settlement.recover({ state: "measured", ...rest, entry: uncovered, stepId: "step-1" })
    expect(published).toEqual([draft])
  })

  test("recovery retires a pending checkpoint from a build before coverage with one warning and no ledger work", async () => {
    const warn = spyOn(Log.create({ service: "usage-settlement" }), "warn").mockImplementation(() => {})
    try {
      const { settlement, calls, opened } = harness()
      await settlement.recover({
        state: "pending",
        attemptId: entry.attemptId,
        requestId: entry.attemptId,
        profileId: entry.profileId,
        budgetStreamId: draft.budgetStreamId,
        identity: draft.identity,
        turn: draft.turn,
      })
      expect(calls).toEqual(["retire:drop"])
      expect(opened).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[1]).toEqual({ attemptId: entry.attemptId })
    } finally {
      warn.mockRestore()
    }
  })

  test("does not retain a draft when checkpoint persistence fails", async () => {
    const failure = new Error("checkpoint failed")
    const { settlement, calls } = harness({ checkpointError: failure })
    expect(settlement.checkpoint(draft)).rejects.toBe(failure)
    await settlement.settle(entry.attemptId, { served: true })
    expect(calls).toEqual(["checkpoint"])
  })

  test("continues publication after a duplicate append", async () => {
    const { settlement, calls } = harness({ append: () => ({ kind: "duplicate" }) })
    await settlement.checkpoint(draft)
    await settlement.settle(entry.attemptId, { served: true })
    expect(calls).toEqual(["checkpoint", "open", "append", "dispose", "publish:drop"])
  })

  test("disposes the authority and stops publication on conflict", async () => {
    const conflict = new UsageEntryConflictError(entry.attemptId)
    const { settlement, calls } = harness({ append: () => { throw conflict } })
    await settlement.checkpoint(draft)
    expect(settlement.settle(entry.attemptId, { served: true })).rejects.toBe(conflict)
    expect(calls).toEqual(["checkpoint", "open", "append", "dispose"])
  })

  test("retains the checkpoint on publication failure", async () => {
    const failure = new Error("publish failed")
    const publications: Array<{ draft: UsageSettlementDraft; retirement: UsageSettlementRetirement }> = []
    const { settlement, calls } = harness({ publish: async (value, retirement) => {
      calls.push("publish")
      publications.push({ draft: value, retirement })
      throw failure
    } })
    await settlement.checkpoint(draft)
    expect(settlement.settle(entry.attemptId, { served: true })).rejects.toBe(failure)
    expect(calls).toEqual(["checkpoint", "open", "append", "dispose", "publish"])
    expect(publications).toEqual([{ draft, retirement: { op: "drop", kind: "usage.settlement", key: entry.attemptId } }])
  })

  test("rejects invalid durable payload before opening an authority", async () => {
    const { settlement, calls } = harness()
    expect(settlement.recover({ ...draft, unexpected: true })).rejects.toThrow()
    expect(settlement.recover({ ...draft, turn: 0 })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  test("rejects noncanonical entries before checkpointing or recovery", async () => {
    const invalidEntries: UsageEntry[] = [
      { ...entry, occurredAt: "2025-01-15T12:00:00+00:00" },
      { ...entry, spendMode: "included", classification: "real_spend" },
    ]
    for (const invalidEntry of invalidEntries) {
      const normal = harness()
      await expect(normal.settlement.checkpoint({ ...draft, entry: invalidEntry })).rejects.toThrow()
      expect(normal.calls).toEqual([])
      const recovery = harness()
      await expect(recovery.settlement.recover({ ...draft, entry: invalidEntry })).rejects.toThrow()
      expect(recovery.calls).toEqual([])
    }
  })

})
