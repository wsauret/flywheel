import { dirname } from "node:path"
import { AuthProfileStore } from "../../src/infra/auth/auth-profile-store.js"
import { appendCredentialInstance, setMeteredCredential } from "../../src/infra/auth/auth-store-mutations.js"
import { loadAuthStoreWithDiagnostics } from "../../src/infra/auth/auth-store.js"
import type { CredentialSlotClassifier } from "../../src/infra/auth/auth-store-types.js"
import { createUsageAuthority } from "../../src/infra/llm/usage-authority.js"
import type { MeasuredUsageEntry } from "../../src/infra/llm/usage-entry.js"
import type { SubscriptionUsageReport, SubscriptionUsageSpendSource } from "../../src/infra/llm/subscription-usage.js"
import { authDir } from "../../src/infra/paths.js"
import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js"
import { createSessionManager } from "../../src/orchestration/session/manager.js"
import { prepareWorkspaceState } from "../../src/orchestration/workspace-state.js"

function requireUserDataRoot(value: string | undefined): string {
  if (!value) throw new Error("usage: seed-usage.ts <user-data-root>")
  return value
}

const userDataRoot = requireUserDataRoot(process.argv[2])
const projectRoot = dirname(userDataRoot)
const workspace = prepareWorkspaceState({ projectRoot, userDataRoot, accountHome: projectRoot })

