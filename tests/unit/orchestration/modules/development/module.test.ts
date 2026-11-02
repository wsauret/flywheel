import { installedDefinitionBundles, installedModules } from "../../../../../src/orchestration/module-catalog.js"
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVELOPMENT_MODULES } from "../../../../../src/orchestration/development-modules.js";
import { developmentModule } from "../../../../../src/orchestration/modules/development/module.js";
import type { ModuleRuntimeServices } from "../../../../../src/orchestration/agent-runtime/module-runtime-services.js";
import { composeFirstPartyModules, composeRealmModuleSnapshot, installedCliNouns, moduleProtocolRows, moduleSelectionFromConfig, RETIRED_MODULE_ID_SPELLINGS, SHIPPED_MODULES } from "../../../../../src/orchestration/modules.js";
import { createToolRegistry, installedPersonaToolEntries } from "../../../../../src/orchestration/tool-catalog.js";
import { composeModuleServices, NO_MODULE_SERVICES } from "../../../../../src/infra/module-service.js";
import { moduleRequirementsForContribution } from "../../../../../src/orchestration/module-requirements.js";
import { MODULE_IDS } from "../../../../../src/protocol/module-ids.js";
import { createProjectDefinitionRegistry } from "../../../../../src/workflows/definition-registry.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { personaToolEntries } from "../../../../../src/orchestration/agent-runtime/tools/tool-registry.js";
import { loadStandalonePersonaRegistry } from "../../../../../src/workflows/agents/registry.js";
import { personaToolNames } from "../../../../../src/workflows/agents/subagent-reachability.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { createChildSlotRegistry } from "../../../../../src/orchestration/agent-runtime/child-slot-registry.js";
import { createProviderRequestAuditWriter } from "../../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js";
import { refusingLauncher } from "../../../../helpers/launcher-fake.js";
import { testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";

const SOURCE_CATALOG = [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES];
const BUNDLE_SKILL_IDS = ["typescript-bun", "flywheel-uat"];
const PERSONA_DIR = fileURLToPath(new URL("../../../../../src/workflows/agents/personas", import.meta.url));

function registry(bundles = installedDefinitionBundles(SOURCE_CATALOG)) {
  return createProjectDefinitionRegistry({ ...testDirectories(process.cwd()), skillRoots: [], bundles, personaToolEntries: installedPersonaToolEntries() });
}

describe("the development module", () => {
  test("is absent from the shipped catalog and present only where the source entry installs it", () => {
    expect(installedModules().map((module) => module.id)).toEqual(SHIPPED_MODULES.map((module) => module.id));
    const shippedIds: readonly string[] = SHIPPED_MODULES.map((module) => module.id);
    expect(shippedIds).not.toContain("development");
    expect(DEVELOPMENT_MODULES).toContain(developmentModule);
    expect(MODULE_IDS).toContain("development");
  });

  test("owns its source-only tools, its CLI nouns, one settings row, and one definition bundle", () => {
    const composition = composeFirstPartyModules(SOURCE_CATALOG);
    expect(composition.enabledModuleIds).toContain("development");
    expect(composition.contributions.some((contribution) => contribution.domain === "tools" && contribution.id === "benchmark")).toBe(true);
    expect(composition.contributions.some((contribution) => contribution.domain === "tools" && contribution.id === "ios_simulator")).toBe(true);
    const noun = installedCliNouns(SOURCE_CATALOG).get("dev");
    expect(noun?.module).toBe("development");
    expect(Object.keys(noun?.verbs ?? {}).sort()).toEqual(["cache-report", "efficiency"]);
    const claudeSdk = installedCliNouns(SOURCE_CATALOG).get("claude-sdk");
    expect(claudeSdk?.module).toBe("development");
    expect(Object.keys(claudeSdk?.verbs ?? {}).sort()).toEqual(["scenario", "setup"]);
    expect(installedDefinitionBundles(SOURCE_CATALOG)).toEqual([{ id: "development", root: join(process.cwd(), "src", "orchestration", "modules", "development", "definitions") }]);
    expect(installedCliNouns(SHIPPED_MODULES).has("dev")).toBe(false);
    expect(installedCliNouns(SHIPPED_MODULES).has("claude-sdk")).toBe(false);
    expect(installedDefinitionBundles(SHIPPED_MODULES)).toEqual([]);
  });

  test("turning it off removes every contribution at once", () => {
    const off = composeFirstPartyModules(SOURCE_CATALOG, ["development"]);
    expect(off.enabledModuleIds).not.toContain("development");
    expect(off.contributions.some((contribution) => contribution.module === "development")).toBe(false);
    expect(off.contributions.some((contribution) => contribution.domain === "tools" && contribution.id === "benchmark")).toBe(false);
    expect(off.contributions.some((contribution) => contribution.domain === "tools" && contribution.id === "ios_simulator")).toBe(false);
  });

  test("gives the UAT reviewer simulator control beside its shell", () => {
    const toolEntries = personaToolEntries(createToolRegistry(SOURCE_CATALOG))
    const personas = loadStandalonePersonaRegistry(PERSONA_DIR, registry().captureRevision().skills, toolEntries)
    const reviewer = personas.get("reviewer-uat")
    if (!reviewer || reviewer.kind !== "persona") throw new Error("Missing reviewer-uat")
    const tools = personaToolNames(reviewer, personas)
    expect(tools).toContain("ios_simulator")
    expect(tools).toContain("bash")
  })

  test("reports a settings row in a source catalog and a known, uninstalled row in the shipped one", () => {
    const source = moduleProtocolRows(MODULE_IDS, SOURCE_CATALOG).find((row) => row.id === "development");
    expect(source).toMatchObject({ installed: true, effective: true, setting: { label: "Development tools", group: "Tools" } });
    const shipped = moduleProtocolRows(MODULE_IDS).find((row) => row.id === "development");
    expect(shipped).toEqual({ id: "development", installed: false, effective: false, dependencies: [] });
  });

  test("a shipped catalog decodes and composes a selection that disables development", () => {
    const selection = moduleSelectionFromConfig({ disabled_modules: ["development"] });
    if (!selection.ok) throw new Error(selection.error);
    expect(selection.moduleIds).not.toContain("development");
    const composition = composeRealmModuleSnapshot({ moduleIds: selection.moduleIds });
    expect(composition.enabledModuleIds).toEqual(MODULE_IDS.filter((id) => id !== "development"));
  });

  test("the retired benchmark spelling selects the development module", () => {
    expect(RETIRED_MODULE_ID_SPELLINGS.get("benchmark")).toBe("development");
    const selection = moduleSelectionFromConfig({ disabled_modules: ["benchmark"] });
    if (!selection.ok) throw new Error(selection.error);
    expect(selection.moduleIds).not.toContain("development");
    expect(selection.moduleIds).toContain("bash");
  });

  test("its definitions load from the bundle and require the module", () => {
    const withBundle = registry().captureRevision();
    for (const id of BUNDLE_SKILL_IDS) {
      const skill = withBundle.skills.skills.get(id);
      expect(skill?.source.kind === "filesystem" ? skill.source.bundle : undefined, id).toBe("development");
      expect(withBundle.skills.corePackages.has(id), id).toBe(false);
    }
    expect(moduleRequirementsForContribution("definitions", "development", SOURCE_CATALOG)).toEqual(["development"]);

    const without = registry([]).captureRevision();
    for (const id of BUNDLE_SKILL_IDS) expect(without.skills.skills.has(id), id).toBe(false);
  });
});

describe("the development module runtime", () => {
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
  const foregroundBashHold = createForegroundBashHoldController(() => {});
  afterAll(async () => {
    await background.close();
    foregroundBashHold.dispose();
  });

  function services(purpose: ModuleRuntimeServices["purpose"], simulator = true): ModuleRuntimeServices {
    const unused = () => { throw new Error("unused") };
    return {
      purpose,
      userDataRoot: "/scratch/flywheel-test-account",
      accountHome: "/scratch/flywheel-test-home",
      projectRoot: "/repo",
      executionCwd: "/repo",
      conversation: { providerSessionKey: "test-conversation", artifactScopeId: "test-conversation" },
      promptKind: "chat",
      model: "test-model",
      servingModel: { model: "test-model", modelFamily: "anthropic" },
      personas: new Map(),
      childSlots: createChildSlotRegistry(),
      definitions: registry(),
      createRunner: unused,
      createLLMClient: unused,
      captureRuntimeConfig: testRuntimeConfigCapture,
      captureProviderConnection: unused,
      awaitModelAccessSettled: async () => {},
      usageProfile: { profileId: "default", authorityIncarnation: "test-authority", acquireAuthority: unused },
      budgetStreamId: "test-budget",
      auxiliaryRequestAudit: createProviderRequestAuditWriter({ identity: { providerSessionKey: "test-conversation" }, promptKind: "chat" }),
      onEvent: () => {},
      loadedSkillIds: new Set(),
      moduleSelection: () => composeFirstPartyModules(SOURCE_CATALOG),
      launcher: refusingLauncher,
      background,
      foregroundBashHold,
      modules: simulator
        ? composeModuleServices([["development", { execute: unused, dispose: () => {} }]])
        : NO_MODULE_SERVICES,
      inheritableRuntimeSurfaces: {},
    };
  }

  test("gives every owned runner simulator control and restricts benchmark admission to interactive chat", () => {
    expect(developmentModule.runtime.create(services({ kind: "interactive-chat" }))).toMatchObject({
      benchmark: { profileId: "default", authorityIncarnation: "test-authority" },
      iosSimulator: { name: "ios_simulator" },
    });
    for (const runtime of [
      developmentModule.runtime.create(services({ kind: "workflow-follow-up" })),
      developmentModule.runtime.create(services({ kind: "persona-benchmark" })),
      developmentModule.runtime.create({ ...services({ kind: "interactive-chat" }), launcher: undefined }),
    ]) {
      expect(runtime?.benchmark).toBeUndefined()
      expect(runtime?.iosSimulator).toMatchObject({ name: "ios_simulator" })
    }
    expect(developmentModule.runtime.create(services({ kind: "workflow-follow-up" }, false))).toBeUndefined();
  });
});
