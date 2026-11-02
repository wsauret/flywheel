import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UsageAuthority } from "../../../../src/infra/llm/usage-authority.js"
import type { UsageEntry } from "../../../../src/infra/llm/usage-entry.js"
import { createUsageSettlement, type UsageSettlementDraft } from "../../../../src/orchestration/agent-runtime/usage-settlement.js"
import { createSubscriptionUsageServicePool } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js"
import { createSubscriptionUsageService, type SubscriptionUsageProfile, type SubscriptionUsageService } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { registry } from "../auth/provider-observations/_service-fixtures.js"

const entry: UsageEntry = {
  attemptId: "00000000-0000-4000-8000-000000000001",
  occurredAt: "2025-01-15T12:00:00.000Z",
  profileId: "a",
  currency: "USD", coverage: "complete",
  attribution: { kind: "candidate", providerId: "anthropic_api" },
  spendMode: "direct_api",
  credentialLineage: "00000000-0000-4000-8000-000000000002",
  model: "claude-sonnet-4",
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  classification: "real_spend",
  price: { kind: "priced", estimatedUsd: 0.01, rateCard: { inputPerMillionUsd: 1 }, provenance: "live" },
}

const draft: UsageSettlementDraft = {
  entry,
  budgetStreamId: "budget",
  requestId: "request",
  identity: { providerSessionKey: "provider-session", conversationId: "conversation" },
  turn: 1,
}

function service(profile: SubscriptionUsageProfile, appended: string[], close: () => Promise<void>): SubscriptionUsageService {
  const authority: Pick<UsageAuthority, "profileId" | "incarnation" | "append"> = {
    profileId: profile.id,
    incarnation: () => `incarnation:${profile.id}`,
    append: () => { appended.push(profile.id); return { kind: "appended" } },
  }
  return {
    generation: () => ({ generation: 1, profileId: profile.id, profileDirectory: profile.directory, providerIds: [], enabledModuleIds: [], readerProviderIds: [], accounts: [], thresholds: [], identity: profile.id }),
    snapshot: () => undefined,
    store: (): UsageAuthority => Object.assign(Object.create(null), authority),
    currentAccounts: () => [],
    metric: () => ({ kind: "unknown" }),
    refresh: async () => undefined,
    replaceThresholds: async () => undefined,
    check: async () => undefined,
    checkAccounts: async () => undefined,
    applyReset: async () => ({ kind: "noCredit" }),
    onPublished: () => () => {},
    start() {},
    pause() {},
    closeAdmission() {},
    settled: close,
  }
}

describe("usage authority lifecycle", () => {
  test.each(["settle", "recover"] as const)("keeps a captured append alive across refresh and drains %s before deletion", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "usage-authority-lifecycle-"))
    const pool = createSubscriptionUsageServicePool({
      create: (profile) => createSubscriptionUsageService({
        profile: () => profile,
        registry: () => registry([], new Map()),
        thresholds: () => [],
      }),
    })
    const resident = await pool.acquire({ id: entry.profileId, directory })
    const authority = resident.service.store()
    if (!authority) throw new Error("Usage authority did not open")
    const acquired = Promise.withResolvers<void>()
    const resumeAppend = Promise.withResolvers<void>()
    const checkpoints = new Map<string, unknown>()
    let publications = 0
    const options: Parameters<typeof createUsageSettlement>[0] = {
      putInFlight: async (_kind, key, payload) => { checkpoints.set(key, payload) },
      retire: async (retirement) => { checkpoints.delete(retirement.key) },
      acquireAuthority: async (profileId) => {
        const lease = await pool.acquireSettlement({ id: profileId, directory })
        const captured = lease.service.store()
        if (!captured) { await lease.release(); throw new Error("Usage authority did not open") }
        const append = captured.append
        acquired.resolve()
        await resumeAppend.promise
        return { profileId, authorityIncarnation: captured.incarnation(), append, release: lease.release }
      },
      publish: async (_draft, retirement) => {
        expect(authority.rangeEntries({ startMs: Date.parse(entry.occurredAt), endMs: Date.parse(entry.occurredAt) + 1 }).groups).toMatchObject([{ attempts: 1 }])
        expect(checkpoints.has(entry.attemptId)).toBe(true)
        expect(resident.service.store()).toBe(authority)
        publications += 1
        checkpoints.delete(retirement.key)
        return { kind: "published" }
      },
    }
    const settlement = createUsageSettlement(options)
    await settlement.checkpoint(draft)
    const pending = mode === "settle" ? settlement.settle(entry.attemptId, { served: true }) : createUsageSettlement(options).recover(checkpoints.get(entry.attemptId))
    try {
      await acquired.promise
      const generation = resident.service.generation()?.generation
      await pool.refresh()
      expect(resident.service.generation()?.generation).not.toBe(generation)
      let removed = false
      const removal = pool.closeProfile(entry.profileId).then((finish) => { removed = true; return finish })
      await Promise.resolve()
      expect(removed).toBe(false)
      expect(publications).toBe(0)
      expect(checkpoints.size).toBe(1)
      resumeAppend.resolve()
      await expect(pending).resolves.toBeUndefined()
      const finish = await removal
      expect(publications).toBe(1)
      expect(checkpoints.size).toBe(0)
      expect(() => authority.revision()).toThrow("Usage authority is disposed")
      finish()
    } finally {
      resumeAppend.resolve()
      await pending.catch(() => {})
      await resident.release()
      await pool.settled()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("retains the admitted profile through publication and blocks replacement", async () => {
    const appended: string[] = []
    let unblockClose!: () => void
    let blockClose = false
    const closeGate = new Promise<void>((resolve) => { unblockClose = resolve })
    const pool = createSubscriptionUsageServicePool({ create: (profile) => service(profile, appended, async () => { if (blockClose) await closeGate }) })
    let publish!: () => void
    const publication = new Promise<void>((resolve) => { publish = resolve })
    const settlement = createUsageSettlement({
      putInFlight: async () => {},
      retire: async () => {},
      acquireAuthority: async (profileId) => {
        if (profileId !== "a") throw new Error(`unexpected profile ${profileId}`)
        const lease = await pool.acquireSettlement({ id: profileId, directory: "/profiles/a" })
        const authority = lease.service.store()
        if (!authority) { await lease.release(); throw new Error(`usage authority is unavailable for profile ${profileId}`) }
        return { profileId, authorityIncarnation: authority.incarnation(), append: authority.append, release: lease.release }
      },
      publish: async () => { await publication; return { kind: "published" } },
    })

    await settlement.checkpoint(draft)
    const pendingSettlement = settlement.settle(entry.attemptId, { served: true })
    await Bun.sleep(0)
    blockClose = true
    const pendingRemoval = pool.closeProfile("a")
    let removed = false
    void pendingRemoval.then(() => { removed = true })
    await Bun.sleep(0)
    expect(removed).toBe(false)
    expect(appended).toEqual(["a"])

    publish()
    expect(removed).toBe(false)
    unblockClose()
    await pendingSettlement
    const finishRemoval = await pendingRemoval
    finishRemoval()

    const fresh = await pool.acquire({ id: "a", directory: "/profiles/a" })
    expect(fresh.service.generation()?.profileId).toBe("a")
    await fresh.release()
  })

})
