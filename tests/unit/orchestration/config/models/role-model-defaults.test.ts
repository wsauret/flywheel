import { parseSchema } from "../../../../helpers/schema-assertions.js";
import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { modelsSnapshotFile } from "../../../../../src/infra/platform/files/paths.js";
import type { ModelFamily } from "../../../../../src/infra/providers/llm/models/model-family.js";
import { reachableRoleModelDefaults, type RoleModelPreferences, selectRoleModelDefault } from "../../../../../src/orchestration/config/models/role-model-defaults.js";
import { resolveCapturedRole, resolveRoles } from "../../../../../src/orchestration/config/models/role-resolution.js";
import { installedConfigSchema } from "../../../../../src/orchestration/config/schema/schema.js";
import { tierOptions, withTempDir } from "../_config-models-fixtures.js";
import { roleCapture } from "../../../../helpers/role-capture.js";

const bothProviders = new Map<ModelFamily, ReadonlySet<string>>([
  ["openai", new Set(["deepseek-v4.1-flash", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"])],
  ["anthropic", new Set(["claude-fable-5.2", "claude-opus-5.5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5-5"])],
]);





const anthropicOnly = new Map<ModelFamily, ReadonlySet<string>>([
  ["anthropic", new Set(["claude-fable-5.2", "claude-opus-5.5", "claude-haiku-5-5"])],
]);

const sonnetOnly = new Map<ModelFamily, ReadonlySet<string>>([
  ["anthropic", new Set(["claude-sonnet-5"])],
]);

describe("role model defaults", () => {
  it("selects each shipped role's first preference with its effort when both preferences are listed", () => {
    expect(selectRoleModelDefault("explorer", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });
    expect(selectRoleModelDefault("reviewer", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
    expect(selectRoleModelDefault("reviewer-quality", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
    expect(selectRoleModelDefault("reviewer-elegance", bothProviders)).toMatchObject({ model: "claude-opus-5.5", effort: "medium" });
    expect(selectRoleModelDefault("reviewer-mechanism", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
    expect(selectRoleModelDefault("implementer", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
    expect(selectRoleModelDefault("ship", bothProviders)).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    expect(selectRoleModelDefault("reviewer-design", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
    expect(selectRoleModelDefault("workflow-agent", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
    expect(selectRoleModelDefault("learning-review", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
    expect(selectRoleModelDefault("title-generation", bothProviders)).toMatchObject({ model: "gpt-6-luna", effort: "low" });
    expect(selectRoleModelDefault("subagent-summary", bothProviders)).toMatchObject({ model: "gpt-6-luna", effort: "low" });
    expect(selectRoleModelDefault("benchmark-judge", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
    expect(selectRoleModelDefault("chat", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
  });

  it("follows the role's own order, so an Anthropic-first role resolves to its Anthropic model when both are listed", () => {
    const anthropicFirst: RoleModelPreferences = [
      { family: "anthropic", model: "claude-opus-5.5", effort: "high" },
      { family: "openai", model: "gpt-6.1-sol", effort: "low" },
    ];
    expect(reachableRoleModelDefaults(anthropicFirst, bothProviders)[0]).toEqual({ model: "claude-opus-5.5", effort: "high", family: "anthropic" });
  });

  it("returns undefined without a listed preference", () => {
    expect(selectRoleModelDefault("reviewer", undefined)).toBeUndefined();
    expect(selectRoleModelDefault("reviewer", new Map())).toBeUndefined();
    expect(selectRoleModelDefault("reviewer-design", sonnetOnly)).toBeUndefined();
  });

  it("selects the canonical default from a dated provider snapshot", () => {
    const dated = new Map<ModelFamily, ReadonlySet<string>>([
      ["openai", new Set(["gpt-6-luna-20261001"])],
    ]);
    expect(selectRoleModelDefault("ship", dated)).toEqual({
      model: "gpt-6-luna",
      effort: "high",
      family: "openai",
    });
    expect(selectRoleModelDefault("reviewer-quality", new Map([["openai", new Set(["claude-opus-5.5"])]]))).toEqual({
      model: "claude-opus-5.5", effort: "medium", family: "openai",
    });
  });

  it("uses the Anthropic preference's own effort when OpenAI is absent", () => {
    expect(selectRoleModelDefault("reviewer-quality", anthropicOnly)).toMatchObject({ model: "claude-opus-5.5", effort: "medium" });
    expect(selectRoleModelDefault("chat", anthropicOnly)).toMatchObject({ model: "claude-opus-5.5", effort: "medium" });
    expect(selectRoleModelDefault("reviewer-elegance", anthropicOnly)).toMatchObject({ model: "claude-opus-5.5", effort: "medium" });
    expect(selectRoleModelDefault("reviewer-mechanism", anthropicOnly)).toMatchObject({ model: "claude-opus-5.5", effort: "medium" });
    expect(selectRoleModelDefault("advisor", anthropicOnly)).toMatchObject({ model: "claude-fable-5.2", effort: "high" });
    expect(selectRoleModelDefault("title-generation", anthropicOnly)).toMatchObject({ model: "claude-haiku-5.5", effort: "low" });
  });

  it("resolveRoles falls back to each role's tier and effort", async () => {
    const config = parseSchema(installedConfigSchema(), {});
    const noCandidates = new Map<ModelFamily, ReadonlySet<string>>([
      ["openai", new Set(["gpt-5.5", "gpt-5.4", "gpt-5-mini"])],
    ]);
    const roles = await resolveRoles(config, noCandidates, tierOptions);
    expect(roles.get("explorer")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("reviewer")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    // Quality stores the mid tier at xhigh; the fixture tier model supports at most high, so the effort clamps.
    expect(roles.get("reviewer-quality")).toMatchObject({ model: "gpt-5.4", effort: "high" });
    expect(roles.get("reviewer-elegance")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("reviewer-mechanism")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    // Advisor and implementer both prefer gpt-6-astra (powerful tier) first. Advisor stores no fallback, so it takes
    // that tier; implementer stores the mid tier at high effort from its benchmark ranking.
    expect(roles.get("implementer")).toMatchObject({ model: "gpt-5.4", effort: "high" });
    expect(roles.get("ship")).toMatchObject({ model: "gpt-5-mini", effort: "high" });
    expect(roles.get("reviewer-design")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("workflow-agent")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("chat")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("advisor")).toMatchObject({ model: "gpt-5.5", effort: "high" });
    expect(roles.get("learning-review")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
  });

  it("prices a coded model from the bundled document when the admitted archive has no row for it", async () => {
    await withTempDir(async (userDataRoot) => {
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: each JSON value that JSON.parse visits
      const withoutLuna: unknown = JSON.parse(await Bun.file("src/infra/providers/llm/models/models-bundled.txt").text(), (key, value: unknown) => key === "gpt-6-luna" ? undefined : value);
      await mkdir(dirname(modelsSnapshotFile(userDataRoot)), { recursive: true });
      await Bun.write(modelsSnapshotFile(userDataRoot), JSON.stringify(withoutLuna));

      const roles = await resolveRoles(parseSchema(installedConfigSchema(), {}), new Map<ModelFamily, ReadonlySet<string>>([
        ["openai", new Set(["gpt-5.5", "gpt-5.4", "gpt-5-mini"])],
      ]), { ...tierOptions, userDataRoot });
      expect(roles.get("ship")).toMatchObject({ model: "gpt-5-mini", effort: "high" });
    });
  });

  it("uses reachable saved models, clamps unsupported effort, keeps an unreachable saved pair, and lets only a background role skip one whole (PI-MODEL-087, PI-MODEL-019)", async () => {
    const config = parseSchema(installedConfigSchema(), {
      profiles: { personal: { roles: {
        reviewer: { model: "claude-sonnet-4-6", effort: "max" },
        explorer: { effort: "low" },
        advisor: { model: "lost-model", effort: "low", provider_options: { openai: { text_verbosity: "high" } } },
        "title-generation": { model: "lost-model", effort: "low" },
      } } },
    });
    const roles = await resolveRoles(config, bothProviders, tierOptions, "personal");
    const defaults = await resolveRoles(parseSchema(installedConfigSchema(), {}), bothProviders, tierOptions, "personal");
    expect(roles.get("reviewer")).toMatchObject({ model: "claude-sonnet-4.6", effort: "high" });
    expect(roles.get("explorer")).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });
    expect(roles.get("advisor")).toMatchObject({
      model: "lost-model", effort: "low", providerOptions: { openai: { text_verbosity: "high" } },
    });
    expect(roles.get("title-generation")).toMatchObject({ model: defaults.get("title-generation")?.model, effort: defaults.get("title-generation")?.effort });
  });

  it("resolves a persona from a person's parent setting before the persona's shipped default", async () => {
    const config = parseSchema(installedConfigSchema(), { profiles: { personal: { roles: { reviewer: { model: "claude-sonnet-4-6", effort: "low" } } } } });
    const roles = await resolveRoles(config, bothProviders, tierOptions, "personal");

    expect(roles.get("reviewer-quality")).toMatchObject({ model: "claude-sonnet-4.6", effort: "low" });
    expect(roles.get("reviewer-design")).toMatchObject({ model: "claude-sonnet-4.6", effort: "low" });
  });

  it.each([
    { models: ["gpt-6.2-sol"], kind: "selected", model: "gpt-6.2-sol" },
    { models: ["gpt-6.2-sol", "gpt-6.3-sol", "gpt-7-sol", "gpt-6.4-luna"], kind: "selected", model: "gpt-6.3-sol" },
    { models: ["gpt-6.1-sol", "gpt-6.2-sol"], kind: "selected", model: "gpt-6.1-sol" },
    { models: ["gpt-6-sol", "gpt-7-sol", "gpt-6.2-luna"], kind: "unserved", model: "gpt-6.1-sol" },
  ])("resolves saved gpt-6.1-sol to $model on $models (PI-MODEL-087)", async ({ models, kind, model }) => {
    const capture = roleCapture(models);
    expect(await resolveCapturedRole("chat", { model: "gpt-6.1-sol", effort: "max" }, {
      selection: capture.providers.selection,
      connection: capture.connection,
      eligibility: capture.eligibility,
      allowTrainingRoutes: false,
    }, "/scratch")).toMatchObject({ kind, role: { model, effort: "high" } });
  });

});
