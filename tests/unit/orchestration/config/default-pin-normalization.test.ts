import { describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelFamily } from "../../../../src/infra/llm/model-family.js";
import { parseSchema } from "../../../helpers/schema-assertions.js";
import { FlywheelConfigSchema } from "../../../../src/orchestration/config/schema.js";
import {
  listModelAssignments,
  listModelOptionsForSlot,
  listEffortOptionsForSlot,
  normalizeAssignmentPatch,
} from "../../../../src/orchestration/config/model-assignments.js";
import { createModelAssignmentController } from "../../../../src/orchestration/config/model-assignment-controller.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { fakeListingClient } from "../../../helpers/fake-listing-client.js";
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js";
import { USER_DATA_ROOT, withTempDir, NO_CREDENTIALS } from "./_config-models-fixtures.js";

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { loadConfig } from "../../../../src/orchestration/config/loader.js";
import { saveModelAssignment } from "../../../../src/orchestration/config/model-selection.js";
// Role defaults resolve only for listed models, so the listing must contain
// the current candidates (role-model-defaults.ts).
const availableModels = new Map<ModelFamily, ReadonlySet<string>>([
  ["openai", new Set(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"])],
  ["anthropic", new Set(["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5"])],
]);
const modelInfos = fakeModelsClient.modelInfos;

function pickerEligibility(models: ReadonlyMap<ModelFamily, ReadonlySet<string>>) {
  return new Map([...models.values()].flatMap((familyModels) => [...familyModels].map((model) => [model, {
    explicitlyEnabled: false,
    offering: { candidate: { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }, wireModelId: model, dataUse: "standard" },
  }] as const)));
}

function deps(roles: { [roleId: string]: { model?: string; effort?: string } } = {}) {
  return {
    userDataRoot: USER_DATA_ROOT,
    authDirectory: () => NO_CREDENTIALS,
    authProfileId: () => "personal",
    config: parseSchema(FlywheelConfigSchema, { profiles: { personal: { roles } } }),
    availableModels,
    modelInfos,
    modelsClient: fakeModelsClient,
    listingClient: fakeListingClient(availableModels),
    providerModelEligibility: () => pickerEligibility(availableModels),
    resolveKey: async () => undefined,
    moduleSelection: () => composeFirstPartyModules(),
  };
}

describe("default-pin normalization", () => {
  it("keeps the entry when the selection equals the role default", () => {
    const patch = normalizeAssignmentPatch({ model: "gpt-6.1-sol", effort: "high" });
    expect(patch).toEqual({ model: "gpt-6.1-sol", effort: "high" });
  });

  it("keeps a pin that differs from the role default", async () => {
    expect(normalizeAssignmentPatch({ model: "gpt-6-luna", effort: "high" }))
      .toEqual({ model: "gpt-6-luna", effort: "high" });
    expect(normalizeAssignmentPatch({ model: "gpt-6.1-sol", effort: "xhigh" }))
      .toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
  });

  it("keeps Design's Fable default as an explicit exception to Reviewer", async () => {
    const patch = normalizeAssignmentPatch({ model: "claude-fable-5", effort: "medium" });

    expect(patch).toEqual({ model: "claude-fable-5", effort: "medium" });
  });

  it("uses global Design when a step Design effort inherits", async () => {
    const options = await listEffortOptionsForSlot(
      roleSlot("brief.fly.code-review.persona.reviewer-design"),
      null,
      deps({
        reviewer: { model: "gpt-6.1-sol", effort: "low" },
        "reviewer-design": { model: "claude-fable-5", effort: "medium" },
      }),
    );

    expect(options.find((option) => option.inherit)?.label).toBe("Inherit Reviewer: medium");
  });

  it("never rewrites a step-slot patch: clearing a step entry means inherit, not default", async () => {
    const patch = normalizeAssignmentPatch({ model: "gpt-6.1-sol", effort: "medium" });
    expect(patch).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
  });

  it("compares explicit and automatic assignments with the inherited pair", async () => {
    const rows = await listModelAssignments({
      ...deps({ reviewer: { model: "gpt-6.1-sol", effort: "medium" }, implementer: { model: "gpt-6.1-sol", effort: "low" } }),
      slots: [roleSlot("reviewer"), roleSlot("implementer"), roleSlot("explorer")],
    });
    expect(rows.find((row) => row.slot.roleId === "reviewer")).toMatchObject({ modelSource: "explicit", matchesInheritedPair: false });
    expect(rows.find((row) => row.slot.roleId === "implementer")).toMatchObject({ modelSource: "explicit", matchesInheritedPair: false });
    expect(rows.find((row) => row.slot.roleId === "explorer")).toMatchObject({ modelSource: "default", matchesInheritedPair: true });
  });

  it("compares the complete global assignment pair with its automatic default", async () => {
    const rows = await listModelAssignments({
      ...deps({
        reviewer: { model: "gpt-6.1-sol", effort: "high" },
        implementer: { model: "gpt-6-astra", effort: "low" },
      }),
      slots: [roleSlot("reviewer"), roleSlot("implementer"), roleSlot("explorer")],
    });

    expect(rows.find((row) => row.slot.roleId === "reviewer")).toMatchObject({ matchesInheritedPair: true });
    expect(rows.find((row) => row.slot.roleId === "implementer")).toMatchObject({ matchesInheritedPair: true });
    expect(rows.find((row) => row.slot.roleId === "explorer")).toMatchObject({ matchesInheritedPair: true });
  });

  it("compares a profile assignment pair with its coded default", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: {
        work: {
          roles: {
            reviewer: { model: "gpt-6.1-sol", effort: "medium" },
            implementer: { model: "gpt-6-astra", effort: "low" },
          },
        },
      },
    });
    const rows = await listModelAssignments({
      ...deps(),
      config,
      authProfileId: () => "work",
      slots: [roleSlot("reviewer"), roleSlot("implementer"), roleSlot("explorer")],
    });

    expect(rows.find((row) => row.slot.roleId === "reviewer")).toMatchObject({ matchesInheritedPair: false });
    expect(rows.find((row) => row.slot.roleId === "implementer")).toMatchObject({ matchesInheritedPair: true });
    expect(rows.find((row) => row.slot.roleId === "explorer")).toMatchObject({ matchesInheritedPair: true });
  });

  it("compares retired role keys through their canonical assignment", async () => {
    const rootRows = await listModelAssignments({
      ...deps({ "step-worker": { model: "gpt-6.1-sol", effort: "high" } }),
      slots: [roleSlot("workflow-agent")],
    });
    const profileConfig = parseSchema(FlywheelConfigSchema, {
      profiles: {
        work: {
          roles: {
            "step-worker": { model: "gpt-6.1-sol", effort: "high" },
          },
        },
      },
    });
    const profileRows = await listModelAssignments({
      ...deps(),
      config: profileConfig,
      authProfileId: () => "work",
      slots: [roleSlot("workflow-agent")],
    });

    expect(rootRows[0]).toMatchObject({ matchesInheritedPair: false });
    expect(profileRows[0]).toMatchObject({ matchesInheritedPair: false });
  });

  it("marks the role default model row in the slot options", async () => {
    const options = await listModelOptionsForSlot(roleSlot("reviewer"), deps());
    const marked = options.filter((option) => option.roleDefault);
    expect(marked.map((option) => option.model)).toEqual(["gpt-6.1-sol"]);
  });

  it("normalizes dated snapshots to one undated model", async () => {
    const dated = new Map<ModelFamily, ReadonlySet<string>>([
      ["openai", new Set(["gpt-6-luna", "gpt-6.1-sol"])],
      ["anthropic", new Set(["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5"])],
    ]);
    const datedDeps = { ...deps(), availableModels: dated, listingClient: fakeListingClient(dated), providerModelEligibility: () => pickerEligibility(dated) };
    expect(normalizeAssignmentPatch({ model: "gpt-6.1-sol-20260901", effort: "high" }))
      .toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(normalizeAssignmentPatch({ model: "gpt-6.1-sol-20260801", effort: "high" }))
      .toEqual({ model: "gpt-6.1-sol", effort: "high" });
    const options = await listModelOptionsForSlot(roleSlot("reviewer"), datedDeps);
    expect(options.filter((option) => option.roleDefault).map((option) => option.model)).toEqual(["gpt-6.1-sol"]);
  });

  it("overwrites a broken profile choice with an explicit default and clears only on reset", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(configPath, '[profiles.personal.roles.reviewer]\nmodel = "lost-model"\neffort = "low"\n[profiles.other.roles.chat]\nmodel = "gpt-6-luna"\neffort = "low"\n');
      const configDeps = { ...deps(), configPath, config: loadConfig(configPath, {}).config };
      const controller = createModelAssignmentController({
        configDeps,
      });
      await controller.saveEffort(roleSlot("reviewer"), "gpt-6-luna", "xhigh");
      expect(await readFile(configPath, "utf8")).toContain('model = "gpt-6-luna"');
      await controller.saveEffort(roleSlot("reviewer"), "gpt-6.1-sol", "high");
      const saved = loadConfig(configPath, {}).config;
      expect(saved.profiles.personal?.roles.reviewer).toEqual({ model: "gpt-6.1-sol", effort: "high" });
      const changedDefaults = new Map<ModelFamily, ReadonlySet<string>>([["openai", new Set(["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])]]);
      const rows = await listModelAssignments({ ...configDeps, config: saved, availableModels: changedDefaults, slots: [roleSlot("reviewer")] });
      expect(rows[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "high", modelSource: "explicit" });
      await saveModelAssignment(roleSlot("reviewer"), { model: null, effort: null }, configDeps);
      const reset = loadConfig(configPath, {}).config;
      expect(reset.profiles.personal?.roles.reviewer).toBeUndefined();
      expect(reset.profiles.other?.roles.chat).toEqual({ model: "gpt-6-luna", effort: "low" });
      expect(Bun.TOML.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("roles");
    });
  });
});
