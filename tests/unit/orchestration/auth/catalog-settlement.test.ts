import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import type { AuthContext, CapturedSubscriptionCredential } from "../../../../src/infra/auth/auth-context.js"
import type { resolveProviderModelCatalog } from "../../../../src/orchestration/config/model-assignment-providers.js"
import { createCatalogSettlement } from "../../../../src/orchestration/auth/catalog-settlement.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js"
import type { ResolvedProviderModels } from "../../../../src/infra/llm/provider-model-preferences.js"
import { testAuthContext } from "../../../helpers/auth-context.js"

const account = { kind: "subscription", providerId: "github_copilot", instanceId: "exact", spendMode: "included" } as const
const models: ResolvedProviderModels = { catalog: new Set(["gpt-5"]), curatedDefault: new Set(["gpt-5"]), enabled: new Set(), disabled: new Set(), effective: new Set(["gpt-5"]) }

describe("catalog settlement", () => {
  test("accepts a usable exact-account inventory when every model is deselected", async () => {
    const settle = createCatalogSettlement({
      userDataRoot: "/scratch/catalog-settlement",
      resolveKey: async () => Redacted.make("key"),
      moduleSelection: composeFirstPartyModules,
      resolveAuth: async () => testAuthContext(),
      resolveCatalog: async () => ({
        providers: new Map([["github_copilot", models]]),
        accounts: new Map([[accessProviderAccountKey(account), models]]),
        inventoryCandidates: new Map([[accessProviderAccountKey(account), {
          candidate: account,
          configured: true,
          currentConnection: true,
          enabledOfferings: new Map(),
          inventoryOfferings: new Map([["gpt-5", []]]),
          outcome: { kind: "catalog", rows: [], provenance: "first-party", liveOutcome: "valid" },
        }]]),
        modelInfos: new Map(),
        enabledModels: new Map(),
      }),
    })

    await expect(settle(account, "/scratch/auth")).resolves.toBeUndefined()
  })

  test("requires the canonical exact account to be configured, current, and catalog-available", async () => {
    const settle = createCatalogSettlement({
      userDataRoot: "/scratch/catalog-settlement",
      resolveKey: async () => Redacted.make("key"),
      moduleSelection: composeFirstPartyModules,
      resolveAuth: async () => testAuthContext(),
      resolveCatalog: async () => ({
        providers: new Map([["github_copilot", models]]),
        accounts: new Map([[accessProviderAccountKey(account), models]]),
        inventoryCandidates: new Map([[accessProviderAccountKey(account), {
          candidate: account,
          configured: true,
          currentConnection: false,
          enabledOfferings: null,
          inventoryOfferings: new Map(),
          outcome: { kind: "unavailable", reason: "authentication-invalid" },
        }]]),
        modelInfos: new Map(),
        enabledModels: new Map(),
      }),
    })

    await expect(settle(account, "/scratch/auth")).rejects.toThrow("No usable model catalog")
  })

  // A listing contacts every provider its context names and can refresh an
  // expired OAuth token, so a login must not list the accounts it did not touch.
  test("lists only the account that logged in and writes no model preferences", async () => {
    const oauth = (instanceId: string): CapturedSubscriptionCredential => ({ instanceId, credential: { type: "oauth", access: Redacted.make("access"), refresh: Redacted.make("refresh"), expires: 0 } })
    const profile: AuthContext = {
      ...testAuthContext({ oauth: ["github_copilot", "supergrok"], apiKeys: { openai_api: "sk-openai" } }),
      subscriptionCredentials: new Map([["github_copilot", [oauth("exact"), oauth("other")]], ["supergrok", [oauth("grok")]]]),
    }
    const authRequests: Array<readonly string[] | undefined> = []
    const listed: Array<Parameters<typeof resolveProviderModelCatalog>[0]> = []
    const settle = createCatalogSettlement({
      userDataRoot: "/scratch/catalog-settlement",
      resolveKey: async () => Redacted.make("key"),
      moduleSelection: composeFirstPartyModules,
      resolveAuth: async (request) => {
        authRequests.push(request.definitions?.map((definition) => definition.id))
        return profile
      },
      resolveCatalog: async (deps) => {
        listed.push(deps)
        return {
          providers: new Map([["github_copilot", models]]),
          accounts: new Map([[accessProviderAccountKey(account), models]]),
          inventoryCandidates: new Map([[accessProviderAccountKey(account), {
            candidate: account,
            configured: true,
            currentConnection: true,
            enabledOfferings: new Map(),
            inventoryOfferings: new Map([["gpt-5", []]]),
            outcome: { kind: "catalog", rows: [], provenance: "first-party", liveOutcome: "valid" },
          }]]),
          modelInfos: new Map(),
          enabledModels: new Map(),
        }
      },
    })

    await settle(account, "/scratch/auth")

    expect(authRequests).toEqual([["github_copilot"]])
    expect(listed).toHaveLength(1)
    const [deps] = listed
    expect([...(deps?.auth.providers.keys() ?? [])]).toEqual(["github_copilot"])
    expect([...(deps?.auth.subscriptionCredentials ?? [])].map(([providerId, instances]) => [providerId, instances.map((instance) => instance.instanceId)])).toEqual([["github_copilot", ["exact"]]])
    expect(deps?.preferencePersistence).toBe("read-only")
  })
})
