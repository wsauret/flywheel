import { afterEach, describe, expect, it, test } from "bun:test";
import { installCustomProviders } from "../src/infra/llm/custom-provider-registry.js";
import type { ModelFamily } from "../src/infra/llm/model-family.js";
import { createModelListingClient } from "../src/infra/llm/model-listing.js";
import { resolveProviderModelCatalog } from "../src/orchestration/config/model-assignment-providers.js";
import { DEFAULT_ROLES } from "../src/orchestration/config/roles.js";
import { resolveRoles } from "../src/orchestration/config/role-resolution.js";
import { installCustomProvidersFromConfig } from "../src/orchestration/config/custom-providers.js";
import { FlywheelConfigSchema } from "../src/orchestration/config/schema.js";
import { composeFirstPartyModules } from "../src/orchestration/modules.js";
import { authProviders } from "../tests/helpers/auth-context.js";
import { fakeModelInfos, modelInfo, tierAvailableModels } from "../tests/helpers/model-tier-fixtures.js";
import { testProviderSelection } from "../tests/helpers/provider-authority.js";
import { parseSchema } from "../tests/helpers/schema-assertions.js";
import { tierOptions as baseTierOptions, USER_DATA_ROOT } from "../tests/unit/orchestration/config/_config-models-fixtures.js";
import { AUTH_DIR, AUTH_NONE } from "../tests/unit/orchestration/config/_model-listing-fixtures.js";

const STEP_ROLE = "brief.plan";

/** Role defaults by model, recorded from the unchanged product. */
function roleDefaults(byModel: Record<string, readonly string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(byModel).flatMap(([model, roleIds]) => roleIds.map((roleId) => [roleId, model])));
}

const MID_ROLES = [
  "chat",
  "workflow-agent",
  "reviewer",
  "reviewer-quality",
  "reviewer-elegance",
  "reviewer-design",
  "reviewer-data-integrity",
  "reviewer-performance",
  "reviewer-security",
  "reviewer-mechanism",
  "reviewer-uat",
  "implementer",
  "learning-review",
  "benchmark-judge",
  STEP_ROLE,
];
const CHEAP_ROLES = ["explorer", "ship", "title-generation", "subagent-summary"];
const ALL_ROLES = [...MID_ROLES, ...CHEAP_ROLES, "advisor"];

/** A catalog model that the catalog describes and marks able to call tools,
 *  but that has no rate card, so it has no price tier. */
const UNPRICED_MODEL = "gpt-6-preview";
const UNPRICED_MODEL_INFO = modelInfo("openai", UNPRICED_MODEL, "gpt", 0, 0, "2026-09-01", {
  pricing: { status: "unavailable", reason: "missing-rate-card" },
});

/** Catalog listings and the role defaults that the unchanged product gives
 *  for each one. People on catalog providers must keep getting exactly these. */
const CATALOG_LISTINGS: ReadonlyArray<{ name: string; listing: ReadonlyMap<ModelFamily, ReadonlySet<string>>; defaults: Record<string, string> }> = [
  {
    name: "openai fixture listing",
    listing: new Map([["openai", tierAvailableModels.get("openai")!]]),
    defaults: roleDefaults({ "gpt-5.4": MID_ROLES, "gpt-5-nano": CHEAP_ROLES, "gpt-5.5": ["advisor"] }),
  },
  {
    name: "google fixture listing",
    listing: new Map([["google", tierAvailableModels.get("google")!]]),
    defaults: roleDefaults({ "gemini-2.5-pro": [...MID_ROLES, "advisor"], "gemini-2.5-flash": CHEAP_ROLES }),
  },
  {
    name: "one openai model",
    listing: new Map([["openai", new Set(["gpt-5.5"])]]),
    defaults: roleDefaults({ "gpt-5.5": ALL_ROLES }),
  },
  {
    name: "anthropic, openai, and google fixture listings",
    listing: new Map((["anthropic", "openai", "google"] as const).map((family) => [family, tierAvailableModels.get(family)!])),
    defaults: roleDefaults({ "gpt-5.4": MID_ROLES, "claude-haiku-4.5": CHEAP_ROLES, "gpt-5.5": ["advisor"] }),
  },
  {
    name: "one described, tool-capable, unpriced openai model",
    listing: new Map([["openai", new Set([UNPRICED_MODEL])]]),
    defaults: roleDefaults({ [UNPRICED_MODEL]: ALL_ROLES }),
  },
];

afterEach(() => installCustomProviders([]));

/** Loads a flywheel.toml `custom_providers` section the way config loading
 *  does, lists the provider's models through the model listing client, and
 *  returns the enabled models and their metadata as runtime role resolution
 *  receives them. */
