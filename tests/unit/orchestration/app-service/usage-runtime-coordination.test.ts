import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createUsageAppService as createFlywheelAppService, type UsageAppServiceDeps as FlywheelAppServiceDeps } from "../../../helpers/usage-app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { createInertSubscriptionUsageService } from "../../../helpers/subscription-usage-service-fixture.js"
import { createUsageAuthority, type UsageAuthority } from "../../../../src/infra/llm/usage-authority.js"
import type { UsageEntry } from "../../../../src/infra/llm/usage-entry.js"
import { createUsageSettlement } from "../../../../src/orchestration/agent-runtime/usage-settlement.js"
import { createSubscriptionUsageServicePool } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function entry(profileId: string, estimatedUsd: number): UsageEntry {
  return {
    attemptId: crypto.randomUUID(), occurredAt: "2025-01-15T12:00:00.000Z", profileId, currency: "USD", coverage: "complete",
    attribution: { kind: "candidate", providerId: "openai_api" }, spendMode: "direct_api",
    credentialLineage: profileId === "personal" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002",
    model: "gpt-5", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, classification: "real_spend",
    price: { kind: "priced", estimatedUsd, rateCard: { inputPerMillionUsd: 1 }, provenance: "live" },
  }
}

function usageService(authority: UsageAuthority, profileId: string) {
  const generation = { generation: 1, profileId, profileDirectory: authority.dbFile, providerIds: [], enabledModuleIds: [], readerProviderIds: [], accounts: [], thresholds: [], identity: `generation:${profileId}` }
  return createInertSubscriptionUsageService({ generation, authority })
}

describe("Usage runtime coordination", () => {
  test("defaults and session scopes never share profile ledger totals", async () => {
    const personalRoot = mkdtempSync(join(tmpdir(), "usage-personal-")); roots.push(personalRoot)
    const workRoot = mkdtempSync(join(tmpdir(), "usage-work-")); roots.push(workRoot)
    const personal = createUsageAuthority({ profileDir: personalRoot, profileId: "personal", now: () => Date.parse("2025-01-20T00:00:00.000Z") })
    const work = createUsageAuthority({ profileDir: workRoot, profileId: "work", now: () => Date.parse("2025-01-20T00:00:00.000Z") })
    personal.append(entry("personal", 1)); work.append(entry("work", 9))
    const services = new Map([["personal", usageService(personal, "personal")], ["work", usageService(work, "work")]])
    const store = fakeSessionStore(new Map()), manager = fakeManager()
    const deps = {
      projectRoot: "/project", projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: "/project" }), bus: createRuntimeUiBus(),
      ...fakeProjections(), runtimeSupervisor: runtimeSupervisor(),
      subscriptionUsage: {
        acquireScope: async (scope: { readonly kind: "defaults" } | { readonly kind: "session"; readonly sessionId: string }) => {
          const profileId = scope.kind === "defaults" ? "personal" : "work"
          const authority = profileId === "personal" ? personal : work
          const service = services.get(profileId)
          if (!service) throw new Error("missing profile service")
          return { profile: { id: profileId, directory: authority.dbFile }, service, release: async () => {} }
        },
        subscribePublications: () => () => {},
      },
      meteredUsageSources: (profile: { readonly id: string }) => [{ kind: "metered", sourceId: profile.id === "personal" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002", providerId: "openai_api", label: "OpenAI", spendMode: "direct_api" }],
      usageProviderDisplayName: () => "OpenAI", usageIncomplete: async () => false,
    } satisfies FlywheelAppServiceDeps
    const service = createFlywheelAppService(deps)

    await expect(service.query({ type: "usage.spend", scope: { kind: "defaults" }, asOf: Date.parse("2025-01-20T00:00:00.000Z") })).resolves.toMatchObject({ profileId: "personal", estimatedBilledUsd: 1 })
    await expect(service.query({ type: "usage.spend", scope: { kind: "session", sessionId: "work-session" }, asOf: Date.parse("2025-01-20T00:00:00.000Z") })).resolves.toMatchObject({ profileId: "work", estimatedBilledUsd: 9 })
    personal.dispose(); work.dispose()
  })
})

describe("Usage settlement recovery coordination", () => {
  test("replays an interrupted settlement through the profile service authority", async () => {
    const profileRoot = mkdtempSync(join(tmpdir(), "usage-recovery-")); roots.push(profileRoot)
    const authority = createUsageAuthority({ profileDir: profileRoot, profileId: "profile-a", now: () => Date.parse("2025-01-20T00:00:00.000Z") })
    const pool = createSubscriptionUsageServicePool({ create: () => usageService(authority, "profile-a") })
    const recoveredEntry = entry("profile-a", 2)
    let publications = 0
    const settlement = createUsageSettlement({
      putInFlight: async () => {},
      retire: async () => {},
      acquireAuthority: async (profileId) => {
        const lease = await pool.acquireSettlement({ id: profileId, directory: profileRoot })
        const store = lease.service.store()
        if (!store) { await lease.release(); throw new Error(`usage authority is unavailable for profile ${profileId}`) }
        return {
          profileId: store.profileId,
          authorityIncarnation: store.incarnation(),
          append: store.append,
          release: lease.release,
        }
      },
      publish: async () => { publications += 1; return { kind: "published" } },
    })

    await settlement.recover({
      entry: recoveredEntry,
      budgetStreamId: "budget",
      requestId: "request",
      identity: { providerSessionKey: "provider-session", conversationId: "conversation" },
      turn: 1,
    })

    expect(authority.rangeEntries({ startMs: Date.parse("2025-01-01T00:00:00.000Z"), endMs: Date.parse("2025-02-01T00:00:00.000Z") }).groups.reduce((total, group) => total + group.attempts, 0)).toBe(1)
    expect(publications).toBe(1)
    pool.closeAdmission()
    await pool.settled()
    authority.dispose()
  })
})
