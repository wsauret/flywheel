import { describe, it, expect } from "bun:test";
import { parseSchema, safeParse, safeParseStrip } from "../../../helpers/schema-assertions.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { loadConfig } from "../../../../src/orchestration/config/loader";
import { MIN_PROACTIVE_COMPACTION_THRESHOLD } from "../../../../src/orchestration/config/defaults";
import {
  FlywheelConfigSchema,
} from "../../../../src/orchestration/config/schema";
import { resolveRoles } from "../../../../src/orchestration/config/role-resolution.js";
import { fakeModelsClient, tierAvailableModels, tierModelIds } from "../../../helpers/model-tier-fixtures.js";
import { mergeProviderOptions } from "../../../../src/infra/llm/provider-options.js";
import { MODULE_IDS } from "../../../../src/protocol/module-ids.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { profileRoleSettings } from "../../../../src/orchestration/config/env.js";
import { USER_DATA_ROOT } from "./_config-models-fixtures.js";

const temporaryDirectory = temporaryDirectories();
const tierOptions = { userDataRoot: USER_DATA_ROOT, modelInfos: fakeModelsClient.modelInfos, modelsClient: fakeModelsClient };
const O = tierModelIds.openai;
const G = tierModelIds.google;



// ---------------------------------------------------------------------------
// 2.5 Config loader tests
// ---------------------------------------------------------------------------

