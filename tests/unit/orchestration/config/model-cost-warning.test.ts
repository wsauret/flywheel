import { parseSchema } from "../../../helpers/schema-assertions.js";
import { describe, expect, test } from "bun:test";
import { listModelOptionsForSlot } from "../../../../src/orchestration/config/model-assignments.js";
import { FlywheelConfigSchema } from "../../../../src/orchestration/config/schema.js";
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js";
import { fakeListingClient } from "../../../helpers/fake-listing-client.js";
import { USER_DATA_ROOT, NO_CREDENTIALS } from "./_config-models-fixtures.js";
import type { SelectedModelRoute } from "../../../../src/orchestration/config/model-assignment-types.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { testProviderSelection } from "../../../helpers/provider-authority.js";

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
describe("model input costs", () => {
  test("keeps an unpriced runnable route unranked with no displayed zero cost", async () => {
    const config = parseSchema(FlywheelConfigSchema, { profiles: { default: { roles: { "chat": { model: "gpt-new", effort: "medium" } } } } });
    const base = fakeModelsClient.modelInfos.get("gpt-5.5")!;
    const unpriced = {
      ...base,
      id: "gpt-new",
      name: "gpt-new",
      cost: { input: 0, output: 0 },
      pricing: { status: "unavailable", reason: "missing-rate-card" } as const,
    };
    const rows = await listModelOptionsForSlot(roleSlot("chat"), {
      userDataRoot: USER_DATA_ROOT,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules(),
      config,
      authProfileId: () => "default",
      availableModels: new Map([["openai", new Set(["gpt-new", "gpt-5.5"])]]),
      providerModelEligibility: () => new Map(["gpt-new", "gpt-5.5"].map((model) => [model, {
        explicitlyEnabled: false,
        transport: "openai-responses" as const,
        offering: { candidate: { kind: "singleton" as const, providerId: "openai_api", spendMode: "direct_api" as const }, wireModelId: model, dataUse: "standard" as const },
      }])),
      selectedModelRoutes: new Map([["gpt-new", { wireModelId: "gpt-new", providerHint: "openai", dataUse: "standard", providers: [], metadata: unpriced }]]),
      modelsClient: fakeModelsClient,
      modelInfos: new Map([["gpt-new", unpriced], ["gpt-5.5", base]]),
    });
    expect(rows.find((row) => row.model === "gpt-new")).toMatchObject({ selectable: true });
    expect(rows.find((row) => row.model === "gpt-new")).not.toHaveProperty("tier");
    expect(rows.find((row) => row.model === "gpt-new")).not.toHaveProperty("cost");
  });
  test("includes input cost for model assignment options", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: { default: { roles: { "chat": { model: "gpt-5.5", effort: "medium" } } } },
    });

    const rows = await listModelOptionsForSlot(
      roleSlot("chat"),
      {
        userDataRoot: USER_DATA_ROOT,
        authDirectory: () => NO_CREDENTIALS,
        resolveKey: async () => undefined,
        moduleSelection: () => composeFirstPartyModules(),
        config,
        authProfileId: () => "default",
        availableModels: new Map([["openai", new Set(["gpt-5.5", "gpt-5.5-pro"])]] as const),
        providerModelCatalogs: () => new Map([["openai_api", {
          catalog: new Set(["gpt-5.5", "gpt-5.5-pro"]),
          curatedDefault: new Set(["gpt-5.5", "gpt-5.5-pro"]),
          enabled: new Set<string>(),
          disabled: new Set<string>(),
          effective: new Set(["gpt-5.5", "gpt-5.5-pro"]),
        }]]),
        providerModelEligibility: () => new Map(["gpt-5.5", "gpt-5.5-pro"].map((model) => [model, {
          explicitlyEnabled: false,
          transport: "openai-responses",
          offering: { candidate: { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }, wireModelId: model, dataUse: "standard" },
        }] as const)),
        listingClient: fakeListingClient(new Map([["openai", new Set(["gpt-5.5", "gpt-5.5-pro"])]] as const)),
        modelsClient: fakeModelsClient,
        modelInfos: fakeModelsClient.modelInfos,
      },
    );

    expect(rows.map((row) => row.model)).toEqual(["gpt-5.5", "gpt-5.5-pro"]);
    expect(rows.find((row) => row.model === "gpt-5.5")).toMatchObject({
      efforts: ["low", "medium", "high"],
      effort: "medium",
      cost: { input: 5, output: 30 },
    });
    expect(rows.find((row) => row.model === "gpt-5.5-pro")).toMatchObject({
      efforts: ["low", "medium", "high"],
      effort: "medium",
      cost: { input: 30, output: 180 },
    });
  });

  test("derives grouped row metadata from the selected exact route once", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: { default: { roles: { "chat": { model: "gpt-5.5", effort: "medium" } } } },
    });
    const reads: string[] = [];
    const selectedModelRoutes = new Map<string, SelectedModelRoute>([
      ["gpt-5.5", {
        wireModelId: "muse-1-free", providerHint: "gateway", dataUse: "contributor", providers: [],
        metadata: { ...fakeModelsClient.modelInfos.get("gpt-5.5")!, id: "muse-1-free", provider: "gateway", cost: { input: 0.4, output: 2, cacheRead: 0.1 } },
      }],
      ["gpt-5.5-pro", {
        wireModelId: "muse-2", providerHint: "openrouter", dataUse: "standard", providers: [],
        metadata: { ...fakeModelsClient.modelInfos.get("gpt-5.5-pro")!, id: "muse-2", provider: "openrouter", cost: { input: 2, output: 2, cacheRead: 0.1 } },
      }],
    ]);
    const modelsClient = {
      ...fakeModelsClient,
      getProviderCatalog(providerIds: readonly string[]) {
        reads.push(`batch:${providerIds.length}`);
        const base = fakeModelsClient.modelInfos.get("gpt-5.5");
        if (!base) throw new Error("model fixture is unavailable");
        return providerIds.map((providerId) => {
          const modelId = providerId === "gateway" ? "muse-1-free" : "muse-2";
          return {
            providerId,
            providerName: providerId,
            wireModelId: modelId,
            metadata: { ...base, id: modelId, provider: providerId, cost: { input: modelId === "muse-1-free" ? 0.4 : 2, output: 2, cacheRead: 0.1 } },
            provenance: "bundled" as const,
            canonical: null,
            transport: null,
          };
        });
      },
    };

    const rows = await listModelOptionsForSlot(roleSlot("chat"), {
      userDataRoot: USER_DATA_ROOT,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules(),
      config,
      authProfileId: () => "default",
      availableModels: new Map([["openai", new Set(["gpt-5.5", "gpt-5.5-pro"])]]),
      providerModelEligibility: () => new Map([["gpt-5.5", {
        explicitlyEnabled: false,
        transport: "openai-completions",
        catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
        offering: {
          candidate: { kind: "subscription", providerId: "opencode_go", instanceId: "account", spendMode: "included" },
          wireModelId: "muse-1-free",
          dataUse: "contributor",
        },
      }], ["gpt-5.5-pro", {
        explicitlyEnabled: false,
        transport: "openai-completions",
        catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
        offering: {
          candidate: { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" },
          wireModelId: "muse-2",
          dataUse: "standard",
        },
      }]]),
      selectedModelRoutes,
      modelsClient,
      modelInfos: new Map([
        ["gpt-5.5", { ...fakeModelsClient.modelInfos.get("gpt-5.5")!, id: "muse-1-free", provider: "gateway", cost: { input: 0.4, output: 2, cacheRead: 0.1 } }],
        ["gpt-5.5-pro", { ...fakeModelsClient.modelInfos.get("gpt-5.5")!, id: "muse-2", provider: "openrouter", cost: { input: 2, output: 2, cacheRead: 0.1 } }],
      ]),
    });

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.model === "gpt-5.5")).toMatchObject({ tier: "cheap", cost: { input: 0.4, output: 2, cacheRead: 0.1 } });
    expect(rows.find((row) => row.model === "gpt-5.5-pro")).toMatchObject({ tier: "mid", cost: { input: 2, output: 2, cacheRead: 0.1 } });
    expect(reads).toEqual([]);
  });

  test("keeps direct Anthropic and OpenAI prices on selected routes", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: { default: { roles: { "chat": { model: "gpt-5.5", effort: "medium" } } } },
    });
    const selection = testProviderSelection();
    const selectedModelRoutes = new Map<string, SelectedModelRoute>([
      ["claude-opus-4.6", {
        wireModelId: "claude-opus-4-6",
        providerHint: selection.catalogId("anthropic_api") ?? "anthropic_api",
        dataUse: "standard",
        providers: [],
        metadata: fakeModelsClient.modelInfos.get("claude-opus-4.6"),
      }],
      ["gpt-5.5", {
        wireModelId: "gpt-5.5",
        providerHint: selection.catalogId("openai_api") ?? "openai_api",
        dataUse: "standard",
        providers: [],
        metadata: fakeModelsClient.modelInfos.get("gpt-5.5"),
      }],
    ]);

    const rows = await listModelOptionsForSlot(roleSlot("chat"), {
      userDataRoot: USER_DATA_ROOT,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules(),
      config,
      authProfileId: () => "default",
      availableModels: new Map([
        ["anthropic", new Set(["claude-opus-4.6"])],
        ["openai", new Set(["gpt-5.5"])],
      ]),
      providerModelEligibility: () => new Map([
        ["claude-opus-4.6", {
          explicitlyEnabled: false,
          transport: "anthropic-messages",
          offering: {
            candidate: { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" },
            wireModelId: "claude-opus-4-6",
            dataUse: "standard",
          },
        }],
        ["gpt-5.5", {
          explicitlyEnabled: false,
          transport: "openai-responses",
          offering: {
            candidate: { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" },
            wireModelId: "gpt-5.5",
            dataUse: "standard",
          },
        }],
      ]),
      selectedModelRoutes,
      modelsClient: fakeModelsClient,
      modelInfos: new Map([
        ...fakeModelsClient.modelInfos,
        ["claude-opus-4-6", fakeModelsClient.modelInfos.get("claude-opus-4.6")!],
      ]),
    });

    expect(rows.find((row) => row.model === "claude-opus-4.6")).toMatchObject({ cost: { input: 5, output: 25 } });
    expect(rows.find((row) => row.model === "gpt-5.5")).toMatchObject({ cost: { input: 5, output: 30 } });
  });
});
