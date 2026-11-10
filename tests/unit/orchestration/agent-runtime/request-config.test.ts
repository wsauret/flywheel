import { configSection } from "../../../../src/orchestration/config/config-section.js";
import { skillsConfigSection, memoryConfigSection } from "../../../../src/orchestration/modules/learning/config.js";
import { describe, expect, test } from "bun:test";
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema.js";
import { captureRuntimeConfigRequest } from "../../../../src/orchestration/agent-runtime/request-config.js";
import { subagentsConfigSection } from "../../../../src/orchestration/modules/subagents/config.js";

const snapshot = (revision: number) => ({
  revision,
  config: { ...structuredClone(CONFIG_DEFAULTS), skills: configSection(CONFIG_DEFAULTS, skillsConfigSection), memory: configSection(CONFIG_DEFAULTS, memoryConfigSection) },
  warnings: [],
  diagnostics: [],
  sourceIdentity: String(revision),
  status: { kind: "valid" as const },
});

describe("runtime config request capture", () => {
  test("captures every next-request catalog policy from one immutable revision", () => {
    const source = snapshot(7);
    const capture = captureRuntimeConfigRequest(source, "work");

    expect(capture).toEqual({
      revision: 7,
      profileId: "work",
      foregroundBashHoldSeconds: source.config.foreground_bash_hold_seconds,
      webSearchProvider: source.config.web_search.provider,
      proactiveCompactionThreshold: source.config.proactive_compaction_threshold,
      idleCompaction: source.config.idle_compaction,
      cacheRetentionPolicies: source.config.cache_retention,
      providerSettings: {},
      allowPersistentProcesses: source.config.allow_persistent_processes,
      shellWriteGuard: source.config.shell_write_guard,
      profileRoles: {},
      gitAiAttribution: false,
      allowTrainingRoutes: false,
      budget: source.config.budget,
      workflow: source.config.workflow,
      moduleSections: { skills: configSection(source.config, skillsConfigSection), memory: configSection(source.config, memoryConfigSection), subagents: configSection(source.config, subagentsConfigSection) },
    });
    expect(Object.isFrozen(capture)).toBe(true);
  });

  test("excludes undeclared and secret module sections from request evidence", () => {
    const source = snapshot(12);
    const config = { ...source.config, mcp: { access_token: "fixture-secret" }, future: { password: "fixture-password" } };
    const capture = captureRuntimeConfigRequest({ ...source, config }, "work");
    expect(Object.keys(capture.moduleSections).sort()).toEqual(["memory", "skills", "subagents"]);
    expect(JSON.stringify(capture)).not.toContain("fixture-secret");
    expect(JSON.stringify(capture)).not.toContain("fixture-password");
    expect(Object.isFrozen(capture.moduleSections)).toBe(true);
    expect(Object.isFrozen(capture.moduleSections.skills)).toBe(true);
  });

  test("resolves independent profile values and freezes the effective cache identity", () => {
    const source = snapshot(8);
    source.config = {
      ...source.config,
      profiles: {
        work: { roles: {}, git_ai_attribution: true, allow_training_routes: true, providers: { github_copilot: { monthly_credit_cap: 1200 } } },
        personal: { roles: {}, git_ai_attribution: false, allow_training_routes: false, providers: { github_copilot: { monthly_credit_cap: 0 } } },
      },
    };

    const work = captureRuntimeConfigRequest(source, "work");
    const personal = captureRuntimeConfigRequest(source, "personal");

    expect(work).toMatchObject({ profileId: "work", providerSettings: { github_copilot: { monthly_credit_cap: 1200 } }, profileRoles: {}, gitAiAttribution: true, allowTrainingRoutes: true });
    expect(personal).toMatchObject({ profileId: "personal", providerSettings: { github_copilot: { monthly_credit_cap: 0 } }, profileRoles: {}, gitAiAttribution: false, allowTrainingRoutes: false });
    expect(Object.isFrozen(work)).toBe(true);
    expect(Object.isFrozen(work.profileRoles)).toBe(true);
  });

  test("uses the profile default when the effective profile has no overlay", () => {
    expect(captureRuntimeConfigRequest(snapshot(9), "unconfigured").providerSettings).toEqual({});
    expect(captureRuntimeConfigRequest(snapshot(9), "unconfigured").allowTrainingRoutes).toBe(false);
  });

  test("applies request-owned fields only to the next immutable capture", () => {
    const source = snapshot(1);
    source.config = {
      ...source.config,
      cache_retention: { anthropic_api: "1h" },
      profiles: { work: { roles: {}, git_ai_attribution: false, allow_training_routes: false, providers: { github_copilot: { monthly_credit_cap: 1200 } } } },
    };
    const inFlight = captureRuntimeConfigRequest(source, "work", false);
    const forced = captureRuntimeConfigRequest(source, "work", true);
    expect(forced.allowPersistentProcesses).toBe(true);
    expect(source.config.allow_persistent_processes).toBe(false);

    const changed = snapshot(2);
    changed.config = {
      ...changed.config,
      cache_retention: { anthropic_api: "5m", openai_api: "provider" },
      foreground_bash_hold_seconds: 12,
      allow_persistent_processes: true,
      skills: { ...configSection(changed.config, skillsConfigSection), notifications: "verbose", review_interval_iterations: 3 },
      profiles: { work: { roles: {}, git_ai_attribution: false, allow_training_routes: false, providers: { github_copilot: { monthly_credit_cap: 0 } } } },
    };
    const next = captureRuntimeConfigRequest(changed, "work", false);
    changed.config.cache_retention = { ...changed.config.cache_retention, anthropic_api: "1h" };
    changed.config.allow_persistent_processes = false;
    expect(captureRuntimeConfigRequest(changed, "work", false).allowPersistentProcesses).toBe(false);
    expect(forced.allowPersistentProcesses).toBe(true);

    expect(inFlight.foregroundBashHoldSeconds).toBe(CONFIG_DEFAULTS.foreground_bash_hold_seconds);
    expect(inFlight.allowPersistentProcesses).toBe(false);
    expect(configSection(inFlight.moduleSections, skillsConfigSection).notifications).toBe("on");
    expect(inFlight.providerSettings).toEqual({ github_copilot: { monthly_credit_cap: 1200 } });
    expect(next.foregroundBashHoldSeconds).toBe(12);
    expect(next.allowPersistentProcesses).toBe(true);
    expect(configSection(next.moduleSections, skillsConfigSection)).toMatchObject({ notifications: "verbose", review_interval_iterations: 3 });
    expect(next.providerSettings).toEqual({ github_copilot: { monthly_credit_cap: 0 } });
    expect(inFlight.cacheRetentionPolicies).toEqual({ anthropic_api: "1h" });
    expect(next.cacheRetentionPolicies).toEqual({ anthropic_api: "5m", openai_api: "provider" });
    expect(Object.isFrozen(next.cacheRetentionPolicies)).toBe(true);
  });
});
