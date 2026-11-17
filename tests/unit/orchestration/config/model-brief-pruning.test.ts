import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAsyncEventReadSurface, type AsyncEventWriter } from "../../../../src/infra/event-store-types.js";
import { authDir } from "../../../../src/infra/paths.js";
import { createDefinitionAvailability } from "../../../../src/orchestration/app-service/definition-availability.js";
import { createRuntimeModelAssignmentService } from "../../../../src/orchestration/app-service/model-assignment-service.js";
import { decodeModuleState } from "../../../../src/orchestration/config/module-descriptor.js";
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema.js";
import { pruneStaleConfig, updateModelAssignments } from "../../../../src/orchestration/config/writer.js";
import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { createPersonaRegistryOwner, type PersonaRegistryRevision } from "../../../../src/workflows/agents/registry.js";
import { testDirectories } from "../../../helpers/directories.js";
import { fakeListingClient } from "../../../helpers/fake-listing-client.js";
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js";
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js";
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js";
import { AVAILABLE_MODELS, managerDouble, pickerEligibility, providerModelCatalogs } from "../app-service/model-assignment-service-fixtures.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-step-pruning-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const UNUSED_EVENT_WRITER = {
  append: async () => { throw new Error("unused event writer") },
  appendBatch: async () => { throw new Error("unused event writer") },
  pruneSupersededEvents: async () => { throw new Error("unused event writer") },
} satisfies AsyncEventWriter;

/** Opens the model picker's defaults of the `personal` profile over
 *  `configPath` while the project's persona registry is `personaRevision`.
 *  The listing prunes the stale role sections before it reads them. */
async function openPicker(dir: string, configPath: string, personaRevision: PersonaRegistryRevision): Promise<void> {
  const directories = testDirectories(dir);
  const definitionRevision = { ...repoDefinitions().captureRevision(), personaRevision, personas: personaRevision.personas };
  const availability = await createDefinitionAvailability({
    definitions: { captureRevision: () => definitionRevision },
    modules: repoModules,
    capabilities: { state: () => ({ ...decodeModuleState(""), capabilities: [], moduleIds: [] }) },
    agentTypes: { disabled: () => [] },
  });
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, configPath, watch: false });
  const moduleSelection = () => composeFirstPartyModules();
  try {
    const service = createRuntimeModelAssignmentService({
      roleCaptureStore: managerDouble(),
      sessionStore: { get: () => undefined },
      projectRoot: dir,
      eventStore: asAsyncEventReadSurface(inMemoryEventReader([])),
      eventWriter: UNUSED_EVENT_WRITER,
      availability,
      moduleSelection,
      config: () => runtimeConfig.snapshot().config,
      refreshConfig: async () => (await runtimeConfig.refresh()).config,
      configDepsForScope: () => ({
        userDataRoot: directories.userDataRoot,
        authDirectory: () => authDir(directories.userDataRoot, "personal"),
        authProfileId: () => "personal",
        resolveKey: async () => undefined,
        moduleSelection,
        configPath,
        config: CONFIG_DEFAULTS,
        auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
        availableModels: AVAILABLE_MODELS,
        providerModelEligibility: pickerEligibility,
        providerModelCatalogs,
        listingClient: fakeListingClient(AVAILABLE_MODELS),
        modelsClient: fakeModelsClient,
        modelInfos: fakeModelsClient.modelInfos,
      }),
    });
    await service.loadAssignments({ scope: { kind: "defaults" }, slots: [] });
  } finally {
    await runtimeConfig.dispose();
  }
}

