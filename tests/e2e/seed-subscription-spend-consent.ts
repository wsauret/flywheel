import { dirname } from "node:path"
import { AuthProfileStore } from "../../src/infra/auth/auth-profile-store.js"
import { createSubscriptionSpendConsentStore } from "../../src/infra/auth/subscription-spend-consent-store.js"
import { createSubscriptionSpendEnvelope, type SubscriptionSpendMode } from "../../src/infra/auth/subscription-spend-consent.js"
import { appendCredentialInstance } from "../../src/infra/auth/auth-store-mutations.js"
import { createUsageAuthority } from "../../src/infra/llm/usage-authority.js"
import type { SubscriptionUsageReport, SubscriptionUsageSpendSource } from "../../src/infra/llm/subscription-usage.js"
import { createSubscriptionAccountIdentity } from "../../src/infra/llm/subscription-account-identity.js"
import { authDir } from "../../src/infra/paths.js"

const userDataRoot = process.argv[2]
if (!userDataRoot) throw new Error("usage: seed-subscription-spend-consent.ts <user-data-root> [--consent=unreviewed|accepted|declined] [--single] [--append-sibling] [--prepaid-only] [--accepted-unavailable] [--scenario-control=<path>]")

const option = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const has = (name: string) => process.argv.includes(`--${name}`)
const profileId = "acceptance"
const profileDir = authDir(userDataRoot, profileId)
const now = Date.now()
const money = (value: number) => ({ kind: "money" as const, value, currency: "USD", provenance: "provider" as const, precision: "exact" as const })
const oauth = (id: string) => ({ id, identity: `${id}@invalid.example`, label: id, credential: { type: "oauth" as const, access: `fixture-${id}`, refresh: `fixture-refresh-${id}`, expires: Date.parse("2099-01-01T00:00:00.000Z") } })
const classifyCredentialSlot = () => "subscription" as const

const profiles = new AuthProfileStore(userDataRoot)
const profileExists = (await profiles.list()).some((profile) => profile.id === profileId)
if (!profileExists) {
  const access = await profiles.create(profileId, "Subscription Spend Consent")
  access.close()
  await appendCredentialInstance("supergrok", oauth("Exact"), profileDir, classifyCredentialSlot)
}
if (has("append-sibling")) await appendCredentialInstance("supergrok", oauth("Sibling"), profileDir, classifyCredentialSlot)
await profiles.writeStickyProfile(profileId)

const accounts = has("append-sibling") ? ["Exact", "Sibling"] : ["Exact"]
const spendSources = (label: string): readonly SubscriptionUsageSpendSource[] => {
  if (has("accepted-unavailable")) return [{ kind: "prepaid", availability: "empty" }, { kind: "automatic-billing", enablement: "disabled" }]
  if (has("prepaid-only")) return [{ kind: "prepaid", availability: "funded", remaining: money(25), used: money(5), limit: money(30) }]
  return [
    { kind: "prepaid", availability: "funded", remaining: money(label === "Sibling" ? 15 : 25), used: money(5), limit: money(label === "Sibling" ? 20 : 30) },
    { kind: "automatic-billing", enablement: label === "Sibling" ? "disabled" : "enabled", ...(label === "Sibling" ? {} : { used: money(2.5), limit: money(50) }) },
  ]
}
const report = (label: string): SubscriptionUsageReport => ({
  providerId: "supergrok",
  instanceId: label,
  identity: `${label}@invalid.example`,
  label,
  plan: "Acceptance",
  tier: "Fixture",
  providerStatus: "ok",
  observedAtMs: now,
  spendSources: spendSources(label),
  metrics: [
    { metricKey: "primary_window", label: "Primary Window", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable", resetId: "acceptance-cycle", resetAtMs: now + 12 * 60 * 60_000 }, usedFraction: label === "Sibling" ? 0.3 : 0.45, providerStatus: "ok" },
    { metricKey: "weekly_window", label: "Weekly Window", scope: { kind: "account" }, rank: 1, timing: { kind: "unavailable" }, usedFraction: 0.25, providerStatus: "ok" },
    { metricKey: "monthly_window", label: "Monthly Window", scope: { kind: "account" }, rank: 2, timing: { kind: "unavailable" }, usedFraction: 0.4, providerStatus: "ok" },
  ],
})

const usage = createUsageAuthority({ profileDir, profileId, now: () => now })
try {
  for (const label of accounts) usage.record(report(label))
} finally {
  usage.dispose()
}

const variant = has("accepted-unavailable") ? "unavailable" : has("prepaid-only") ? "prepaid" : "automatic"
await Bun.write(option("scenario-control") ?? `${dirname(userDataRoot)}/subscription-consent-response.json`, JSON.stringify({ variant }))

const consent = option("consent")
if (consent && consent !== "unreviewed") {
  const access = await profiles.open(profileId)
  if (!access) throw new Error(`auth profile not found: ${profileId}`)
  try {
    const modes: SubscriptionSpendMode[] = has("prepaid-only") ? ["prepaid"] : ["prepaid", "automatic"]
    const identities = accounts.map((label) => createSubscriptionAccountIdentity("supergrok", label, `${label}@invalid.example`))
    const envelopes = identities.flatMap((identity) => modes.map((mode) => createSubscriptionSpendEnvelope(profileId, identity, mode)))
    const store = createSubscriptionSpendConsentStore({ profileId, access, currentAccounts: () => identities })
    const snapshot = await store.read(envelopes)
    await store.save({
      expectedIncarnation: snapshot.incarnation,
      expectedRevision: snapshot.revision,
      envelopes,
      reviewedEnvelopeIds: envelopes.map(({ id }) => id),
      acceptedEnvelopeIds: consent === "accepted" ? envelopes.map(({ id }) => id) : [],
    })
  } finally {
    access.close()
  }
}

console.log(`Seeded ${accounts.length} subscription consent account${accounts.length === 1 ? "" : "s"}; no model request, purchase, billing toggle, or paid provider call was issued.`)