const now = Date.now()
const hour = 60 * 60_000
const day = 24 * hour
const classifySlot: CredentialSlotClassifier = (providerId) => ["chatgpt", "opencode_go", "github_copilot", "supergrok"].includes(providerId) ? "subscription" : "metered"
const oauth = (id: string) => ({ id, identity: `${id}@invalid.example`, label: id, credential: { type: "oauth" as const, access: `fixture-${id}`, refresh: `fixture-refresh-${id}`, expires: Date.parse("2099-01-01T00:00:00.000Z") } })
const apiKey = (id: string) => ({ type: "api_key" as const, key: `fixture-not-a-real-key-${id}` })
const money = (value: number) => ({ kind: "money" as const, value, currency: "USD", provenance: "provider" as const, precision: "exact" as const })
const count = (value: number, unit = "tokens") => ({ kind: "count" as const, value, unit, provenance: "provider" as const, precision: "exact" as const })
const uuid = (profile: number, value: number) => `00000000-0000-4000-8${profile}00-${value.toString().padStart(12, "0")}`
async function seedProfile(profileId: string, displayName: string, isolated: boolean): Promise<void> {
  const profiles = new AuthProfileStore(userDataRoot)
  if (!(await profiles.list()).some(({ id }) => id === profileId)) {
    const access = await profiles.create(profileId, displayName)
    access.close()
  }
  const profileDir = authDir(userDataRoot, profileId)
  const accountLabels = isolated ? ["Isolated Account"] : ["Alpha Exact", "Bravo Included Boundary", "Charlie Paid Boundary", "Delta Partial", "Echo Stale Active", "Foxtrot Stale Expired", "Golf Ledger Incomplete", "Hotel Many Cards"]
  for (const label of accountLabels) await appendCredentialInstance("chatgpt", oauth(label), profileDir, classifySlot)
  if (!isolated) {
    await appendCredentialInstance("opencode_go", oauth("Go Timing Unavailable"), profileDir, classifySlot)
    await appendCredentialInstance("github_copilot", oauth("Copilot Timing Unavailable"), profileDir, classifySlot)
    await appendCredentialInstance("supergrok", oauth("SuperGrok Timing Unavailable"), profileDir, classifySlot)
  }

  await setMeteredCredential("anthropic_api", apiKey("direct-prior"), profileDir, classifySlot)
  const priorDirectLineage = loadAuthStoreWithDiagnostics(profileDir, undefined, classifySlot).credentialLineages.anthropic_api
  if (!priorDirectLineage) throw new Error("missing prior direct lineage")
  await setMeteredCredential("anthropic_api", apiKey("direct-active"), profileDir, classifySlot)
  await setMeteredCredential("openrouter", apiKey("aggregator-active"), profileDir, classifySlot)
  const lineages = loadAuthStoreWithDiagnostics(profileDir, undefined, classifySlot).credentialLineages
  const directLineage = lineages.anthropic_api
  const aggregatorLineage = lineages.openrouter
  if (!directLineage || !aggregatorLineage) throw new Error("missing active metered lineages")

  const usage = createUsageAuthority({ profileDir, profileId, now: () => now })
  const spendSources: readonly SubscriptionUsageSpendSource[] = [
    { kind: "prepaid", availability: "funded", used: money(7), remaining: money(18), limit: money(25) },
    { kind: "automatic-billing", enablement: "enabled", used: money(3), limit: money(50) },
  ]
  const exactMetric = (metricKey: string, label: string, rank: number, usedFraction: number, startMs: number, endMs: number) => ({
    metricKey, label, scope: { kind: "account" as const }, rank, usedFraction, providerStatus: "ok" as const,
    timing: { kind: "exact" as const, startMs, endMs }, allowanceMode: "finite" as const,
  })
  const unavailableMetric = (metricKey: string, label: string, rank: number, usedFraction: number) => ({
    metricKey, label, scope: { kind: "account" as const }, rank, usedFraction, providerStatus: "warning" as const,
    timing: { kind: "unavailable" as const, resetId: "provider-relative-cycle", resetAtMs: now + 6 * hour }, allowanceMode: "unclassified" as const,
  })
  const report = (providerId: string, label: string, metrics: SubscriptionUsageReport["metrics"], observedAtMs = now): SubscriptionUsageReport => ({
    providerId, instanceId: label, identity: `${label}@invalid.example`, label,
    plan: isolated ? "Isolated Fixture" : "Usage Fixture", tier: "Acceptance", providerStatus: "ok", observedAtMs,
    spendSources, metrics,
  })
  for (const [index, label] of accountLabels.entries()) {
    const activeStart = now - 3 * day
    const activeEnd = now + 4 * day
    const metrics = [
      exactMetric("chatgpt:weekly", "Weekly quota", 0, 0.18 + index * 0.07, activeStart, activeEnd),
      exactMetric("chatgpt:expired", "Prior quota (expired)", 1, 0.97, now - 14 * day, now - 7 * day),
      { metricKey: "chatgpt:tokens", label: "Provider tokens", scope: { kind: "account" }, rank: 2, timing: { kind: "unavailable" }, used: count(12_345 + index), limit: count(50_000), providerStatus: "ok" },
      exactMetric("chatgpt:spark:weekly", "Spark weekly", 3, 0.42, activeStart, activeEnd),
    ] satisfies SubscriptionUsageReport["metrics"]
    usage.record(report("chatgpt", label, metrics))
  }
  if (!isolated) {
    usage.record(report("opencode_go", "Go Timing Unavailable", [unavailableMetric("go:rolling", "Go rolling", 0, 0.31)]))
    usage.record(report("github_copilot", "Copilot Timing Unavailable", [unavailableMetric("copilot:premium_interactions", "Premium interactions", 0, 0.63)]))
    usage.record(report("supergrok", "SuperGrok Timing Unavailable", [unavailableMetric("supergrok:rolling", "SuperGrok rolling", 0, 0.74)]))
  }

  const models = isolated ? ["isolated-model"] : ["claude-sonnet-4", "claude-opus-4", "gpt-5", "gpt-5-mini", "gemini-2.5-pro", "deepseek-r1", "qwen-max", "unknown-price-model"]
  let attempt = isolated ? 500 : 1
  const append = (input: Omit<MeasuredUsageEntry, "attemptId" | "occurredAt" | "profileId" | "currency" | "coverage" | "tokens"> & { tokens?: MeasuredUsageEntry["tokens"] }) => usage.append({
    ...input, attemptId: uuid(isolated ? 2 : 1, attempt++), occurredAt: new Date(now - attempt * 5_000).toISOString(), profileId, currency: "USD", coverage: "complete",
    tokens: input.tokens ?? { input: 1000 + attempt, output: 200 + attempt, cacheRead: 50, cacheWrite: 25, reasoning: 10 },
  })
  for (const [index, model] of models.entries()) {
    append({ attribution: { kind: "candidate", providerId: "anthropic_api" }, spendMode: "direct_api", credentialLineage: directLineage, model, classification: "real_spend", price: model === "unknown-price-model" ? { kind: "unavailable", reason: "fixture has no rate card" } : { kind: "priced", estimatedUsd: 0.25 + index / 10, rateCard: { inputPerMillionUsd: 3 }, provenance: "fixture" } })
  }
  append({ attribution: { kind: "candidate", providerId: "openrouter" }, spendMode: "aggregator", credentialLineage: aggregatorLineage, model: "aggregator/failover-model", classification: "real_spend", price: { kind: "priced", estimatedUsd: 1.5, rateCard: { inputPerMillionUsd: 2 }, provenance: "fixture" } })
  append({ attribution: { kind: "candidate", providerId: "anthropic_api" }, spendMode: "direct_api", credentialLineage: priorDirectLineage, model: "retired-lineage-model", classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.75, rateCard: { inputPerMillionUsd: 3 }, provenance: "fixture" } })
  if (!isolated) {
    append({ attribution: { kind: "candidate", providerId: "chatgpt", instanceId: "Alpha Exact" }, spendMode: "included", credentialLineage: uuid(1, 900), model: "gpt-5-codex", classification: "subscription_equivalent", tokens: { input: 12_345, output: 2_345, cacheRead: 345, cacheWrite: 45, reasoning: 678 }, price: { kind: "priced", estimatedUsd: 0.9, rateCard: { inputPerMillionUsd: 4 }, provenance: "fixture" } })
    append({ attribution: { kind: "candidate", providerId: "chatgpt", instanceId: "Bravo Included Boundary" }, spendMode: "included", credentialLineage: uuid(1, 901), model: "included-boundary-model", classification: "subscription_equivalent", price: { kind: "priced", estimatedUsd: 1.25, rateCard: { inputPerMillionUsd: 4 }, provenance: "fixture" } })
    append({ attribution: { kind: "candidate", providerId: "chatgpt", instanceId: "Charlie Paid Boundary" }, spendMode: "automatic", credentialLineage: uuid(1, 902), model: "paid-boundary-model", classification: "real_spend", price: { kind: "priced", estimatedUsd: 2.5, rateCard: { inputPerMillionUsd: 4 }, provenance: "fixture" } })
  }
  usage.dispose()
}