describe("step model assignments", () => {
  test("migrates model identities before pruning unknown role sections", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(configPath, '[profiles.personal.roles.chat]\nmodel = "claude-sonnet-4-5"\n\n[profiles.personal.roles.retired]\nmodel = "gpt-5-mini"\n');
      pruneStaleConfig({ roleIds: new Set(["chat"]) }, { configPath, authProfileId: () => "personal" });
      const text = await readFile(configPath, "utf8");
      expect(text).toContain('model = "claude-sonnet-4.5"');
      expect(text).not.toContain("[profiles.personal.roles.retired]");
    });
  });

  test("preserves file brief seats and custom personas while pruning unknown persona roles", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      const valid = ["brief.plan", "brief.removed", "brief.myflow.review.at.review", "custom-review", "brief.plan.persona.custom-review"];
      const invalid = ["removed-role", "brief.plan.persona.removed-role"];
      await writeFile(configPath, [...valid, ...invalid].map((id) => `[profiles.personal.roles."${id}"]\nmodel = "gpt-5-mini"\n`).join("\n"));
      pruneStaleConfig({ roleIds: new Set(["custom-review"]) }, { configPath, authProfileId: () => "personal" });
      const text = await readFile(configPath, "utf8");
      for (const id of valid) expect(text).toContain(`[profiles.personal.roles."${id}"]`);
      for (const id of invalid) expect(text).not.toContain(`[profiles.personal.roles."${id}"]`);
    });
  });

  test("keeps saved file and retired brief defaults through an unrelated model write", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      const valid = ["brief.myflow.review", "brief.debug.fix"];
      await writeFile(configPath, valid.map((id) => `[profiles.personal.roles."${id}"]\nmodel = "gpt-5-mini"\n`).join("\n"));
      await openPicker(dir, configPath, { revision: "none", personas: new Map(), resolutions: [] });
      updateModelAssignments({ mutations: [{ slot: roleSlot("chat"), patch: { model: "gpt-5.5" } }] }, { configPath, authProfileId: () => "personal" });
      const text = await readFile(configPath, "utf8");
      for (const id of valid) expect(text).toContain(`[profiles.personal.roles."${id}"]`);
      expect(text).toContain('model = "gpt-5.5"');
    });
  });

  test("a persona file that fails to parse keeps every saved role section until it loads", async () => {
    await withTempDir(async (dir) => {
      const agentsDir = join(dir, "agents");
      await mkdir(agentsDir);
      await writeFile(join(agentsDir, "auditor.md"), "---\nname: auditor\ndescription: Audits changes.\nrole: custom-auditor\ntools: [read]\n---\nCheck the changes.\n");
      const brokenPath = join(agentsDir, "scout.md");
      await writeFile(brokenPath, "---\nname: scout\ndescription: Scouts.\nrole: custom-scout\ntools: [read]\nunknownKey: true\n---\nScout.\n");
      const configPath = join(dir, "flywheel.toml");
      const sections = ["custom-auditor", "custom-scout", "removed-role"];
      await writeFile(configPath, sections.map((id) => `[profiles.personal.roles."${id}"]\nmodel = "gpt-5-mini"\n`).join("\n"));
      const owner = createPersonaRegistryOwner(join(dir, "no-bundled-personas"));

      await openPicker(dir, configPath, owner.load(repoDefinitions().skills(), undefined, agentsDir));
      const kept = await readFile(configPath, "utf8");
      for (const id of sections) expect(kept).toContain(`[profiles.personal.roles."${id}"]`);

      await writeFile(brokenPath, "---\nname: scout\ndescription: Scouts.\nrole: custom-scout\ntools: [read]\n---\nScout.\n");
      await openPicker(dir, configPath, owner.load(repoDefinitions().skills(), undefined, agentsDir));
      const pruned = await readFile(configPath, "utf8");
      expect(pruned).toContain('[profiles.personal.roles."custom-scout"]');
      expect(pruned).not.toContain('[profiles.personal.roles."removed-role"]');
    });
  });

  test("failed validation commits neither migration nor pruning", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      const source = '[profiles.personal.roles.chat]\nmodel = "claude-sonnet-4-5"\neffort = "invalid"\n\n[profiles.personal.roles.retired]\nmodel = "gpt-5-mini"\n';
      await writeFile(configPath, source);
      expect(() => pruneStaleConfig({ roleIds: new Set(["chat"]) }, { configPath, authProfileId: () => "personal" })).toThrow();
      expect(await readFile(configPath, "utf8")).toBe(source);
    });
  });

  test("definition-scoped step-agent section retained when step definition exists but active workflow omits it", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(
        configPath,
        [
          `[profiles.personal.roles."brief.plan-review.persona.reviewer"]`,
          `model = "gpt-5-mini"`,
          ``,
          `[profiles.personal.roles.chat]`,
          `model = "gpt-5-mini"`,
          ``,
        ].join("\n"),
      );

      // A partial slot read must not remove settings for other briefs.
      pruneStaleConfig(
        {
          roleIds: new Set(["chat", "brief.implement", "brief.implement.persona.implementer"]),
        },
        { configPath, authProfileId: () => "personal" },
      );

      const text = await readFile(configPath, "utf8");
      expect(text).toContain('[profiles.personal.roles."brief.plan-review.persona.reviewer"]');
      expect(text).toContain("[profiles.personal.roles.chat]");
    });
  });

  test("file brief persona section is kept when active slots omit it", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(
        configPath,
        [
          `[profiles.personal.roles."brief.uuid-runtime-123.persona.reviewer"]`,
          `model = "gpt-5-mini"`,
          ``,
          `[profiles.personal.roles.chat]`,
          `model = "gpt-5-mini"`,
          ``,
        ].join("\n"),
      );

      pruneStaleConfig(
        {
          roleIds: new Set(["chat"]),
        },
        { configPath, authProfileId: () => "personal" },
      );

      const text = await readFile(configPath, "utf8");
      expect(text).toContain("uuid-runtime-123");
      expect(text).toContain("[profiles.personal.roles.chat]");
    });
  });

  test("global reviewer section retained even when no active workflow step declares reviewer subagents", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(
        configPath,
        [
          `[profiles.personal.roles.reviewer]`,
          `model = "gpt-5-mini"`,
          ``,
          `[profiles.personal.roles.chat]`,
          `model = "gpt-5-mini"`,
          ``,
        ].join("\n"),
      );

      // Reviewer is known even when the current workflow does not use it.
      pruneStaleConfig(
        {
          roleIds: new Set(["chat", "brief.implement"]),
        },
        { configPath, authProfileId: () => "personal" },
      );

      const text = await readFile(configPath, "utf8");
      expect(text).toContain("[profiles.personal.roles.reviewer]");
      expect(text).toContain("[profiles.personal.roles.chat]");
    });
  });

  test("clearing the final field from a step-agent section removes that empty section from TOML", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await updateModelAssignments({ mutations: [{ slot: roleSlot("brief.plan-review.persona.reviewer"), patch: { model: "gpt-5-mini" } }] }, { configPath, authProfileId: () => "personal" });
      await updateModelAssignments({ mutations: [{ slot: roleSlot("brief.plan-review.persona.reviewer"), patch: { model: null } }] }, { configPath, authProfileId: () => "personal" });
      const text = await readFile(configPath, "utf8");
      expect(text).not.toContain("brief.plan-review.persona.reviewer");
    });
  });
});
