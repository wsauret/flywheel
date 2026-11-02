import { parseSchema } from "../../../helpers/schema-assertions.js";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { RuntimeModelOptionRowSchema } from "../../../../src/protocol/model-assignment-protocol-schemas.js";
import type { AuthContext } from "../../../../src/infra/auth/auth-context.js";
import { accessProviderAccountKey, type AccessProviderId } from "../../../../src/infra/llm/access-provider.js";
import { detectModelFamily, type ModelFamily } from "../../../../src/infra/llm/model-family.js";
import type { ModelListingClient } from "../../../../src/infra/llm/model-listing.js";
import { canonicalModelId } from "../../../../src/infra/llm/model-id.js";
import { listModelOptionsForSlot } from "../../../../src/orchestration/config/model-assignments.js";
import { FlywheelConfigSchema, type FlywheelConfig } from "../../../../src/orchestration/config/schema.js";
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js";
import { USER_DATA_ROOT, NO_CREDENTIALS } from "./_config-models-fixtures.js";
import { testCapabilityModules } from "../../../helpers/provider-authority.js";

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { authProviders } from "../../../helpers/auth-context.js";
const resolveKey = async () => undefined;
const profileConfig = (roles: FlywheelConfig["profiles"][string]["roles"]) => parseSchema(FlywheelConfigSchema, { profiles: { personal: { roles } } });

const OPENAI_WITHOUT_COPILOT: AuthContext = {
  providers: authProviders({ apiKeys: { openai_api: "sk-test" } }),
  credentialLineages: {}, droppedCredentials: [],
};

const OPENAI_WITH_COPILOT: AuthContext = {
  ...OPENAI_WITHOUT_COPILOT,
  providers: authProviders({ base: OPENAI_WITHOUT_COPILOT.providers, oauth: ["github_copilot"] }),
};

function fakeProviderListing(
  providerModels: ReadonlyMap<AccessProviderId, ReadonlySet<string>>,
): ModelListingClient {
  const canonical = canonicalProviderModels(providerModels);
  return {
    getModelCatalogs: async () => ({ providers: canonical, candidates: new Map() }),
    recordModelRefusal: async () => false,
  };
}

function canonicalProviderModels(providerModels: ReadonlyMap<AccessProviderId, ReadonlySet<string>>): Map<AccessProviderId, ReadonlySet<string>> {
  return new Map([...providerModels].map(([provider, models]) => [provider, new Set([...models].map(canonicalModelId))]));
}

function allAvailableModels(
  providerModels: ReadonlyMap<AccessProviderId, ReadonlySet<string>>,
): Map<ModelFamily, ReadonlySet<string>> {
  const byFamily = new Map<ModelFamily, Set<string>>();
  for (const models of providerModels.values()) {
    for (const sourceModel of models) {
      const model = canonicalModelId(sourceModel);
      const family = detectModelFamily(model);
      if (!family) continue;
      const set = byFamily.get(family) ?? new Set<string>();
      set.add(model);
      byFamily.set(family, set);
    }
  }
  return byFamily;
}

function pickerEligibility(providerModels: ReadonlyMap<AccessProviderId, ReadonlySet<string>>) {
  return new Map([...providerModels.entries()].flatMap(([providerId, models]) => [...models].map((sourceModel) => {
    const model = canonicalModelId(sourceModel);
    return [model, {
      explicitlyEnabled: false,
      transport: providerId === "anthropic_api" ? "anthropic-messages" : providerId === "google_api" ? "google" : "openai-responses",
      offering: { candidate: { kind: "singleton", providerId, spendMode: providerId === "openrouter" ? "aggregator" : "direct_api" }, wireModelId: sourceModel, dataUse: "standard" },
    }] as const;
  })));
}

