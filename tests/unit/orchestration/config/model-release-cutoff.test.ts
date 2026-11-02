import { parseSchema } from "../../../helpers/schema-assertions.js";
import { describe, expect, test } from "bun:test";
import { listModelOptionsForSlot } from "../../../../src/orchestration/config/model-assignments.js";
import { FlywheelConfigSchema } from "../../../../src/orchestration/config/schema.js";
import { makeModelsClient, modelInfo } from "../../../helpers/model-tier-fixtures.js";
import { fakeListingClient } from "../../../helpers/fake-listing-client.js";
import { USER_DATA_ROOT, NO_CREDENTIALS } from "./_config-models-fixtures.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
describe("model release metadata", () => {
  test("keeps an old current model selectable in assignment options", async () => {
    const modelsClient = makeModelsClient({
      "claude-opus-4-6": modelInfo("anthropic", "claude-opus-4-6", "claude-opus", 5, 25, "2026-02-04"),
      "claude-opus-4-5": modelInfo("anthropic", "claude-opus-4-5", "claude-opus", 5, 25, "2026-02-03"),
    });
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: { personal: { roles: { chat: { model: "claude-opus-4-5", effort: "high" } } } },
    });

    const rows = await listModelOptionsForSlot(
      roleSlot("chat"),
      {
        userDataRoot: USER_DATA_ROOT,
        authDirectory: () => NO_CREDENTIALS,
        resolveKey: async () => undefined,
        config,
        authProfileId: () => "personal",
        availableModels: new Map([["anthropic", new Set(["claude-opus-4-6", "claude-opus-4-5"])]] as const),
        modelInfos: modelsClient.modelInfos,
        moduleSelection: () => composeFirstPartyModules(),
        providerModelCatalogs: () => new Map([["anthropic_api", {
          catalog: new Set(["claude-opus-4-6", "claude-opus-4-5"]),
          curatedDefault: new Set(["claude-opus-4-6", "claude-opus-4-5"]),
          enabled: new Set<string>(),
          disabled: new Set<string>(),
          effective: new Set(["claude-opus-4-6", "claude-opus-4-5"]),
        }]]),
        providerModelEligibility: () => new Map(["claude-opus-4.6", "claude-opus-4.5"].map((model) => [model, {
          explicitlyEnabled: true,
          transport: "anthropic-messages" as const,
        }])),
        listingClient: fakeListingClient(new Map([["anthropic", new Set(["claude-opus-4-6", "claude-opus-4-5"])]] as const)),
        modelsClient,
      },
    );

    expect(rows.map((row) => row.model)).toEqual(["claude-opus-4.6", "claude-opus-4.5"]);
    expect(rows[1]).toMatchObject({ current: true, tier: "powerful" });
    expect(rows[0]).toMatchObject({ selectable: true, tier: "powerful" });
  });
});