async function listCustomProvider(providerId: string, models: readonly string[], roles: Record<string, { model: string }> = {}) {
  const config = parseSchema(FlywheelConfigSchema, {
    custom_providers: { [providerId]: { base_url: "http://localhost:8080/v1", models } },
    profiles: { test: { roles } },
  });
  const warnings: string[] = [];
  installCustomProvidersFromConfig(config.custom_providers, warnings);
  expect(warnings).toEqual([]);
  const listingClient = createModelListingClient({ authDir: AUTH_DIR, providers: testProviderSelection(), captureSubscriptions: () => new Map() });
  const resolved = await resolveProviderModelCatalog({
    userDataRoot: USER_DATA_ROOT,
    authDirectory: () => AUTH_DIR,
    auth: { ...AUTH_NONE, providers: authProviders({ apiKeys: { [providerId]: "local-key" } }) },
    listingClient,
    preferencePersistence: "read-only",
  });
  const options = { userDataRoot: USER_DATA_ROOT, modelInfos: resolved.modelInfos, authDirectory: () => AUTH_DIR, moduleSelection: () => composeFirstPartyModules() };
  return { config, available: resolved.enabledModels, modelInfos: resolved.modelInfos, options };
}

function withModels(base: ReadonlyMap<ModelFamily, ReadonlySet<string>>, family: ModelFamily, extra: Iterable<string>): ReadonlyMap<ModelFamily, ReadonlySet<string>> {
  const merged = new Map(base);
  merged.set(family, new Set([...base.get(family) ?? [], ...extra]));
  return merged;
}

describe("roles when the only provider is a custom endpoint from flywheel.toml", () => {
  it("gives every role the user did not assign the custom model that the unranked order puts first", async () => {
    const listed = ["mistral-coder", "zeta-coder", "alpha-coder"];
    const { config, available, options } = await listCustomProvider("my_endpoint", listed, { chat: { model: "zeta-coder" } });
    expect([...available.values()].flatMap((models) => [...models]).toSorted()).toEqual(listed.toSorted());

    const roles = await resolveRoles(config, available, options, "test", [STEP_ROLE]);

    expect(roles.get("chat")?.model).toBe("zeta-coder");
    const unassigned = [...Object.keys(DEFAULT_ROLES).filter((roleId) => roleId !== "chat"), STEP_ROLE];
    // Custom models have no release date, so the unranked order (newest
    // release first, then model id) puts the lowest id first.
    for (const roleId of unassigned) expect({ roleId, model: roles.get(roleId)?.model }).toEqual({ roleId, model: "alpha-coder" });
    expect(roles.get("advisor")?.effort).toBe(DEFAULT_ROLES.advisor.effort);
  });

  it("gives every role the first custom model of a different config listing", async () => {
    const listed = ["omega-local", "beta-local"];
    const { config, available, options } = await listCustomProvider("lab_models", listed);

    const roles = await resolveRoles(config, available, options, "test", [STEP_ROLE]);

    for (const roleId of [...Object.keys(DEFAULT_ROLES), STEP_ROLE]) expect({ roleId, model: roles.get(roleId)?.model }).toEqual({ roleId, model: "beta-local" });
  });

  it("regression guard: keeps the same role defaults for catalog models when custom models are listed next to them", async () => {
    const custom = ["mistral-coder", "zeta-coder"];
    const listed = await listCustomProvider("my_endpoint", custom);
    const catalogModelInfos = new Map([...fakeModelInfos, [UNPRICED_MODEL, UNPRICED_MODEL_INFO]]);
    const catalogOptions = { ...baseTierOptions, modelInfos: catalogModelInfos, authDirectory: () => AUTH_DIR, moduleSelection: () => composeFirstPartyModules() };
    const mixedOptions = { ...catalogOptions, modelInfos: new Map([...catalogModelInfos, ...listed.modelInfos]) };
    const customFamilies = [...listed.available.keys()];
    expect(customFamilies.length).toBeGreaterThan(0);

    for (const { name, listing, defaults } of CATALOG_LISTINGS) {
      let mixed = listing;
      for (const family of customFamilies) mixed = withModels(mixed, family, listed.available.get(family)!);

      const catalogRoles = await resolveRoles(listed.config, listing, catalogOptions, "test", [STEP_ROLE]);
      const mixedRoles = await resolveRoles(listed.config, mixed, mixedOptions, "test", [STEP_ROLE]);

      // Regression guard: these are the defaults catalog users get today for
      // this listing, recorded from the unchanged product. Custom models
      // listed next to the catalog must not change them.
      for (const [roleId, model] of Object.entries(defaults)) {
        expect({ name, roleId, model: catalogRoles.get(roleId)?.model }).toEqual({ name, roleId, model });
        expect({ name, with: "custom models", roleId, model: mixedRoles.get(roleId)?.model }).toEqual({ name, with: "custom models", roleId, model });
      }
    }
  });
});

describe("existing tier refusal", () => {
  test("regression guard: never assigns a model described as unable to call tools on text", async () => {
    const config = parseSchema(FlywheelConfigSchema, {});
    const available = new Map([["anthropic", new Set(["claude-no-tools"])]] as const);
    const modelInfos = new Map([["claude-no-tools", modelInfo("anthropic", "claude-no-tools", "claude", 5, 25, "2026-03-01", { toolCall: false })]]);
    const options = { userDataRoot: USER_DATA_ROOT, modelInfos, authDirectory: () => AUTH_DIR, moduleSelection: () => composeFirstPartyModules() };

    const assigned = await resolveRoles(config, available, options, "test", [STEP_ROLE]).then(
      (roles) => [...roles.values()].map((role) => role.model),
      () => [] as string[],
    );

    expect(assigned).not.toContain("claude-no-tools");
  });
});
