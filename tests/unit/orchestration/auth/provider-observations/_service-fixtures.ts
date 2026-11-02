import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AccessProviderDefinition } from "../../../../../src/infra/llm/access-provider.js"
import { composeModules } from "../../../../../src/infra/module-descriptor.js"
import type { SubscriptionUsageReader, SubscriptionUsageResetConsumer } from "../../../../../src/infra/llm/subscription-usage.js"

import { accessProviderRegistry, type AccessProviderRegistry } from "../../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
import type { AccessProviderFactory } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import type { FirstPartyModule } from "../../../../../src/orchestration/modules.js"
/** Creates isolated profiles. Each test file must register cleanup in its own afterEach hook. */
export function createProfileFixture() {
  const roots: string[] = []
  return {
    /** A profile directory inside its own temporary root. The auth store
     *  keeps `profile-locks` beside a profile, so a profile made directly in
     *  TMPDIR would leave that directory behind in TMPDIR. */
    profile(name: string): string {
      const root = mkdtempSync(join(realpathSync(tmpdir()), `flywheel-subscription-usage-${name}-`))
      roots.push(root)
      const profile = join(root, "profile")
      mkdirSync(profile)
      return profile
    },
    cleanup(): void {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    },
  }
}

export function definition(id: string): AccessProviderDefinition {
  return {
    id,
    displayName: id,
    shortName: id,
    billing: "subscription",
    paidModes: ["prepaid", "automatic"],
    rank: 1,
    supportedFamilies: ["openai"],
    configHints: [],
    catalogId: undefined,
    auth: { kind: "oauth", credentialId: id, flow: "device-code", statusRank: 1, start: async () => { throw new Error("test provider has no login") } },
    cli: { name: "test" },
    staticModelUnavailableReason: () => undefined,
  }
}

export function registry(definitions: readonly AccessProviderDefinition[], readers: ReadonlyMap<string, SubscriptionUsageReader>, resetConsumers: ReadonlyMap<string, SubscriptionUsageResetConsumer> = new Map()): AccessProviderRegistry {
  const createClient: AccessProviderFactory = async () => { throw new Error("test provider has no client") }
  const modules: FirstPartyModule[] = definitions.map((provider, index) => ({
    id: `test-provider-${index}`,
    dependencies: [],
    availability: { kind: "available" },
    contributions: [{
      domain: "providers",
      id: provider.id,
      value: {
        definition: provider,
        createClient,
        ...(readers.get(provider.id) ? { usageReader: readers.get(provider.id) } : {}),
        ...(resetConsumers.get(provider.id) ? { resetConsumer: resetConsumers.get(provider.id) } : {}),
      },
    }],
    observers: [],
    transformers: [],
    gates: [],
  } satisfies FirstPartyModule))
  const composition = composeModules(modules)
  return accessProviderRegistry(composition)
}

export function writeAccounts(directory: string, definitions: readonly AccessProviderDefinition[], access = "access"): void {
  writeFileSync(join(directory, "auth.json"), JSON.stringify(Object.fromEntries(definitions.map((entry) => [entry.id, [{
    id: "account",
    identity: `${entry.id}-identity`,
    lineageId: "11111111-1111-4111-8111-111111111111",
    credential: { type: "oauth", access, refresh: `${entry.id}-refresh`, expires: 9_999_999_999 },
  }]]))))
}

export function report(providerId: string, observedAtMs: number) {
  return {
    providerId,
    instanceId: "account",
    identity: `${providerId}-identity`,
    providerStatus: "ok" as const,
    observedAtMs,
    metrics: [{ metricKey: "remaining", label: "Remaining", scope: { kind: "account" as const }, rank: 0, timing: { kind: "exact" as const, startMs: 1, endMs: 20_000 }, remaining: { kind: "count" as const, value: 4, unit: "requests", provenance: "provider" as const, precision: "exact" as const }, limit: { kind: "count" as const, value: 10, unit: "requests", provenance: "provider" as const, precision: "exact" as const }, usedFraction: 0.6 }],
  }
}

export function readerFor(kind: "supported" | "identity-unavailable" | "expired-auth" | "failure"): SubscriptionUsageReader {
  return async () => {
    if (kind === "supported") return { kind: "success", report: report("supported", 10_000) }
    if (kind === "identity-unavailable") return { kind }
    if (kind === "expired-auth") return { kind }
    return { kind: "fetch-failure" }
  }
}