describe("FlywheelConfigSchema", () => {
  it("applies defaults when no values provided", () => {
    const result = safeParse(FlywheelConfigSchema, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profiles).toEqual({});
      expect(result.data.budget).toEqual({
        max_invocations: 0,
        max_tokens: 0,
        max_wall_clock_minutes: 0,
      });
      expect(result.data.proactive_compaction_threshold).toBe(270_000);
      expect(result.data.notifications.desktop).toBe(true);
      expect(result.data.allow_persistent_processes).toBe(false);
      expect(result.data.foreground_bash_hold_seconds).toBe(240);
    }
  });

  it("rejects proactive compaction thresholds below the safe floor, except 0 which disables", () => {
    expect(safeParse(FlywheelConfigSchema, { proactive_compaction_threshold: MIN_PROACTIVE_COMPACTION_THRESHOLD }).success).toBe(true);
    expect(safeParse(FlywheelConfigSchema, { proactive_compaction_threshold: MIN_PROACTIVE_COMPACTION_THRESHOLD - 1 }).success).toBe(false);
    expect(safeParse(FlywheelConfigSchema, { proactive_compaction_threshold: 0 }).success).toBe(true);
  });

  it("accepts only integer foreground Bash hold seconds in the supported range", () => {
    expect(safeParse(FlywheelConfigSchema, { foreground_bash_hold_seconds: 1 }).success).toBe(true);
    expect(safeParse(FlywheelConfigSchema, { foreground_bash_hold_seconds: 2_147_483 }).success).toBe(true);
    expect(safeParse(FlywheelConfigSchema, { foreground_bash_hold_seconds: 0 }).success).toBe(false);
    expect(safeParse(FlywheelConfigSchema, { foreground_bash_hold_seconds: 2_147_484 }).success).toBe(false);
    expect(safeParse(FlywheelConfigSchema, { foreground_bash_hold_seconds: 1.5 }).success).toBe(false);
    expect(safeParse(FlywheelConfigSchema, { foreground_bash_hold_seconds: "240" }).success).toBe(false);
  });

  it("web_search.provider defaults to chatgpt and accepts only known providers", () => {
    const defaulted = safeParse(FlywheelConfigSchema, {});
    expect(defaulted.success && defaulted.data.web_search.provider).toBe("chatgpt");
    const exa = safeParse(FlywheelConfigSchema, { web_search: { provider: "exa" } });
    expect(exa.success && exa.data.web_search.provider).toBe("exa");
    expect(safeParse(FlywheelConfigSchema, { web_search: { provider: "google" } }).success).toBe(false);
  });

  it("role schema accepts the uniform speed option for both providers", () => {
    const result = safeParse(FlywheelConfigSchema, {
      profiles: { personal: { roles: {
        chat: {
          model: "claude-opus-4-6",
          provider_options: {
            openai: { speed: "fast" },
            anthropic: { speed: "fast" },
          },
        },
      } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profiles.personal?.roles.chat?.provider_options?.anthropic?.speed).toBe("fast");
      expect(result.data.profiles.personal?.roles.chat?.provider_options?.openai?.speed).toBe("fast");
    }
  });

  it("role schema rejects a speed value other than fast", () => {
    const result = safeParse(FlywheelConfigSchema, {
      profiles: { personal: { roles: {
        chat: {
          model: "gpt-5.1",
          provider_options: { openai: { speed: "priority" } },
        },
      } } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts the complete strict OpenRouter routing shape", () => {
    const provider = {
      allow_fallbacks: true,
      require_parameters: false,
      zdr: true,
      enforce_distillable_text: false,
      data_collection: "deny" as const,
      order: ["Anthropic", "OpenAI"],
      only: ["Anthropic"],
      ignore: ["Azure"],
      quantizations: ["fp8", "bf16"],
      sort: { by: "price", partition: null },
      max_price: { prompt: 1, completion: "2", image: 3, audio: "4", request: 5 },
      preferred_min_throughput: { p50: 10, p75: 20, p90: 30, p99: 40 },
      preferred_max_latency: 500,
    };
    const result = safeParse(FlywheelConfigSchema, {
      profiles: { personal: { roles: { chat: { provider_options: { openrouter: provider } } } } },
    });

    expect(result.success && result.data.profiles.personal?.roles.chat?.provider_options?.openrouter).toEqual(provider);
  });

  it.each([
    { unknown: true },
    { sort: { by: "price", unknown: true } },
    { max_price: { prompt: 1, unknown: true } },
    { preferred_min_throughput: { p50: 10, unknown: true } },
  ])("rejects unknown OpenRouter keys at each strict object boundary", (openrouter) => {
    expect(safeParse(FlywheelConfigSchema, {
      profiles: { personal: { roles: { chat: { provider_options: { openrouter } } } } },
    }).success).toBe(false);
  });

  it("merges OpenRouter routing through the provider-options authority", () => {
    expect(mergeProviderOptions(
      { openrouter: { allow_fallbacks: true, order: ["Anthropic"] } },
      { openrouter: { zdr: true, order: ["OpenAI"] } },
    )).toEqual({ openrouter: { allow_fallbacks: true, zdr: true, order: ["OpenAI"] } });
  });
  it("role schema rejects invalid effort values", () => {
    const result = safeParse(FlywheelConfigSchema, {
      roles: { "workflow-agent": { effort: "turbo" } },
    });
    expect(result.success).toBe(false);
  });

  // Project selection is startup input, not configuration (ARCH-DIRECTORIES-004): a project
  // must be selected before its configuration can be read, so a project-root
  // field in the file would be a second authority and a circular selection.
  it("has no project directory field, so a stale one is ignored instead of adopted", () => {
    const value = { project_cwd: "/scratch/Projects (2026)/my app & tools" };

    expect(safeParse(FlywheelConfigSchema, value).success).toBe(false);
    const stripped = safeParseStrip(FlywheelConfigSchema, value);
    expect(stripped.success && "project_cwd" in stripped.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config loader: file loading
// ---------------------------------------------------------------------------

describe("loadConfig: file loading", () => {
  it("loads independent API cache-retention policies without altering role options", () => {
    const dir = temporaryDirectory("flywheel-config-cache-retention-");
    const configPath = path.join(dir, "flywheel.toml");
    fs.writeFileSync(configPath, [
      "[cache_retention]",
      'anthropic_api = "5m"',
      'openai_api = "24h"',
      "",
      "[profiles.personal.roles.chat]",
      'effort = "low"',
    ].join("\n"));

    const { config, warnings } = loadConfig(configPath, {});
    expect(warnings).toEqual([]);
    expect(config.cache_retention).toEqual({ anthropic_api: "5m", openai_api: "24h" });
    expect(config.profiles.personal?.roles.chat?.effort).toBe("low");
  });

  it.each([
    ['openai_api = "5m"', "openai_api"],
    ['anthropic_api = "24h"', "anthropic_api"],
    ['chatgpt = "24h"', "chatgpt"],
  ])("refuses a cache policy its provider cannot serve (%s)", (setting, provider) => {
    const dir = temporaryDirectory("flywheel-config-cache-retention-invalid-");
    const configPath = path.join(dir, "flywheel.toml");
    fs.writeFileSync(configPath, `[cache_retention]\n${setting}\n`);

    expect(() => loadConfig(configPath, {})).toThrow(`cache_retention.${provider}`);
  });

  it("loads budget limits from TOML", () => {
    const dir = temporaryDirectory("flywheel-config-budget-");
    const configPath = path.join(dir, "flywheel.toml");
    fs.writeFileSync(configPath, [
      "[budget]",
      "max_invocations = 3",
      "max_tokens = 2500",
      "max_wall_clock_minutes = 15",
    ].join("\n"));

    const { config, warnings } = loadConfig(configPath, {});

    expect(warnings.every((w) => !w.includes("Unrecognized"))).toBe(true);
    expect(config.budget).toEqual({
      max_invocations: 3,
      max_tokens: 2500,
      max_wall_clock_minutes: 15,
    });
  });

  it("warns and ignores an unrecognized key instead of rejecting the config", () => {
    const dir = temporaryDirectory("flywheel-config-unknown-key-");
    const configPath = path.join(dir, "flywheel.toml");
    fs.writeFileSync(configPath, [
      "show_thinking = true",
      "",
      "[tracing]",
      "enabled = true",
      "",
      "[updates]",
      "auto_instal = false",
    ].join("\n"));

    const { config, warnings } = loadConfig(configPath, {});

    expect(config.show_thinking).toBe(true);
    expect(config.updates.auto_install).toBe(true);
    expect(warnings.some((w) => w.includes('Unrecognized config key "tracing"'))).toBe(true);
    expect(warnings.some((w) => w.includes("updates.auto_instal"))).toBe(true);
  });

  it("reads the retired [queue] section as [workflow]", () => {
    const dir = temporaryDirectory("flywheel-config-retired-queue-");
    const configPath = path.join(dir, "flywheel.toml");
    fs.writeFileSync(configPath, ["[queue]", "max_steps = 200"].join("\n"));

    const { config, warnings } = loadConfig(configPath, {});

    expect(warnings.every((w) => !w.includes("Unrecognized"))).toBe(true);
    expect(config.workflow.max_attempts).toBe(200);
  });

  it("lets [workflow] win over the retired [queue] spelling", () => {
    const dir = temporaryDirectory("flywheel-config-queue-conflict-");
    const configPath = path.join(dir, "flywheel.toml");
    fs.writeFileSync(configPath, ["[workflow]", "max_steps = 120", "", "[queue]", "max_steps = 200"].join("\n"));

    const { config } = loadConfig(configPath, {});

    expect(config.workflow.max_attempts).toBe(120);
  });

});

describe("loadConfig: persistent process permission", () => {
  function configWith(value: string): ReturnType<typeof loadConfig> {
    const dir = temporaryDirectory("flywheel-config-allow-persistent-processes-");
    const configPath = path.join(dir, "flywheel.toml");
    fs.writeFileSync(configPath, `allow_persistent_processes = ${value}\nshow_thinking = true\n`);
    return loadConfig(configPath, {});
  }

  it("loads both strict boolean values", () => {
    expect(configWith("true").config.allow_persistent_processes).toBe(true);
    expect(configWith("false").config.allow_persistent_processes).toBe(false);
  });

  it("fails closed on an invalid external value while unrelated settings survive", () => {
    const { config, warnings } = configWith('"yes"');
    expect(config.allow_persistent_processes).toBe(false);
    expect(config.show_thinking).toBe(true);
    expect(warnings.some((warning) => warning.includes("allow_persistent_processes"))).toBe(true);
  });
});

describe("loadConfig: shell write guard", () => {
  function load(source: string): ReturnType<typeof loadConfig> {
    const configPath = path.join(temporaryDirectory("flywheel-config-shell-write-guard-"), "flywheel.toml");
    fs.writeFileSync(configPath, source);
    return loadConfig(configPath, {});
  }

  it("keeps the guard on for a config written before the key existed, and reads the person's off", () => {
    const earlier = load("allow_persistent_processes = true\nshow_thinking = true\n");
    expect(earlier.config.shell_write_guard).toBe(true);
    expect(earlier.warnings).toEqual([]);
    expect(load("shell_write_guard = false\n").config.shell_write_guard).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Optional harness capability decoding (ARCH-STRUCTURE-024, PI-CAP-002)
// ---------------------------------------------------------------------------

describe("loadConfig: capability modules", () => {
  function configWith(lines: readonly string[]): ReturnType<typeof loadConfig> {
    const dir = temporaryDirectory("flywheel-config-capability-modules-");
    const configPath = path.join(dir, "flywheel.toml");
    fs.writeFileSync(configPath, `${lines.join("\n")}\n`);
    return loadConfig(configPath, {});
  }

  const selection = (enabled: readonly string[]): string => `disabled_modules = ${JSON.stringify(MODULE_IDS.filter((id) => !enabled.includes(id)))}`;

  it("reads an absent selection as the default module catalog", () => {
    const { config, moduleError } = configWith(["show_thinking = true"]);
    expect(config.modules).toEqual(MODULE_IDS);
    expect(moduleError).toBeUndefined();
  });

  it("reads an empty module selection", () => {
    const { config, moduleError } = configWith([selection([])]);
    expect(config.modules).toEqual([]);
    expect(moduleError).toBeUndefined();
  });

  it("normalizes duplicates and stated order to catalog order", () => {
    const enabled = MODULE_IDS.slice(0, 2);
    const disabled = MODULE_IDS.filter((id) => !enabled.includes(id));
    const { config } = configWith([`disabled_modules = ${JSON.stringify([...disabled.toReversed(), ...disabled.slice(0, 1)])}`]);
    expect(config.modules).toEqual(enabled);
  });

  it("keeps a canonical selection exactly as stated", () => {
    const stated = MODULE_IDS.slice(3, 6);
    const { config } = configWith([selection(stated)]);
    expect(config.modules).toEqual(stated);
  });

  it("uses defaults on an unknown id while unrelated valid settings survive", () => {
    const { config, moduleError, warnings } = configWith([
      "show_thinking = true",
      'disabled_modules = ["telepathy"]',
      "[notifications]",
      "desktop = false",
    ]);

    expect(config.modules).toEqual(MODULE_IDS);
    expect(moduleError).toContain("telepathy");
    expect(warnings.some((warning) => warning.includes("telepathy"))).toBe(true);
    expect(config.show_thinking).toBe(true);
    expect(config.notifications.desktop).toBe(false);
  });

  it("uses defaults when the selection is not a list of ids", () => {
    expect(configWith(['modules = "skills"']).config.modules).toEqual(MODULE_IDS);
    expect(configWith(["modules = [1]"]).config.modules).toEqual(MODULE_IDS);
  });

  it("keeps Workflows selected and off while Skills is off", () => {
    const { config, moduleError } = configWith([selection(["workflows"])]);
    expect(config.modules).toEqual(["workflows"]);
    expect(moduleError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Config loader: env > config > defaults precedence
// ---------------------------------------------------------------------------

describe("loadConfig: precedence (env > config > defaults)", () => {
  it("does not read a project directory from the environment", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_PROJECT_CWD: "/custom/path",
      FLYWHEEL_PROJECT_ROOT: "/custom/path",
    });
    expect(Object.values(config)).not.toContain("/custom/path");
  });

  it("env overrides budget limits", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_BUDGET_MAX_INVOCATIONS: "2",
      FLYWHEEL_BUDGET_MAX_TOKENS: "1000",
      FLYWHEEL_BUDGET_MAX_WALL_CLOCK_MINUTES: "5",
    });

    expect(config.budget).toEqual({
      max_invocations: 2,
      max_tokens: 1000,
      max_wall_clock_minutes: 5,
    });
  });

  it("rejects malformed env overrides before defaults hide them", () => {
    expect(() => loadConfig(undefined, {
      FLYWHEEL_QUEUE_MAX_STEPS: "ten",
    })).toThrow(/FLYWHEEL_QUEUE_MAX_STEPS/);
  });

});

// ---------------------------------------------------------------------------
// Config loader: validation errors
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Role model config
// ---------------------------------------------------------------------------

describe("role model config", () => {
  it("chat and step-agent roles are separate fields", () => {
    const roles = profileRoleSettings({}, {
      FLYWHEEL_CHAT_MODEL: "chat-model",
      FLYWHEEL_WORKER_MODEL: "worker-model",
    });
    expect(roles.chat?.model).toBe("chat-model");
    expect(roles["workflow-agent"]?.model).toBe("worker-model");
  });

  it("resolves role defaults when no model is set", async () => {
    const { config } = loadConfig(undefined, {});
    const roles = await resolveRoles(config, tierAvailableModels, tierOptions);
    expect(roles.get("workflow-agent")?.model).toBe(O.mid);
    expect(roles.get("chat")?.model).toBe(O.mid);
  });

  it("role-specific effort overrides defaults", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: { personal: { roles: {
        "workflow-agent": { model: "claude-opus-4-6", effort: "max" },
        chat: { model: "claude-opus-4-6", effort: "low" },
      } } },
    });
    const roles = await resolveRoles(config, tierAvailableModels, tierOptions, "personal");
    expect(roles.get("workflow-agent")?.effort).toBe("high");
    expect(roles.get("chat")?.effort).toBe("low");
  });

  it("keeps selected-profile role provider options", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: { personal: { roles: {
        "workflow-agent": {
          model: O.powerful,
          provider_options: {
            openai: {
              text_verbosity: "low",
              extra_body: { metadata: { source: "root" } },
            },
          },
        },
      } } },
    });
    const roles = await resolveRoles(config, tierAvailableModels, tierOptions, "personal");
    expect(roles.get("workflow-agent")?.providerOptions).toEqual({
      openai: {
        text_verbosity: "low",
        extra_body: {
          metadata: { source: "root" },
        },
      },
    });
  });

  it("abstract tier defaults choose across available providers", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: { personal: { roles: { "workflow-agent": { model: "powerful" } } } },
    });
    const roles = await resolveRoles(config, tierAvailableModels, tierOptions, "personal");
    expect(roles.get("workflow-agent")?.model).toBe(O.powerful);
  });

  it("google-only availability resolves dynamically", async () => {
    const config = parseSchema(FlywheelConfigSchema, {});
    const roles = await resolveRoles(config, new Map([["google", tierAvailableModels.get("google")!]]), tierOptions);
    expect(roles.get("workflow-agent")?.model).toBe(G.powerful);
    expect(roles.get("chat")?.model).toBe(G.powerful);
  });

  it("concrete model strings pass through unchanged", async () => {
    const config = parseSchema(FlywheelConfigSchema, {
      profiles: { personal: { roles: {
        "workflow-agent": { model: "claude-sonnet-4-20250514" },
        chat: { model: "claude-sonnet-4-20250514" },
      } } },
    });
    const roles = await resolveRoles(config, new Map([["anthropic", new Set(["claude-sonnet-4"])]]), tierOptions, "personal");
    expect(roles.get("workflow-agent")?.model).toBe("claude-sonnet-4");
    expect(roles.get("chat")?.model).toBe("claude-sonnet-4");
  });
});