await seedProfile("usage-primary", "Usage Primary", false)
await seedProfile("usage-isolated", "Usage Isolated", true)
await new AuthProfileStore(userDataRoot).writeStickyProfile("usage-primary")

const eventStore = createSqliteEventStore(workspace.dbFile)
try {
  const sessionId = "usage-incomplete-fixture"
  const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store: eventStore })
  await manager.createChat({ id: sessionId, conversationId: "usage-incomplete-conversation", name: "Usage Incomplete", executionCwd: projectRoot, initialState: "inactive", authProfileId: "usage-primary" })
  const profileDir = authDir(userDataRoot, "usage-primary")
  const lineage = loadAuthStoreWithDiagnostics(profileDir, undefined, classifySlot).credentialLineages.anthropic_api
  if (!lineage) throw new Error("missing incomplete lineage")
  eventStore.putInFlight(sessionId, "usage.settlement", uuid(1, 999), {
    entry: { attemptId: uuid(1, 999), occurredAt: new Date(now).toISOString(), profileId: "usage-primary", currency: "USD", coverage: "complete", attribution: { kind: "candidate", providerId: "anthropic_api" }, spendMode: "direct_api", credentialLineage: lineage, model: "unsettled-model", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "unavailable", reason: "settlement interrupted" } },
    budgetStreamId: "usage-fixture", requestId: "usage-fixture-request", identity: { providerSessionKey: "usage-fixture", conversationId: "usage-incomplete-conversation" }, turn: 1,
  })
} finally {
  eventStore.close()
  workspace.generation.release()
}

console.log("Seeded two isolated Usage profiles with exact and unavailable quota windows, included and paid boundaries, partial tracking, stale active and expired windows, incomplete ledger state, many cards, and detail metrics. No provider or model request was issued.")
