import { parseSchema } from "../../../helpers/schema-assertions.js";
import { describe, expect, it } from "bun:test";
import type { ModelFamily } from "../../../../src/infra/llm/model-family.js";
import { selectRoleModelDefault } from "../../../../src/orchestration/config/role-model-defaults.js";
import { resolveRoles } from "../../../../src/orchestration/config/role-resolution.js";
import { FlywheelConfigSchema } from "../../../../src/orchestration/config/schema.js";
import { tierOptions } from "./_config-models-fixtures.js";

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
  it("selects the OpenAI preference with its effort when both preferences are listed", () => {
    expect(selectRoleModelDefault("explorer", bothProviders)).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    expect(selectRoleModelDefault("reviewer", bothProviders)).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
    expect(selectRoleModelDefault("reviewer-quality", bothProviders)).toMatchObject({ model: "gpt-6-astra", effort: "medium" });
    expect(selectRoleModelDefault("reviewer-elegance", bothProviders)).toMatchObject({ model: "gpt-6-astra", effort: "medium" });
    expect(selectRoleModelDefault("reviewer-mechanism", bothProviders)).toMatchObject({ model: "gpt-6-astra", effort: "medium" });
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

  it("returns undefined without a listed preference", () => {
    expect(selectRoleModelDefault("reviewer", undefined)).toBeUndefined();
    expect(selectRoleModelDefault("reviewer", new Map())).toBeUndefined();
    expect(selectRoleModelDefault("reviewer-design", sonnetOnly)).toBeUndefined();
  });

  it("selects the canonical default from a dated provider snapshot", () => {
    const dated = new Map<ModelFamily, ReadonlySet<string>>([
      ["openai", new Set(["gpt-6-luna-20261001"])],
    ]);
    expect(selectRoleModelDefault("explorer", dated)).toEqual({
      model: "gpt-6-luna",
      effort: "high",
      family: "openai",
    });
    expect(selectRoleModelDefault("reviewer-quality", new Map([["openai", new Set(["claude-opus-5.5"])]]))).toEqual({
      model: "claude-opus-5.5", effort: "high", family: "openai",
    });
  });

  it("uses the Anthropic preference's own effort when OpenAI is absent", () => {
    expect(selectRoleModelDefault("reviewer-quality", anthropicOnly)).toMatchObject({ model: "claude-opus-5.5", effort: "high" });
    expect(selectRoleModelDefault("chat", anthropicOnly)).toMatchObject({ model: "claude-opus-5.5", effort: "medium" });
    expect(selectRoleModelDefault("advisor", anthropicOnly)).toMatchObject({ model: "claude-fable-5.2", effort: "high" });
    expect(selectRoleModelDefault("title-generation", anthropicOnly)).toMatchObject({ model: "claude-haiku-5.5", effort: "low" });
  });

  it("resolveRoles falls back to each role's tier and effort", async () => {
    const config = parseSchema(FlywheelConfigSchema, {});
    const noCandidates = new Map<ModelFamily, ReadonlySet<string>>([
      ["openai", new Set(["gpt-5.5", "gpt-5.4", "gpt-5-mini"])],
    ]);
    const roles = await resolveRoles(config, noCandidates, tierOptions);
    expect(roles.get("explorer")).toMatchObject({ model: "gpt-5-mini", effort: "high" });
    expect(roles.get("reviewer")).toMatchObject({ model: "gpt-5.4", effort: "high" });
    expect(roles.get("reviewer-quality")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("implementer")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("ship")).toMatchObject({ model: "gpt-5-mini", effort: "high" });
    expect(roles.get("reviewer-design")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("workflow-agent")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("chat")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
    expect(roles.get("advisor")).toMatchObject({ model: "gpt-5.5", effort: "high" });
    expect(roles.get("learning-review")).toMatchObject({ model: "gpt-5.4", effort: "medium" });
  });

  it("uses reachable saved models, clamps unsupported effort, and skips an unreachable pair whole", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: { personal: { roles: {
        reviewer: { model: "claude-sonnet-4-6", effort: "max" },
        explorer: { effort: "low" },
        advisor: { model: "lost-model", effort: "low", provider_options: { openai: { text_verbosity: "high" } } },
      } } },
    });
    const roles = await resolveRoles(config, bothProviders, tierOptions, "personal");
    expect(roles.get("reviewer")).toMatchObject({ model: "claude-sonnet-4.6", effort: "high" });
    expect(roles.get("explorer")).toMatchObject({ model: "gpt-6-luna", effort: "low" });
    expect(roles.get("advisor")).toMatchObject({
      model: "gpt-6-astra", effort: "high", providerOptions: { openai: { text_verbosity: "high" } },
    });
  });

  it("resolves a persona from a person's parent setting before the persona's shipped default", async () => {
    const config = parseSchema(FlywheelConfigSchema, { profiles: { personal: { roles: { reviewer: { model: "claude-sonnet-4-6", effort: "low" } } } } });
    const roles = await resolveRoles(config, bothProviders, tierOptions, "personal");

    expect(roles.get("reviewer-quality")).toMatchObject({ model: "claude-sonnet-4.6", effort: "low" });
    expect(roles.get("reviewer-design")).toMatchObject({ model: "claude-sonnet-4.6", effort: "low" });
  });

});
