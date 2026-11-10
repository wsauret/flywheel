import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Redacted } from "effect"
import type { SubscriptionUsageReader } from "../../../../../src/infra/llm/subscription-usage.js"
import type { AccessProviderDefinition, ExternalAccount } from "../../../../../src/infra/llm/access-provider.js"
import { createSubscriptionAccountIdentity } from "../../../../../src/infra/llm/subscription-account-identity.js"
import { createSubscriptionUsageStore } from "../../../../../src/infra/llm/subscription-usage-store.js"
import { createSubscriptionUsageService, type SubscriptionUsageService } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { captureCopilotAllowanceAdmission } from "../../../../../src/orchestration/modules/provider-github-copilot/allowance-admission.js"
import { createChatGPTUsageReader } from "../../../../../src/orchestration/modules/provider-chatgpt/usage-reader.js"
import { createRuntimeUsageDeps } from "../../../../../src/orchestration/modules/subscription-usage/provider-deps.js"
import { subscriptionSpendAccountCorrelationId } from "../../../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { refusingLauncher } from "../../../../helpers/launcher-fake.js"
import { createProfileFixture, definition, readerFor, registry, report, writeAccounts } from "./_service-fixtures.js"

const { profile, cleanup } = createProfileFixture()

afterEach(cleanup)

