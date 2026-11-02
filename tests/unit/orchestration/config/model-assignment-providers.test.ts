import { describe, expect, test } from "bun:test"
import { authDir } from "../../../../src/infra/paths.js"
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js"
import type { CatalogModelOffering } from "../../../../src/infra/llm/model-catalog-resolution.js"
import { resolveProviderModelCatalog } from "../../../../src/orchestration/config/model-assignment-providers.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { testDirectories } from "../../../helpers/directories.js"
import { modelInfo } from "../../../helpers/model-tier-fixtures.js"

const DIRECTORIES = testDirectories(process.cwd())
const PROFILE = { id: "work", directory: authDir(DIRECTORIES.userDataRoot, "work") }

describe("provider model catalog resolution", () => {
  test("keeps models.dev membership separate from an auth-rejected exact connection", async () => {
    const candidate = { kind: "subscription", providerId: "github_copilot", instanceId: "rejected", spendMode: "included" } as const
    const metadata = modelInfo("openai", "gpt-6.1-sol", "gpt-sol", 1, 2, "2025-01-01")
    const resolved = await resolveProviderModelCatalog({
      userDataRoot: DIRECTORIES.userDataRoot,
      authDirectory: () => PROFILE.directory,
      moduleSelection: composeFirstPartyModules,
      auth: testAuthContext(),
      listingClient: {
        recordModelRefusal: async () => false,
        async getModelCatalogs() {
          return {
            providers: new Map(),
            candidates: new Map([[accessProviderAccountKey(candidate), {
              candidate,
              models: null,
              visibleModels: new Map([["gpt-6.1-sol", [{
                wireModelId: "gpt-6.1-sol",
                metadata: { releaseDate: "2025-01-01" },
                dataUse: "standard",
                resolvedMetadata: metadata,
                transport: "openai-responses",
              }]]]),
              outcome: { kind: "unavailable", reason: "authentication-invalid" },
            }]]),
          }
        },
      },
    })

    expect(resolved.accounts.get(accessProviderAccountKey(candidate))?.catalog).toEqual(new Set(["gpt-6.1-sol"]))
    expect(resolved.inventoryCandidates.get(accessProviderAccountKey(candidate))).toEqual(expect.objectContaining({
      configured: true,
      currentConnection: false,
      enabledOfferings: null,
      inventoryOfferings: new Map([["gpt-6.1-sol", [expect.objectContaining({ wireModelId: "gpt-6.1-sol" })]]]),
    }))
    expect(resolved.enabledModels.get("openai")?.has("gpt-6.1-sol") ?? false).toBe(false)
    expect(resolved.modelInfos.has("gpt-6.1-sol")).toBe(false)
    expect(resolved.providers.get("github_copilot")?.effective.has("gpt-6.1-sol") ?? false).toBe(false)
  })

  test("uses one canonical provider catalog for controls and runtime eligibility", async () => {
    const candidate = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" } as const
    const eligible = new Map<string, readonly CatalogModelOffering[]>([["gpt-6.1-sol", [{
      wireModelId: "openai/gpt-6.1-sol",
      metadata: null,
      dataUse: "standard" as const,
      transport: "openai-completions" as const,
      resolvedMetadata: modelInfo("openai", "gpt-6.1-sol", "gpt-sol", 1, 2, "2025-01-01"),
    }]]])
    const resolved = await resolveProviderModelCatalog({
      userDataRoot: DIRECTORIES.userDataRoot,
      authDirectory: () => PROFILE.directory,
      moduleSelection: composeFirstPartyModules,
      auth: testAuthContext(),
      listingClient: {
        recordModelRefusal: async () => false,
        async getModelCatalogs() {
          return {
            providers: new Map([["openrouter", new Set(["gpt-6.1-sol"])]]),
            candidates: new Map([[accessProviderAccountKey(candidate), {
              candidate,
              models: eligible,
              visibleModels: eligible,
              outcome: { kind: "catalog", provenance: "first-party", liveOutcome: "valid", rows: [] },
            }]]),
          }
        },
      },
    })

    expect(resolved.providers.get("openrouter")?.catalog).toEqual(new Set(["gpt-6.1-sol"]))
    expect(resolved.inventoryCandidates.get(accessProviderAccountKey(candidate))?.inventoryOfferings).toBe(eligible)
    expect(resolved.inventoryCandidates.get(accessProviderAccountKey(candidate))?.enabledOfferings).toEqual(eligible)
  })

  test("does not auto-select pending subscription candidates", async () => {
    const candidate = { kind: "subscription", providerId: "supergrok", instanceId: "primary", spendMode: "included" } as const
    const offering = (id: string): readonly CatalogModelOffering[] => [{
      wireModelId: id,
      metadata: null,
      dataUse: "standard",
      transport: "openai-completions",
      resolvedMetadata: modelInfo("openai", id, id, 1, 2, "2025-01-01"),
    }]
    const verified = new Map([["grok-verified", offering("grok-verified")]])
    const visible = new Map([...verified, ["grok-pending", offering("grok-pending")]])
    const resolved = await resolveProviderModelCatalog({
      userDataRoot: DIRECTORIES.userDataRoot,
      authDirectory: () => PROFILE.directory,
      moduleSelection: composeFirstPartyModules,
      auth: testAuthContext(),
      listingClient: {
        recordModelRefusal: async () => false,
        async getModelCatalogs() {
          return {
            providers: new Map([["supergrok", new Set(visible.keys())]]),
            candidates: new Map([[accessProviderAccountKey(candidate), {
              candidate,
              models: verified,
              visibleModels: visible,
              audit: { remaining: 1, refused: 0 },
              outcome: { kind: "catalog" as const, provenance: "models-dev-bundled" as const, liveOutcome: "valid" as const, rows: [] },
            }]]),
          }
        },
      },
    })
    expect(resolved.accounts.get(accessProviderAccountKey(candidate))?.effective).toEqual(new Set(["grok-verified"]))
    expect(resolved.accounts.get(accessProviderAccountKey(candidate))?.curatedDefault).toEqual(new Set(["grok-verified"]))
    expect(resolved.inventoryCandidates.get(accessProviderAccountKey(candidate))?.inventoryOfferings?.has("grok-pending")).toBe(true)
    expect(resolved.inventoryCandidates.get(accessProviderAccountKey(candidate))?.enabledOfferings?.has("grok-pending")).toBe(false)
  })

  test("lists only routes that are priced and call tools on text", async () => {
    const candidate = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" } as const
    const route = (modelId: string, resolvedMetadata?: ReturnType<typeof modelInfo>): readonly [string, readonly CatalogModelOffering[]] =>
      [modelId, [{ wireModelId: `vendor/${modelId}`, metadata: null, dataUse: "standard", transport: "openai-completions", ...(resolvedMetadata === undefined ? {} : { resolvedMetadata }) }]]
    const unpriced = modelInfo("openai", "unpriced", "unpriced", 1, 2, "2025-01-01")
    const offerings = new Map([
      route("coder", modelInfo("openai", "coder", "coder", 1, 2, "2025-01-01")),
      route("chat-only", modelInfo("openai", "chat-only", "chat-only", 1, 2, "2025-01-01", { toolCall: false })),
      route("painter", modelInfo("openai", "painter", "painter", 1, 2, "2025-01-01", { modalities: { input: ["text"], output: ["image"] } })),
      route("unpriced", { ...unpriced, pricing: { status: "unavailable", reason: "missing-rate-card" } }),
      route("undescribed"),
    ])
    const resolved = await resolveProviderModelCatalog({
      userDataRoot: DIRECTORIES.userDataRoot,
      authDirectory: () => PROFILE.directory,
      moduleSelection: composeFirstPartyModules,
      auth: testAuthContext(),
      listingClient: {
        recordModelRefusal: async () => false,
        async getModelCatalogs() {
          return {
            providers: new Map([["openrouter", new Set(offerings.keys())]]),
            candidates: new Map([[accessProviderAccountKey(candidate), {
              candidate,
              models: offerings,
              visibleModels: offerings,
              outcome: { kind: "catalog", provenance: "first-party", liveOutcome: "valid", rows: [] },
            }]]),
          }
        },
      },
    })

    expect(resolved.providers.get("openrouter")?.catalog).toEqual(new Set(["coder"]))
    expect([...resolved.inventoryCandidates.get(accessProviderAccountKey(candidate))?.inventoryOfferings?.keys() ?? []]).toEqual(["coder"])
    expect([...resolved.modelInfos.keys()]).toEqual(["coder"])
  })

  test("keeps configured accounts without cached catalogs pending instead of throwing", async () => {
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
    const resolved = await resolveProviderModelCatalog({
      userDataRoot: DIRECTORIES.userDataRoot,
      authDirectory: () => PROFILE.directory,
      moduleSelection: composeFirstPartyModules,
      auth: testAuthContext(),
      listingClient: {
        recordModelRefusal: async () => false,
        async getModelCatalogs() {
          return {
            providers: new Map(),
            candidates: new Map([[accessProviderAccountKey(candidate), {
              candidate,
              models: null,
              outcome: { kind: "unavailable", reason: "discovery-pending" },
            }]]),
          }
        },
      },
    })

    expect(resolved.accounts.get(accessProviderAccountKey(candidate))?.catalog).toEqual(new Set())
    expect(resolved.inventoryCandidates.get(accessProviderAccountKey(candidate))).toEqual(expect.objectContaining({
      enabledOfferings: null,
      inventoryOfferings: null,
    }))
  })
})
