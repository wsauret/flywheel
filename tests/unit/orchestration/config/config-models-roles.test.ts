import { parseSchema } from "../../../helpers/schema-assertions.js";
import { describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../../../src/orchestration/config/loader.js";
import { listEffortOptionsForSlot, listModelAssignments, listModelOptionsForSlot } from "../../../../src/orchestration/config/model-assignments.js";
import { defaultRoleSlots, resolveWorkflowAgentRole, resolveSubagentRole, roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { DEFAULT_ROLES } from "../../../../src/orchestration/config/roles.js";
import { resolveRoles as resolveProfileRoles } from "../../../../src/orchestration/config/role-resolution.js";
import { FlywheelConfigSchema } from "../../../../src/orchestration/config/schema.js";
import { updateModelAssignment, updateModelAssignments } from "../../../../src/orchestration/config/writer.js";
import { fakeModelInfos, fakeModelsClient, tierAvailableModels } from "../../../helpers/model-tier-fixtures.js";
import { step, tierOptions as baseTierOptions, USER_DATA_ROOT, withTempDir, NO_CREDENTIALS } from "./_config-models-fixtures.js";
import { fakeListingClient } from "../../../helpers/fake-listing-client.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { loadStandalonePersonaRegistry } from "../../../../src/workflows/agents/registry.js";
import { repoDefinitions } from "../../../helpers/project-definitions.js";

const tierOptions = { ...baseTierOptions, authDirectory: () => NO_CREDENTIALS, moduleSelection: () => composeFirstPartyModules() };
const resolveRoles = (config: Parameters<typeof resolveProfileRoles>[0], models: Parameters<typeof resolveProfileRoles>[1], options: Parameters<typeof resolveProfileRoles>[2], profileId = "personal", additional: Iterable<string> = []) =>
  resolveProfileRoles(config, models, options, profileId, additional);
const profileConfig = (roles: Parameters<typeof resolveProfileRoles>[0]["profiles"][string]["roles"]) => parseSchema(FlywheelConfigSchema, { profiles: { personal: { roles } } });
describe("roles config parsing and resolution", () => {
  it("resolves unlisted project persona roles and brief seats through their coded parent policy", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "auditor.md"), "---\nname: auditor\ndescription: Audits changes.\nrole: custom-auditor\ntools: [read]\n---\nCheck the changes.\n");
      await writeFile(join(dir, "reviewer-custom.md"), "---\nname: reviewer-custom\ndescription: Reviews changes.\nrole: reviewer-custom\ntools: [read]\n---\nReview the changes.\n");
      const registry = loadStandalonePersonaRegistry("/scratch/no-bundled-personas", repoDefinitions().skills(), undefined, undefined, dir);
      const personaRoles = [...registry.values()].flatMap((persona) => persona.kind === "persona" ? [persona.role] : []);
      expect(personaRoles).toEqual(expect.arrayContaining(["custom-auditor", "reviewer-custom"]));
      const additional = [...personaRoles, "brief.custom-step", "brief.custom-step.persona.reviewer-custom"];
      const available = new Map([["openai", new Set(["gpt-6.1-sol", "gpt-6-astra"])] as const]);
      const roles = await resolveRoles(parseSchema(FlywheelConfigSchema, {}), available, tierOptions, undefined, additional);
      expect(roles.get("custom-auditor")).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
      expect(roles.get("reviewer-custom")).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
      expect(roles.get("brief.custom-step")).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
      expect(roles.get("brief.custom-step.persona.reviewer-custom")).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
      expect(roles.get("reviewer-elegance")).toMatchObject({ model: "gpt-6-astra", effort: "medium" });

      const tierFallback = await resolveRoles(parseSchema(FlywheelConfigSchema, {}), tierAvailableModels, tierOptions, undefined, additional);
      expect(tierFallback.get("custom-auditor")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
      expect(tierFallback.get("reviewer-custom")).toMatchObject({ model: "gpt-5.4", effort: "high" });
    });
  });
  it("defaults every unassigned role to an eligible custom provider model that carries no catalog metadata", async () => {
    const available = new Map([["openai", new Set(["fixture-model", "fixture-model-small"])] as const]);

    const roles = await resolveRoles(parseSchema(FlywheelConfigSchema, {}), available, tierOptions);

    for (const roleId of Object.keys(DEFAULT_ROLES)) expect(roles.get(roleId)?.model).toBe("fixture-model");
    expect(roles.get("advisor")?.effort).toBe(DEFAULT_ROLES.advisor.effort);
  });

  it("keeps tiered catalog models ahead of custom provider models without metadata", async () => {
    const available = new Map([["openai", new Set(["fixture-model", ...tierAvailableModels.get("openai")!])] as const]);

    const withCustom = await resolveRoles(parseSchema(FlywheelConfigSchema, {}), available, tierOptions);
    const catalogOnly = await resolveRoles(parseSchema(FlywheelConfigSchema, {}), new Map([["openai", tierAvailableModels.get("openai")!]] as const), tierOptions);

    for (const roleId of Object.keys(DEFAULT_ROLES)) expect(withCustom.get(roleId)?.model).toBe(catalogOnly.get(roleId)?.model);
  });

  it("lets the selected profile role override win", async () => {
    const config = profileConfig({ chat: { model: "gpt-5-mini", effort: "low" } });
    expect((await resolveRoles(config, tierAvailableModels, tierOptions)).get("chat")).toMatchObject({ model: "gpt-5-mini", effort: "low" });
  });

  it("lets an explicit Reviewer assignment override subtype defaults", async () => {
    const config = profileConfig({ reviewer: { model: "gpt-5-mini", effort: "low" } });

    const roles = await resolveRoles(config, tierAvailableModels, tierOptions);

    expect(roles.get("reviewer-design")).toMatchObject({ model: "gpt-5-mini", effort: "low" });
    expect(roles.get("reviewer-security")).toMatchObject({ model: "gpt-5-mini", effort: "low" });
  });

  it("does not treat the obsolete Designer role as a Design override", async () => {
    const config = profileConfig({
        reviewer: { model: "gpt-5-mini", effort: "low" },
        designer: { model: "claude-opus-4-6", effort: "medium" },
    });

    const roles = await resolveRoles(config, tierAvailableModels, tierOptions);

    expect(roles.get("reviewer-design")).toMatchObject({ model: "gpt-5-mini", effort: "low" });
  });

  it("resolves every retired role-id spelling to its canonical role", async () => {
    const config = profileConfig({
        "step-worker": { model: "gpt-5-mini", effort: "low" },
        "skill-review": { model: "gpt-5-mini", effort: "low" },
    });

    const roles = await resolveRoles(config, tierAvailableModels, tierOptions);

    expect(roles.get("workflow-agent")).toMatchObject({ model: "gpt-5-mini", effort: "low" });
    expect(roles.get("learning-review")).toMatchObject({ model: "gpt-5-mini", effort: "low" });
  });

  it("selects only the active profile's role pair", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: {
        personal: { roles: { chat: { model: "gpt-5-mini", effort: "low" }, advisor: { model: "gpt-5.4", effort: "medium" } } },
        work: {
          roles: {
            chat: { model: "gpt-5.4", effort: "high" },
            advisor: { model: "gpt-5-mini", effort: "low" },
          },
        },
      },
    });

    const shared = await resolveRoles(config, tierAvailableModels, tierOptions);
    const overlaid = await resolveRoles(config, tierAvailableModels, tierOptions, "work");

    expect(shared.get("chat")).toMatchObject({ model: "gpt-5-mini", effort: "low" });
    expect(shared.get("advisor")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(overlaid.get("chat")).toMatchObject({ model: "gpt-5.4", effort: "high" });
    expect(overlaid.get("advisor")).toMatchObject({ model: "gpt-5-mini", effort: "low" });
  });

  it("preserves explicit model, effort, and provider options for Chat and Advisor", async () => {
    const config = profileConfig({
        chat: {
          model: "gpt-5-mini",
          effort: "low",
          provider_options: { openai: { text_verbosity: "high" } },
        },
        advisor: {
          model: "claude-opus-4.6",
          effort: "medium",
          provider_options: { anthropic: { speed: "fast" } },
        },
    });

    const roles = await resolveRoles(config, tierAvailableModels, tierOptions);

    expect(roles.get("chat")).toMatchObject({
      model: "gpt-5-mini",
      effort: "low",
      providerOptions: { openai: { text_verbosity: "high" } },
    });
    expect(roles.get("advisor")).toMatchObject({
      model: "claude-opus-4.6",
      effort: "medium",
      providerOptions: { anthropic: { speed: "fast" } },
    });
  });

  it("applies environment role overrides after the active profile overlay", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(configPath, `[profiles.work.roles.chat]\nmodel = "claude-opus-4-6"\neffort = "high"\n`);
      const previous = process.env.FLYWHEEL_CHAT_MODEL;
      process.env.FLYWHEEL_CHAT_MODEL = "gpt-5.4";
      try {
        const { config } = loadConfig(configPath);
        expect((await resolveRoles(config, tierAvailableModels, tierOptions, "work")).get("chat"))
          .toMatchObject({ model: "gpt-5.4", effort: "high" });
        expect(await readFile(configPath, "utf8")).not.toContain("gpt-5.4");
      } finally {
        if (previous === undefined) delete process.env.FLYWHEEL_CHAT_MODEL;
        else process.env.FLYWHEEL_CHAT_MODEL = previous;
      }
    });
  });

  it("resolves partial Learning Review assignments against its own defaults", async () => {
    const effortOnly = profileConfig({
        "learning-review": { effort: "low" },
    });
    const modelOnly = profileConfig({
        "learning-review": { model: "gpt-5-mini" },
    });

    // No benchmarked candidate is listed in the fixture catalog, so the
    // missing half falls back to Learning Review's own tier defaults.
    expect((await resolveRoles(effortOnly, tierAvailableModels, tierOptions)).get("learning-review")).toMatchObject({ model: "gpt-5.4", effort: "low" });
    expect((await resolveRoles(modelOnly, tierAvailableModels, tierOptions)).get("learning-review")).toMatchObject({ model: "gpt-5-mini", effort: "medium" });
  });

  it("warns and strips unknown role keys instead of throwing", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(configPath, `[profiles.personal.roles.worker]\nmodel = "gpt-5.4"\n`);
      const rootResult = loadConfig(configPath, {});
      expect(rootResult.warnings.some((w) => /Pruned unknown role id\(s\) from \[profiles.personal.roles\]: worker/.test(w))).toBe(true);
      expect(rootResult.config.profiles.personal?.roles.worker).toBeUndefined();
    });
  });

  it("validates overlay role ids while tolerating deleted profile ids", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(configPath, `[profiles.deleted-profile.roles.worker]\nmodel = "gpt-5.4"\n\n[profiles.deleted-profile.roles.chat]\nmodel = "gpt-5-mini"\n`);
      const result = loadConfig(configPath, {});
      expect(result.warnings.some((warning) => warning.includes("profiles.deleted-profile.roles") && warning.includes("worker"))).toBe(true);
      expect(result.config.profiles["deleted-profile"]?.roles.worker).toBeUndefined();
      expect(result.config.profiles["deleted-profile"]?.roles.chat?.model).toBe("gpt-5-mini");
    });
  });

  it("warns and ignores a legacy roles.*.provider key, resolving the role without a pin", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(configPath, `[profiles.personal.roles.implementer]\nmodel = "gpt-5.4"\nprovider = "anthropic_api"\n`);
      const result = loadConfig(configPath, {});
      expect(result.warnings).toEqual([
        "Ignored profiles.personal.roles.implementer.provider: access-provider routing is now automatic. Delete the key from flywheel.toml.",
      ]);
      const roles = await resolveRoles(result.config, tierAvailableModels, tierOptions);
      expect(roles.get("implementer")).toMatchObject({ model: "gpt-5.4" });
      expect(Object.keys(roles.get("implementer") ?? {})).not.toContain("provider");
    });
  });

  it("loads a config without the legacy provider key with no warning", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(configPath, `[roles.implementer]\nmodel = "gpt-5.4"\n`);
      expect(loadConfig(configPath, {}).warnings).toEqual([]);
    });
  });

  it("writes root and step role sections in one batch", async () => {
    await withTempDir(async (dir) => {
      updateModelAssignments({
        mutations: [
          { slot: roleSlot("chat"), patch: { model: "gpt-5-mini", effort: "low" } },
          { slot: roleSlot("brief.code-review"), patch: { model: "gpt-5.4", effort: "high" } },
        ],
      }, { configPath: join(dir, "flywheel.toml"), authProfileId: () => "personal" });

      const text = await readFile(join(dir, "flywheel.toml"), "utf8");
      expect(text).toContain("[profiles.personal.roles.chat]");
      expect(text).toContain('[profiles.personal.roles."brief.code-review"]');
    });
  });

  it("ignores profile brief settings for workflow agents and their subagents", async () => {
    const config = profileConfig({
        "workflow-agent": { model: "gpt-5-mini", effort: "low" },
        reviewer: { model: "gpt-5.4", effort: "high" },
        "brief.runtime-plan": { model: "gpt-5.4", effort: "high" },
        "brief.plan": { model: "gpt-5-mini", effort: "low" },
        "brief.fly.spec-create": { model: "gpt-4.1", effort: "medium" },
        "brief.runtime-plan.persona.reviewer": { model: "gpt-5.4", effort: "high" },
        "brief.plan.persona.reviewer": { model: "gpt-5-mini", effort: "low" },
        "brief.fly.spec-create.persona.reviewer": { model: "gpt-4.1", effort: "medium" },
    });
    const available = new Map([["openai", new Set(["gpt-4.1", "gpt-5.4", "gpt-5-mini"])] as const]);
    const roles = await resolveRoles(config, available, tierOptions);
    const workflowStep = step({ briefId: "fly.spec-create" });

    expect(resolveWorkflowAgentRole(workflowStep, roles)).toMatchObject({ model: "gpt-5-mini", effort: "low" });
    expect(resolveSubagentRole("reviewer", { briefId: workflowStep.briefId }, roles)).toMatchObject({ model: "gpt-5.4", effort: "high" });
  });

  it("leaves workflow model selection empty when the profile has no selected roles", () => {
    expect(resolveWorkflowAgentRole(step({ briefId: "fly.spec-create" }), new Map())).toBeUndefined();
  });

  it("shows the persona policy for a brief seat without an authored setting", async () => {
    const config = parseSchema(FlywheelConfigSchema, {});
    const availableModels = new Map(tierAvailableModels);
    availableModels.set("openai", new Set([
      ...(availableModels.get("openai") ?? []),
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6.1-sol",
    ]));
    const slot = roleSlot("brief.fly.code-review.persona.reviewer-quality");
    const deps = {
      userDataRoot: USER_DATA_ROOT,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey: async () => undefined,
      config,
      availableModels,
      modelsClient: fakeModelsClient,
      moduleSelection: () => composeFirstPartyModules(),
      listingClient: fakeListingClient(availableModels),
      providerModelEligibility: () => new Map([...availableModels.values()].flatMap((models) => [...models].map((model) => [model, { explicitlyEnabled: false }] as const))),
      slots: [slot],
    };

    const [assignment] = await listModelAssignments(deps);
    expect(assignment).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "high",
      modelSource: "inherited",
    });

    const options = await listModelOptionsForSlot(slot, deps);
    expect(options.find((option) => option.inherit)).toMatchObject({
      label: "Inherit Reviewer",
      inheritModel: "gpt-6.1-sol",
      effort: "high",
      efforts: ["low", "medium", "high"],
      current: true,
    });

    const efforts = await listEffortOptionsForSlot(slot, null, deps);
    expect(efforts.find((option) => option.inherit)).toMatchObject({
      label: "Inherit Reviewer: high",
      current: true,
    });
  });

  it("lists default roles without per-brief defaults", async () => {
    const slots = defaultRoleSlots();
    expect(slots.map((slot) => slot.roleId)).toContain("chat");
    expect(slots.map((slot) => slot.roleId)).toContain("implementer");
    expect(slots.some((slot) => slot.roleId.startsWith("brief."))).toBe(false);
    expect(slots.map((slot) => slot.roleId)).toContain("learning-review");
    expect(slots.map((slot) => slot.roleId)).toContain("subagent-summary");
    expect(slots.map((slot) => slot.roleId)).toContain("benchmark-judge");
    const rows = await listModelAssignments({
      userDataRoot: USER_DATA_ROOT,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey: async () => undefined,
      config: loadConfig(undefined, {}).config,
      availableModels: tierAvailableModels,
      modelInfos: fakeModelInfos,
      modelsClient: fakeModelsClient,
      moduleSelection: () => composeFirstPartyModules(),
      slots,
    });
    expect(rows.some((row) => row.slot.roleId === "implementer" && row.label === "Implementer")).toBe(true);
    expect(rows.find((row) => row.slot.roleId === "learning-review")).toMatchObject({
      label: "Learning Review",
      modelSource: "default",
    });

    const options = await listModelOptionsForSlot(roleSlot("learning-review"), {
      userDataRoot: USER_DATA_ROOT,
      authDirectory: () => NO_CREDENTIALS,
      resolveKey: async () => undefined,
      config: loadConfig(undefined, {}).config,
      availableModels: tierAvailableModels,
      modelInfos: fakeModelInfos,
      modelsClient: fakeModelsClient,
      moduleSelection: () => composeFirstPartyModules(),
      listingClient: fakeListingClient(tierAvailableModels),
      providerModelEligibility: () => new Map([...tierAvailableModels.values()].flatMap((models) => [...models].map((model) => [model, { explicitlyEnabled: false }] as const))),
    });
    // Learning Review has its own default, so it offers no inherit row.
    expect(options.some((option) => option.inherit)).toBe(false);
    expect(options.some((option) => option.current)).toBe(true);
  });
});

describe("model assignment writer", () => {
  it("clears a step role section when all assignment fields are removed", async () => {
    await withTempDir(async (dir) => {
      await updateModelAssignment(roleSlot("brief.plan"), { model: "gpt-5-mini", effort: "low" }, { configPath: join(dir, "flywheel.toml"), authProfileId: () => "personal" });
      await updateModelAssignment(roleSlot("brief.plan"), { model: null, effort: null }, { configPath: join(dir, "flywheel.toml"), authProfileId: () => "personal" });
      const text = await readFile(join(dir, "flywheel.toml"), "utf8");
      expect(text).not.toContain("brief.plan");
    });
  });

  it("removes an empty Learning Review section like other profile roles", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await updateModelAssignment(roleSlot("learning-review"), { model: "gpt-5-mini", effort: "low" }, { configPath, authProfileId: () => "personal" });
      await updateModelAssignment(roleSlot("learning-review"), { model: null, effort: null }, { configPath, authProfileId: () => "personal" });
      const text = await readFile(configPath, "utf8");
      expect(text).not.toContain('roles.learning-review');
      expect(text).not.toContain("model =");
    });
  });
});