describe("subscription usage service", () => {
  test("captures configured accounts in stable order and publishes independent account states", async () => {
    const directory = profile("states")
    const ids = ["unsupported", "stale", "failure", "supported", "expired-auth", "identity-unavailable"]
    const definitions = ids.map((id) => definition(id))
    writeAccounts(directory, definitions)
    const staleStore = createSubscriptionUsageStore({ profileDir: directory, profileId: "default" })
    staleStore.record(report("stale", 0))
    staleStore.dispose()

    const readers = new Map<string, SubscriptionUsageReader>([
      ["supported", readerFor("supported")],
      ["identity-unavailable", readerFor("identity-unavailable")],
      ["expired-auth", readerFor("expired-auth")],
      ["failure", readerFor("failure")],
      ["stale", readerFor("failure")],
    ])
    const published: Array<NonNullable<Awaited<ReturnType<SubscriptionUsageService["check"]>>>> = []
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, readers),
      thresholds: () => [75, 90],
      now: () => 10_000,
      freshnessMs: 100,
    })
    service.onPublished((snapshot) => { published.push(snapshot) })

    const snapshot = await service.check({ forceRefresh: true })
    expect(snapshot).toBeDefined()
    expect(snapshot?.accounts.map((state) => state.account.providerId)).toEqual([
      "expired-auth",
      "failure",
      "identity-unavailable",
      "stale",
      "supported",
      "unsupported",
    ])
    expect(snapshot?.accounts.map((state) => state.kind)).toEqual([
      "expired-auth",
      "failure",
      "identity-unavailable",
      "stale",
      "supported",
      "unsupported",
    ])
    expect(published).toHaveLength(1)
    expect(snapshot?.thresholds).toEqual([75, 90])
    await service.settled()
  })

  test("names each current account as its owner holds it now: the auth store for a stored login, the program for an external one", async () => {
    const directory = profile("current-accounts")
    const stored = definition("stored")
    let heldAccounts: readonly ExternalAccount[] = [{ accountId: "uuid-a", identity: "a@example.com", configDir: "/scratch/a" }]
    const external: AccessProviderDefinition = {
      ...definition("external"),
      auth: { kind: "external", program: "Example CLI", statusRank: 1, accounts: () => heldAccounts, problems: () => [], observe: () => () => {}, awaitLogin: async () => "declined", loginQuestions: () => [], answerLogin: () => undefined, settleLogin: () => {}, login: () => Promise.reject(new Error("no login")), logout: async () => {}, logoutProfile: async () => {} },
    }
    writeAccounts(directory, [stored])
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry([stored, external], new Map()),
      thresholds: () => [],
    })
    await service.refresh()

    expect(service.currentAccounts()).toEqual([
      createSubscriptionAccountIdentity("external", "uuid-a", "a@example.com"),
      createSubscriptionAccountIdentity("stored", "account", "stored-identity"),
    ])
    heldAccounts = [{ accountId: "uuid-b", identity: "b@example.com", configDir: "/scratch/b" }]
    expect(service.currentAccounts()[0]).toEqual(createSubscriptionAccountIdentity("external", "uuid-b", "b@example.com"))
    await service.settled()
  })

  test("hands each reader the runtime's launch authority, so a reader that asks a program starts it only in that scope", async () => {
    const directory = profile("launcher")
    const external: AccessProviderDefinition = {
      ...definition("external"),
      auth: { kind: "external", program: "Example CLI", statusRank: 1, accounts: () => [{ accountId: "uuid-a", identity: "a@example.com", configDir: "/scratch/a" }], problems: () => [], observe: () => () => {}, awaitLogin: async () => "declined", loginQuestions: () => [], answerLogin: () => undefined, settleLogin: () => {}, login: () => Promise.reject(new Error("no login")), logout: async () => {}, logoutProfile: async () => {} },
    }
    const launchers: unknown[] = []
    const reader: SubscriptionUsageReader = async (context) => {
      launchers.push(context.launcher)
      return { kind: "unsupported" }
    }
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry([external], new Map([["external", reader]])),
      thresholds: () => [],
      launcher: refusingLauncher,
    })

    await service.check({ forceRefresh: true })

    expect(launchers).toEqual([refusingLauncher])
    await service.settled()
  })

  test("an account whose own billing is metered, such as a usage-only enterprise login, is never read and joins Usage as a metered source", async () => {
    const directory = profile("metered-account")
    const external: AccessProviderDefinition = {
      ...definition("external"),
      auth: { kind: "external", program: "Example CLI", statusRank: 1, accounts: () => [
        { accountId: "uuid-plan", identity: "plan@example.com", configDir: "/scratch/plan" },
        { accountId: "uuid-enterprise", identity: "enterprise@example.com", configDir: "/scratch/enterprise", billing: "metered" },
      ], problems: () => [], observe: () => () => {}, awaitLogin: async () => "declined", loginQuestions: () => [], answerLogin: () => undefined, settleLogin: () => {}, login: () => Promise.reject(new Error("no login")), logout: async () => {}, logoutProfile: async () => {} },
    }
    const read: string[] = []
    const reader: SubscriptionUsageReader = async (context) => {
      read.push(context.account.instanceId)
      return { kind: "unsupported" }
    }
    const providers = registry([external], new Map([["external", reader]]))
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => providers,
      thresholds: () => [],
    })

    const snapshot = await service.check({ forceRefresh: true })

    expect(snapshot?.accounts.map((state) => state.account.instanceId)).toEqual(["uuid-plan"])
    expect(read).toEqual(["uuid-plan"])
    const usageDeps = createRuntimeUsageDeps({ moduleSelection: () => providers.composition, eventReader: { inFlightProfileKeys: async () => [] } })
    expect(usageDeps.meteredUsageSources({ id: "default", directory })).toEqual([{
      kind: "metered", sourceId: subscriptionSpendAccountCorrelationId("default", "external", "uuid-enterprise"), providerId: "external",
      label: "external", spendMode: "direct_api", identity: "enterprise@example.com",
    }])
    await service.settled()
  })

  test("reads the stored key of a metered provider that declares a balance reader, as one account named by the key's lineage, and no other metered key", async () => {
    const directory = profile("metered-key-reader")
    const metered = (id: string): AccessProviderDefinition => ({ ...definition(id), billing: "metered", spendMode: "direct_api", auth: { kind: "api_key", statusRank: 1 } })
    const lineage = "22222222-2222-4222-8222-222222222222"
    writeFileSync(join(directory, "auth.json"), JSON.stringify({
      balance: { type: "api_key", key: "sk-balance-key-1234", lineageId: lineage },
      plain: { type: "api_key", key: "sk-plain-key-5678", lineageId: "33333333-3333-4333-8333-333333333333" },
    }))
    const headers: string[] = []
    const reader: SubscriptionUsageReader = async (context) => {
      if (context.account.credential.type === "api_key") headers.push(Redacted.value(context.account.credential.key))
      return { kind: "success", report: { providerId: "balance", instanceId: context.account.instanceId, identity: context.account.identity ?? "", providerStatus: "exhausted", observedAtMs: 10_000, metrics: [], spendSources: [{ kind: "prepaid", availability: "empty" }] } }
    }
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry([metered("balance"), metered("plain")], new Map([["balance", reader]])),
      thresholds: () => [],
      now: () => 10_000,
    })

    const snapshot = await service.check({ forceRefresh: true })

    expect(headers).toEqual(["sk-balance-key-1234"])
    expect(snapshot?.accounts.map((state) => [state.kind, state.account.providerId, state.account.instanceId, state.account.identity])).toEqual([["supported", "balance", lineage, "••••1234"]])
    const state = snapshot?.accounts[0]
    expect(state?.kind === "supported" ? [state.snapshot.providerStatus, state.snapshot.spendSources] : undefined).toEqual(["exhausted", [{ kind: "prepaid", availability: "empty" }]])
    await service.settled()
  })

  test("replaces thresholds on the current generation without provider reads or profile recapture", async () => {
    const directory = profile("threshold-policy")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions)
    let profileReads = 0
    let providerReads = 0
    const service = createSubscriptionUsageService({
      profile: () => { profileReads += 1; return { id: "default", directory } },
      registry: () => registry(definitions, new Map([["supported", async () => {
        providerReads += 1
        return { kind: "success", report: report("supported", 10_000) }
      }]])),
      thresholds: () => [75, 90],
      now: () => 10_000,
    })
    const generation = service.generation()
    await service.check({ forceRefresh: true })

    const replaced = await service.replaceThresholds([80, 95])

    expect(replaced?.generation).toBe(generation?.generation)
    expect(replaced?.identity).toBe(generation?.identity)
    expect(replaced?.thresholds).toEqual([80, 95])
    expect(service.snapshot()?.thresholds).toEqual([80, 95])
    expect(profileReads).toBe(1)
    expect(providerReads).toBe(1)
    await service.settled()
  })

  test("does not publish reflected exception text", async () => {
    const directory = profile("safe-errors")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions)
    const reflected = "provider-secret-token"
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", async () => { throw new Error(reflected) }]])),
      thresholds: () => [],
    })

    const snapshot = await service.check({ forceRefresh: true })

    expect(JSON.stringify(snapshot)).not.toContain(reflected)
    expect(snapshot?.accounts[0]).toMatchObject({ kind: "failure", message: "subscription usage request failed" })
    await service.settled()
  })

  test("rotated OAuth tokens replace only their captured credential instance", async () => {
    const directory = profile("instance-refresh")
    const definitions: AccessProviderDefinition[] = [definition("supported"), { ...definition("metered"), billing: "metered", spendMode: "direct_api" }]
    const metered = { type: "api_key", key: "metered-key", lineageId: "00000000-0000-4000-8000-000000000003" }
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ metered, supported: [
      { id: "selected", identity: "selected@example.com", lineageId: "00000000-0000-4000-8000-000000000001", credential: { type: "oauth", access: "selected-old", refresh: "selected-refresh", expires: 1 } },
      { id: "other", identity: "other@example.com", lineageId: "00000000-0000-4000-8000-000000000002", credential: { type: "oauth", access: "other-old", refresh: "other-refresh", expires: 1 } },
    ] }))
    const reader: SubscriptionUsageReader = async ({ account, compareAndSetTokens }) => {
      if (account.credential.type !== "oauth") throw new Error("expected OAuth")
      if (account.instanceId === "selected") {
        await compareAndSetTokens(
          { accessToken: account.credential.access, refreshToken: account.credential.refresh, expiresAtMs: account.credential.expires },
          { accessToken: Redacted.make("selected-new"), refreshToken: account.credential.refresh, expiresAtMs: 2 },
        )
      }
      return { kind: "success", report: { ...report("supported", 10_000), instanceId: account.instanceId, identity: account.identity ?? "" } }
    }
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", reader]])),
      thresholds: () => [],
    })

    await service.check({ forceRefresh: true })
    const persisted = await Bun.file(join(directory, "auth.json")).json()

    expect(Object.fromEntries(persisted.supported.map((entry: { id: string; credential: { access: string } }) => [entry.id, entry.credential.access]))).toEqual({ selected: "selected-new", other: "other-old" })
    expect(persisted.metered).toEqual(metered)
    expect(persisted.supported.map((entry: { lineageId: string }) => entry.lineageId)).toEqual([
      "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001",
    ])
    await service.settled()
  })

  test("adopts rotated OAuth tokens for the next read without recapturing the profile", async () => {
    const directory = profile("runtime-token-rotation")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions)
    const seenRefreshTokens: string[] = []
    let profileReads = 0
    const reader: SubscriptionUsageReader = async ({ account, compareAndSetTokens }) => {
      if (account.credential.type !== "oauth" || account.credential.refresh === undefined) throw new Error("expected OAuth refresh token")
      const refreshToken = Redacted.value(account.credential.refresh)
      seenRefreshTokens.push(refreshToken)
      if (refreshToken === "supported-refresh") {
        expect(await compareAndSetTokens(
          { accessToken: account.credential.access, refreshToken: account.credential.refresh, expiresAtMs: account.credential.expires },
          { accessToken: Redacted.make("rotated-access"), refreshToken: Redacted.make("rotated-refresh"), expiresAtMs: account.credential.expires + 1 },
        )).toBe(true)
      }
      return { kind: "success", report: report("supported", 10_000) }
    }
    const service = createSubscriptionUsageService({
      profile: () => { profileReads += 1; return { id: "default", directory } },
      registry: () => registry(definitions, new Map([["supported", reader]])),
      thresholds: () => [],
    })

    await service.check({ forceRefresh: true })
    await service.check({ forceRefresh: true })

    expect(seenRefreshTokens).toEqual(["supported-refresh", "rotated-refresh"])
    expect(profileReads).toBe(1)
    await service.settled()
  })

  test("a usage check reads the credential the store holds now, so a token another owner rotated is not refreshed again", async () => {
    const directory = profile("rotated-elsewhere")
    const definitions = [definition("supported")]
    const writeCredential = (access: string, expires: number) => writeFileSync(join(directory, "auth.json"), JSON.stringify({ supported: [{
      id: "account",
      identity: "supported-identity",
      lineageId: "11111111-1111-4111-8111-111111111111",
      credential: { type: "oauth", access, refresh: `${access}-refresh`, expires },
    }] }))
    // The service captures an expired token; a model request then rotates it.
    writeCredential("captured-access", 1)
    const bearers: string[] = []
    const reader = createChatGPTUsageReader(Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      bearers.push(new Headers(init?.headers).get("authorization") ?? "")
      return Response.json({ plan_type: "plus" })
    }, { preconnect: fetch.preconnect }))
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", reader]])),
      thresholds: () => [],
    })
    writeCredential("rotated-access", Date.now() + 60 * 60_000)
    // Only a token refresh reaches the global fetch; the usage request goes
    // through the reader's own.
    const refreshes = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response("{}", { status: 500 }), { preconnect: fetch.preconnect }))
    try {
      await service.check({ forceRefresh: true })
      await service.check({ forceRefresh: true })
      expect(refreshes).not.toHaveBeenCalled()
      expect(bearers).toEqual(["Bearer rotated-access", "Bearer rotated-access"])
    } finally {
      refreshes.mockRestore()
      await service.settled()
    }
  })

  test("classifies exact metric evidence as fresh, retained, or unknown", async () => {
    const directory = profile("metric-evidence")
    const definitions = [definition("supported")]
    writeAccounts(directory, definitions)
    let now = 10_000
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map([["supported", async () => ({
        kind: "success" as const,
        report: { ...report("supported", 10_000), metrics: [{ metricKey: "ai_credits", label: "AI Credits", scope: { kind: "account" as const }, rank: 0, timing: { kind: "exact" as const, startMs: 1, endMs: 20_000 }, allowanceMode: "finite" as const, used: { kind: "count" as const, value: 370, unit: "AI Credits", provenance: "provider" as const, precision: "exact" as const }, limit: { kind: "count" as const, value: 7000, unit: "AI Credits", provenance: "provider" as const, precision: "exact" as const }, remaining: { kind: "count" as const, value: 6629, unit: "AI Credits", provenance: "provider" as const, precision: "exact" as const } }] },
      })]])),
      thresholds: () => [],
      now: () => now,
      freshnessMs: 100,
    })

    expect(service.metric("supported", "account", "ai_credits")).toEqual({ kind: "unknown" })
    await service.check({ forceRefresh: true })
    expect(service.metric("supported", "account", "ai_credits")).toMatchObject({ kind: "fresh", metric: { allowanceMode: "finite" } })
    expect(service.metric("supported", "account", "missing")).toEqual({ kind: "unknown" })
    now = 10_101
    expect(service.metric("supported", "account", "ai_credits")).toMatchObject({ kind: "retained", metric: { allowanceMode: "finite" } })
    await service.settled()
  })
  test("names the expired sign-in and /auth, and retains a prior reading for inspection", async () => {
    const expiredService = (name: string, retainedReading: boolean) => {
      const directory = profile(name)
      const definitions = [{ ...definition("supported"), shortName: "ChatGPT" }]
      writeAccounts(directory, definitions)
      if (retainedReading) {
        const durable = createSubscriptionUsageStore({ profileDir: directory, profileId: "default" })
        durable.record({ ...report("supported", 10_000), spendSources: [{ kind: "prepaid", availability: "empty" }] })
        durable.dispose()
      }
      return createSubscriptionUsageService({
        profile: () => ({ id: "default", directory }),
        registry: () => registry(definitions, new Map([["supported", readerFor("expired-auth")]])),
        thresholds: () => [],
        now: () => 10_000,
      })
    }

    const unread = expiredService("expired-auth-unread", false)
    expect((await unread.check())?.accounts[0]).toMatchObject({ kind: "expired-auth", message: "ChatGPT sign-in expired. Run /auth and reconnect ChatGPT." })
    await unread.settled()

    const retained = expiredService("expired-auth-retained", true)
    expect((await retained.check())?.accounts[0]).toMatchObject({ kind: "stale", message: "ChatGPT sign-in expired. Run /auth and reconnect ChatGPT. The usage shown is the last reading." })
    await retained.settled()
  })

  test("force-refreshes pooled Copilot evidence and resolves each credential instance independently", async () => {
    const directory = profile("copilot-allowance")
    const provider = definition("github_copilot")
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ github_copilot: [
      { id: "personal", identity: "personal-identity", lineageId: "00000000-0000-4000-8000-000000000001", credential: { type: "oauth", access: "access", refresh: "personal-refresh", expires: 9_999_999_999 } },
      { id: "work", identity: "work-identity", lineageId: "00000000-0000-4000-8000-000000000002", credential: { type: "oauth", access: "access", refresh: "work-refresh", expires: 9_999_999_999 } },
    ] }))
    let providerReads = 0
    const reader: SubscriptionUsageReader = async ({ account }) => {
      providerReads += 1
      const pooled = account.instanceId === "work"
      return { kind: "success", report: {
        providerId: "github_copilot",
        instanceId: account.instanceId,
        identity: account.identity ?? "",
        providerStatus: "ok",
        observedAtMs: 10_000 + providerReads,
        metrics: [{
          metricKey: "ai_credits",
          label: "AI Credits",
          scope: { kind: "account" },
          rank: 0,
          timing: { kind: "unavailable" },
          allowanceMode: pooled ? "pooled" : "finite",
          used: { kind: "count", value: pooled ? 420 : 370, unit: "AI Credits", provenance: "provider", precision: "exact" },
          ...(pooled ? {} : {
            limit: { kind: "count" as const, value: 7_000, unit: "AI Credits", provenance: "provider" as const, precision: "exact" as const },
            remaining: { kind: "count" as const, value: 6_630, unit: "AI Credits", provenance: "provider" as const, precision: "exact" as const },
          }),
        }],
      } }
    }
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry([provider], new Map([[provider.id, reader]])),
      thresholds: () => [],
      now: () => 10_000,
    })

    const candidates = ["personal", "work"].map((instanceId) => ({ kind: "subscription" as const, providerId: "github_copilot", instanceId, spendMode: "included" as const }))
    const allowanceFor = await captureCopilotAllowanceAdmission({ candidates, service, monthlyCreditCap: undefined })

    expect(providerReads).toBe(2)
    expect(allowanceFor({ kind: "subscription", providerId: "github_copilot", instanceId: "personal", spendMode: "included" })).toEqual({ freshness: "fresh", allowance: "finite", metric: "ai_credits", remaining: 6_630 })
    expect(allowanceFor({ kind: "subscription", providerId: "github_copilot", instanceId: "work", spendMode: "included" })).toEqual({ freshness: "fresh", allowance: "pooled", usedCredits: 420 })
    expect(allowanceFor({ kind: "subscription", providerId: "github_copilot", instanceId: "missing", spendMode: "included" })).toEqual({ allowance: "unknown" })
    await captureCopilotAllowanceAdmission({ candidates, service, monthlyCreditCap: undefined })
    expect(providerReads).toBe(3)
    await service.settled()
  })

})