describe("provider-unavailable model rows", () => {
  test("encodes an inheritance row whose parent model is not in the picker catalog", async () => {
    const listed = new Map<AccessProviderId, ReadonlySet<string>>([["openai_api", new Set(["gpt-5.5"])]]);
    const rows = await listModelOptionsForSlot(roleSlot("reviewer-quality"), {
      userDataRoot: USER_DATA_ROOT,
      moduleSelection: testCapabilityModules,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey,
      config: profileConfig({ reviewer: { model: "unlisted-parent-model", effort: "medium" } }),
      authProfileId: () => "personal",
      auth: OPENAI_WITHOUT_COPILOT,
      listingClient: fakeProviderListing(listed),
      availableModels: allAvailableModels(listed),
      modelInfos: fakeModelsClient.modelInfos,
      modelsClient: fakeModelsClient,
      providerModelEligibility: () => pickerEligibility(listed),
    });
    expect(rows[0]?.inherit).toBe(true);
    expect(Schema.decodeUnknownSync(Schema.Array(RuntimeModelOptionRowSchema))(rows)).toHaveLength(rows.length);
  });


  test("resolves one composed catalog for picker eligibility and tiers", async () => {
    const providerModels = new Map<AccessProviderId, ReadonlySet<string>>([
      ["openai_api", new Set(["gpt-5.5"])],
    ]);
    let catalogResolutions = 0;
    const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const;
    const listing = fakeProviderListing(providerModels);
    const config = profileConfig({ chat: { model: "gpt-5.5", effort: "medium" } });

    const rows = await listModelOptionsForSlot(roleSlot("chat"), {
      userDataRoot: USER_DATA_ROOT,
      moduleSelection: testCapabilityModules,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey,
      config,
      authProfileId: () => "personal",
      auth: OPENAI_WITHOUT_COPILOT,
      listingClient: {
        ...listing,
        getModelCatalogs: async (auth) => {
          catalogResolutions += 1;
          return {
            ...await listing.getModelCatalogs(auth),
            candidates: new Map([[accessProviderAccountKey(candidate), {
              candidate,
              models: new Map([["gpt-5.5", [{
                wireModelId: "gpt-5.5", metadata: null, dataUse: "standard",
                transport: "openai-responses", resolvedMetadata: fakeModelsClient.modelInfos.get("gpt-5.5"),
              }]]]),
            }]]),
          };
        },
      },
      modelInfos: fakeModelsClient.modelInfos,
      modelsClient: fakeModelsClient,
      providerModelEligibility: () => pickerEligibility(providerModels),
    });

    expect(catalogResolutions).toBe(1);
    expect(rows.find((row) => row.model === "gpt-5.5")).toMatchObject({ selectable: true });
  });

  test("lists a model once when several providers serve it", async () => {
    const providerModels = new Map<AccessProviderId, ReadonlySet<string>>([
      ["openai_api", new Set(["gpt-5.5"])],
      ["github_copilot", new Set(["gpt-5.5"])],
    ]);
    const config = profileConfig({ chat: { model: "gpt-5.5", effort: "medium" } });

    const rows = await listModelOptionsForSlot(
      roleSlot("chat"),
      {
        userDataRoot: USER_DATA_ROOT,
        moduleSelection: testCapabilityModules,
        authDirectory: () => NO_CREDENTIALS,
        resolveKey,
        config,
        authProfileId: () => "personal",
        auth: OPENAI_WITH_COPILOT,
        availableModels: allAvailableModels(providerModels),
        listingClient: fakeProviderListing(providerModels),
        modelInfos: fakeModelsClient.modelInfos,
        modelsClient: fakeModelsClient,
        providerModelEligibility: () => pickerEligibility(providerModels),
      },
    );

    const gptRows = rows.filter((row) => row.model === "gpt-5.5");
    expect(gptRows).toHaveLength(1);
    expect(gptRows[0]).toMatchObject({ selectable: true, current: true });
    expect(gptRows[0]).not.toHaveProperty("accessProvider");
    expect(gptRows[0]).not.toHaveProperty("accessProviderLabel");
  });

  test("consolidates numeric dot and dash provider spellings", async () => {
    const providerModels = new Map<AccessProviderId, ReadonlySet<string>>([
      ["anthropic_api", new Set(["claude-fable-5-1"])],
      ["openai_api", new Set(["gpt-5.5"])],
      ["openrouter", new Set(["claude-fable-5.1"])],
    ]);
    const config = profileConfig({ chat: { model: "gpt-5.5", effort: "medium" } });

    const rows = await listModelOptionsForSlot(roleSlot("chat"), {
      userDataRoot: USER_DATA_ROOT,
      moduleSelection: testCapabilityModules,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey,
      config,
      authProfileId: () => "personal",
      auth: { ...OPENAI_WITHOUT_COPILOT, providers: authProviders({ base: OPENAI_WITHOUT_COPILOT.providers, apiKeys: { anthropic_api: "sk-ant-test" } }),},
      availableModels: allAvailableModels(providerModels),
      listingClient: fakeProviderListing(providerModels),
      modelInfos: fakeModelsClient.modelInfos,
      modelsClient: fakeModelsClient,
      providerModelEligibility: () => pickerEligibility(providerModels),
    });

    expect(rows.filter((row) => row.model?.startsWith("claude-fable-5"))).toEqual([
      expect.objectContaining({ model: "claude-fable-5.1", label: "claude-fable-5.1", selectable: true }),
    ]);
  });


  test("shows a dated-only offering under its undated canonical identity", async () => {
    const anthropicAuth: AuthContext = {
      ...OPENAI_WITHOUT_COPILOT,
      providers: authProviders({ base: OPENAI_WITHOUT_COPILOT.providers, apiKeys: { anthropic_api: "[redacted secret]" } }),
    };
    const providerModels = new Map<AccessProviderId, ReadonlySet<string>>([
      ["anthropic_api", new Set(["claude-opus-4-6-20260201"])],
    ]);
    const config = profileConfig({ chat: { model: "claude-opus-4-6-20260201", effort: "medium" } });

    const rows = listModelOptionsForSlot(
      roleSlot("chat"),
      {
        userDataRoot: USER_DATA_ROOT,
        moduleSelection: testCapabilityModules,
        authDirectory: () => NO_CREDENTIALS,
        resolveKey,
        config,
        authProfileId: () => "personal",
        auth: anthropicAuth,
        availableModels: allAvailableModels(providerModels),
        listingClient: fakeProviderListing(providerModels),
        modelInfos: fakeModelsClient.modelInfos,
        modelsClient: fakeModelsClient,
        providerModelEligibility: () => pickerEligibility(providerModels),
      },
    );

    await expect(rows).resolves.toEqual([
      expect.objectContaining({ model: "claude-opus-4.6", selectable: true }),
    ]);
  });

  test("keeps a current raw-catalog model unavailable when picker eligibility excludes it", async () => {
    const catalogs = new Map<AccessProviderId, import("../../../../src/infra/llm/provider-model-preferences.js").ResolvedProviderModels>([["openai_api", {
      catalog: new Set(["gpt-5.5"]),
      curatedDefault: new Set(["gpt-5.5"]),
      effective: new Set(),
      enabled: new Set(),
      disabled: new Set(["gpt-5.5"]),
    }]]);
    const rows = await listModelOptionsForSlot(roleSlot("chat"), {
      userDataRoot: USER_DATA_ROOT,
      moduleSelection: testCapabilityModules,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey,
      config: profileConfig({ chat: { model: "gpt-5.5", effort: "medium" } }),
      authProfileId: () => "personal",
      providerModelCatalogs: () => catalogs,
      providerModelEligibility: () => new Map(),
      modelsClient: fakeModelsClient,
    });

    expect(rows).toEqual([]);
  });

  test("carries serving catalog provenance into selectable picker rows", async () => {
    const catalogs = new Map<AccessProviderId, import("../../../../src/infra/llm/provider-model-preferences.js").ResolvedProviderModels>([["chatgpt", {
      catalog: new Set(["gpt-5.5"]), curatedDefault: new Set(["gpt-5.5"]),
      effective: new Set(["gpt-5.5"]), enabled: new Set(), disabled: new Set(),
    }]]);
    const rows = await listModelOptionsForSlot(roleSlot("chat"), {
      userDataRoot: USER_DATA_ROOT, moduleSelection: testCapabilityModules,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey,
      config: parseSchema(FlywheelConfigSchema, {}),
      providerModelCatalogs: () => catalogs,
      providerModelEligibility: () => new Map([["gpt-5.5", {
        explicitlyEnabled: false,
        transport: "openai-responses",
        offering: { candidate: { kind: "subscription", providerId: "chatgpt", instanceId: "account", spendMode: "included" }, wireModelId: "gpt-5.5", dataUse: "standard" },
        catalog: { kind: "available", provenance: "models-dev-archive", liveOutcome: "discovery-failed" },
      }]]),
      modelInfos: fakeModelsClient.modelInfos,
      modelsClient: fakeModelsClient,
    });

    expect(rows.find((row) => row.model === "gpt-5.5")).toMatchObject({
      selectable: true,
      catalogProvenance: "models-dev-archive",
    });
  });
});
