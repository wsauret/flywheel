import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { migrateLegacyCapabilityModules } from "../../../../src/orchestration/modules.js";
import { MODULE_IDS } from "../../../../src/protocol/module-ids.js";
import { ConfigWriteError } from "../../../../src/orchestration/config/writer.js";
import { decodeModuleState } from "../../../../src/orchestration/config/module-descriptor.js";
import { decodeCanonicalConfigText } from "../../../../src/orchestration/config/loader.js";
import { createModulePolicy } from "../../../../src/orchestration/config/module-policy.js";
import {
  applyModulePreset,
  migrateCapabilityModules,
  updateModuleMember,
  updateCapabilityModules,
  updateWorkflowsMode,
} from "../../../../src/orchestration/config/module-selection-writer.js";

const providerModules = MODULE_IDS.filter((id) => id.startsWith("provider-"));

async function withConfig(source: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-settings-"));
  const path = join(dir, "flywheel.toml");
  try {
    await writeFile(path, source);
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function persistedDisabledModules(enabled: readonly string[]): readonly string[] {
  const selected = new Set(enabled);
  return MODULE_IDS.filter((id) => !selected.has(id));
}

function expectPersistedSelection(text: string, enabled: readonly string[]): void {
  const disabled = persistedDisabledModules(enabled);
  expect(text).not.toMatch(/^modules\s*=/m);
  expect(text).not.toMatch(/^capability_modules\s*=/m);
  if (disabled.length === 0) expect(text).not.toMatch(/^disabled_modules\s*=/m);
  else expect(text).toContain(`disabled_modules = [${disabled.map((id) => `"${id}"`).join(", ")}]`);
  expect(decodeModuleState(text).moduleIds).toEqual(MODULE_IDS.filter((id) => enabled.includes(id)));
}

function migratedLegacyModules(value: readonly string[]): readonly string[] {
  const selection = migrateLegacyCapabilityModules(value);
  if (!selection.ok) throw new Error(selection.error);
  return selection.moduleIds;
}

describe("complete and member capability module writes", () => {
  // Remove with the enabled_modules conversion after 2027-04-08.
  test("reads a retired enabled_modules list as the default selection, and startup and the next write remove it", async () => {
    for (const source of [
      'enabled_modules = ["provider-claude-subscription"]\n',
      'enabled_modules = ["provider-claude-agent-sdk", "provider-claude-subscription"]\n',
      "enabled_modules = []\n",
    ]) {
      const state = decodeModuleState(source);
      expect(state.error).toBeUndefined();
      expect(state.moduleIds).toEqual(MODULE_IDS);
      await withConfig(source, async (path) => {
        expect(await updateModuleMember("learning", true, false, { configPath: path })).toEqual({ ok: true });
        expect(Bun.TOML.parse(await readFile(path, "utf8"))).toEqual({ disabled_modules: ["learning"] });
      });
      await withConfig(`show_thinking = true\n${source}`, async (path) => {
        expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
        expect(await readFile(path, "utf8")).toBe("show_thinking = true\n");
      });
    }
  });

  test("refuses a retired enabled_modules list that names any other module, and Full repairs it", async () => {
    for (const source of [
      'enabled_modules = ["provider-anthropic-api"]\n',
      'enabled_modules = "provider-claude-subscription"\n',
      'enabled_modules = ["provider-claude-subscription", "unknown"]\n',
      'disabled_modules = ["provider-claude-subscription"]\n',
    ]) {
      await withConfig(source, async (path) => {
        const state = decodeModuleState(source);
        expect(state.error).toBeDefined();
        expect(await applyModulePreset("full", { descriptorIdentity: state.identity }, { configPath: path })).toEqual({ ok: true });
        const repaired = await readFile(path, "utf8");
        expect(Object.hasOwn(Bun.TOML.parse(repaired), "enabled_modules")).toBe(false);
        expect(decodeModuleState(repaired).error).toBeUndefined();
        expect(decodeModuleState(repaired).moduleIds).toEqual(MODULE_IDS);
      });
    }
  });

  test("writes complete selections as a canonical disabled complement and is byte-idempotent", async () => {
    await withConfig('show_thinking = true\n\n[profiles.personal.roles.chat]\nmodel = "gpt-5.4-mini"\n', async (path) => {
      expect(await updateCapabilityModules(["skills", "learning", "file-tools"], { configPath: path })).toEqual({ ok: true });
      const text = await readFile(path, "utf8");
      expectPersistedSelection(text, ["file-tools", "learning", "skills"]);
      expect(text).toContain("show_thinking = true");
      expect(text.indexOf("disabled_modules")).toBeLessThan(text.indexOf("[profiles.personal.roles.chat]"));
      expect(await updateCapabilityModules(["file-tools", "skills", "learning"], { configPath: path })).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toBe(text);
    });
  });

  test("writes the empty selection, and a selection whose dependency is off", async () => {
    await withConfig('modules = ["skills"]\n', async (path) => {
      expect(await updateCapabilityModules([], { configPath: path })).toEqual({ ok: true });
      expectPersistedSelection(await readFile(path, "utf8"), []);
      expect(await updateCapabilityModules(["workflows"], { configPath: path })).toEqual({ ok: true });
      const state = decodeModuleState(await readFile(path, "utf8"));
      expect(state.moduleIds).toEqual(["workflows"]);
      expect(state.capabilities).toEqual([]);
    });
  });

  test("adds and removes one member while unrelated bytes survive", async () => {
    const source = '# account settings\nshow_thinking = true\nmodules = ["skills"]\n\n[profiles.personal.roles.chat]\nmodel = "gpt-5.4-mini"\n';
    await withConfig(source, async (path) => {
      expect(await updateModuleMember("learning", false, true, { configPath: path })).toEqual({ ok: true });
      const added = await readFile(path, "utf8");
      expectPersistedSelection(added, ["definition-overrides", "experiments", "learning", "mcp", "papercuts", "project-notifications", ...providerModules, "side-question", "skills"]);
      expect(added).toContain("# account settings");
      expect(added).toContain('[profiles.personal.roles.chat]\nmodel = "gpt-5.4-mini"');
      expect(await updateModuleMember("learning", true, false, { configPath: path })).toEqual({ ok: true });
      expectPersistedSelection(await readFile(path, "utf8"), ["definition-overrides", "experiments", "mcp", "papercuts", "project-notifications", ...providerModules, "side-question", "skills"]);
    });
  });

  test("concurrent member updates re-read inside ownership and lose no update", async () => {
    await withConfig(`modules = ${JSON.stringify(MODULE_IDS)}\n`, async (path) => {
      await Promise.all([
        updateModuleMember("learning", true, false, { configPath: path }),
        updateModuleMember("subagents", true, false, { configPath: path }),
      ]);
      const text = await readFile(path, "utf8");
      expectPersistedSelection(text, MODULE_IDS.filter((id) => id !== "learning" && id !== "subagents"));
    });
  });

  test("member writes refuse invalid state without mutation", async () => {
    const source = 'modules = ["skills", "unknown"]\n';
    await withConfig(source, async (path) => {
      expect((await updateModuleMember("learning", false, true, { configPath: path })).ok).toBe(false);
      expect(await readFile(path, "utf8")).toBe(source);
    });
  });

  // Remove with the retired module-id conversion after 2027-04-30.
  test.each(['disabled_modules = ["adhoc-workflows"]\n', 'disabled_modules = ["adhoc-workflows", "workflows"]\n'])("a retired workflow opt-out keeps Workflows off and the next selection write replaces its id: %s", async (initial) => {
    await withConfig(initial, async (path) => {
      const source = await readFile(path, "utf8");
      const off = decodeModuleState(source);
      expect(off.error).toBeUndefined();
      expect(off.capabilities).not.toContain("workflows");
      expect(off.workflowsMode).toBe("off");
      expect(off.warnings).toEqual(['flywheel.toml disabled_modules names "adhoc-workflows", the retired Ad hoc workflows module. Flywheel reads it as "workflows", so Workflows is Off. The next settings change writes "workflows" in its place.']);
      const loaded = decodeCanonicalConfigText(source, {});
      expect(loaded.warnings).toEqual([...off.warnings]);
      const policy = await createModulePolicy({ configPath: path });
      try {
        const admission = await policy.admit({ operation: "skills probe", required: ["skills"] });
        if (!admission.ok) throw new Error(admission.reason);
        expect(admission.grant).not.toHaveProperty("warnings");
      } finally {
        policy.dispose();
      }
      expect(await updateModuleMember("skills", true, false, { configPath: path })).toEqual({ ok: true });
      const rewritten = await readFile(path, "utf8");
      expect(Bun.TOML.parse(rewritten)).toEqual({ disabled_modules: ["skills", "workflows"] });
      expect(rewritten).not.toContain("adhoc-workflows");
    });
  });
});

describe("capability presets and workflow mode", () => {
  test("Full writes the catalog and ON while Minimal preserves confirmation", async () => {
    await withConfig('modules = ["skills"]\nrequire_workflow_confirmation = true\n', async (path) => {
      expect(await applyModulePreset("full", { descriptorIdentity: decodeModuleState('modules = ["skills"]\nrequire_workflow_confirmation = true\n').identity }, { configPath: path })).toEqual({ ok: true });
      const full = await readFile(path, "utf8");
      expectPersistedSelection(full, MODULE_IDS);
      expect(full).toContain("require_workflow_confirmation = false");
      expect(await applyModulePreset("minimal", { descriptorIdentity: decodeModuleState(full).identity }, { configPath: path })).toEqual({ ok: true });
      const minimal = await readFile(path, "utf8");
      expectPersistedSelection(minimal, []);
      expect(minimal).toContain("require_workflow_confirmation = false");
    });
  });

  test("repairs the invalid descriptor currently held by the caller", async () => {
    const source = 'modules = ["unknown-a"]\nshow_thinking = true\n';
    await withConfig(source, async (path) => {
      const expected = decodeModuleState(source);
      expect(expected.error).toContain("unknown-a");
      expect(await applyModulePreset("minimal", { descriptorIdentity: expected.identity }, { configPath: path })).toEqual({ ok: true });
      const repaired = await readFile(path, "utf8");
      expectPersistedSelection(repaired, []);
      expect(repaired).toContain("show_thinking = true");
    });
  });

  test("rejects a stale invalid descriptor after a different invalid edit", async () => {
    const first = 'modules = ["unknown-a"]\n';
    const second = 'modules = ["unknown-b"]\n';
    await withConfig(first, async (path) => {
      const expected = decodeModuleState(first);
      await writeFile(path, second);
      const result = await applyModulePreset("minimal", { descriptorIdentity: expected.identity }, { configPath: path });
      expect(result.ok).toBe(false);
      expect(await readFile(path, "utf8")).toBe(second);
    });
  });

  test("does not stale a preset after an unrelated config edit", async () => {
    const first = 'modules = ["skills"]\nshow_thinking = true\n';
    const second = 'modules = ["skills"]\nshow_thinking = false\n';
    await withConfig(first, async (path) => {
      const expected = decodeModuleState(first);
      await writeFile(path, second);
      expect(await applyModulePreset("minimal", { descriptorIdentity: expected.identity }, { configPath: path })).toEqual({ ok: true });
      const updated = await readFile(path, "utf8");
      expectPersistedSelection(updated, []);
      expect(updated).toContain("show_thinking = false");
    });
  });

  test("workflow mode changes capability and preference in one commit", async () => {
    await withConfig('modules = ["ask-user", "skills"]\nrequire_workflow_confirmation = true\n', async (path) => {
      expect(await updateWorkflowsMode("off", "on", { configPath: path })).toEqual({ ok: true });
      expectPersistedSelection(await readFile(path, "utf8"), ["ask-user", "definition-overrides", "experiments", "side-question", "skills", "workflows", "mcp", "papercuts", "project-notifications", ...providerModules]);
      expect(await readFile(path, "utf8")).toContain("require_workflow_confirmation = false");
      expect(await updateWorkflowsMode("on", "off", { configPath: path })).toEqual({ ok: true });
      const off = await readFile(path, "utf8");
      expectPersistedSelection(off, ["ask-user", "definition-overrides", "experiments", "side-question", "skills", "mcp", "papercuts", "project-notifications", ...providerModules]);
      expect(off).toContain("require_workflow_confirmation = false");
      expect(await updateWorkflowsMode("off", "ask", { configPath: path })).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toContain("require_workflow_confirmation = true");
    });
  });

  test("workflow mode refuses enablement without Skills", async () => {
    const source = 'modules = ["subagents"]\nrequire_workflow_confirmation = true\n';
    await withConfig(source, async (path) => {
      const result = await updateWorkflowsMode("off", "ask", { configPath: path });
      expect(result.ok).toBe(false);
      expect(await readFile(path, "utf8")).toBe(source);
    });
  });
});

const MULTILINE_MODULES = [
  "# account settings",
  "show_thinking = true",
  "modules = [",
  '  "ask-user",',
  '  "workflows",',
  '  "skills", # workflows depends on this one',
  "] # selection ends here",
  "require_workflow_confirmation = true",
  "",
  "[profiles.personal.roles.chat]",
  'model = "gpt-5.4-mini"',
  "",
].join("\n");

describe("multiline TOML and line endings", () => {
  test("complete, member, and workflow writers replace the entire multiline value", async () => {
    const writers = [
      { run: async (path: string) => await updateCapabilityModules(["skills", "learning"], { configPath: path }), enabled: ["skills", "learning"] },
      { run: async (path: string) => await updateModuleMember("learning", false, true, { configPath: path }), enabled: ["ask-user", "definition-overrides", "experiments", "workflows", "side-question", "skills", "learning", "mcp", "papercuts", "project-notifications", ...providerModules] },
      { run: async (path: string) => await updateWorkflowsMode("ask", "on", { configPath: path }), enabled: ["ask-user", "definition-overrides", "experiments", "workflows", "side-question", "skills", "mcp", "papercuts", "project-notifications", ...providerModules] },
    ];
    for (const writer of writers) {
      await withConfig(MULTILINE_MODULES, async (path) => {
        expect((await writer.run(path)).ok).toBe(true);
        const text = await readFile(path, "utf8");
        expect(occurrences(text, "disabled_modules = ")).toBe(1);
        expectPersistedSelection(text, writer.enabled);
        expect(text).toContain("# account settings");
        expect(text).toContain('[profiles.personal.roles.chat]\nmodel = "gpt-5.4-mini"');
        expect(text).not.toContain("# workflows depends on this one");
      });
    }
  });

  test("preserves CRLF bytes outside the replaced value", async () => {
    const source = 'show_thinking = true\r\nmodules = [\r\n  "workflows",\r\n  "skills",\r\n]\r\n';
    await withConfig(source, async (path) => {
      expect(await updateCapabilityModules(["skills"], { configPath: path })).toEqual({ ok: true });
      const text = await readFile(path, "utf8");
      expect(text).toContain("show_thinking = true\r\n");
      expect(text).toContain(`disabled_modules = [${MODULE_IDS.filter((id) => id !== "skills").map((id) => `"${id}"`).join(", ")}]\n`);
      expect(text).not.toMatch(/^modules\s*=/m);
      expect(text).not.toContain("# selection ends here");
    });
  });
});

describe("strict legacy capability migration", () => {
  test.each(["modules", "capability_modules"])("migrates %s to its disabled complement without disabling providers", async (key) => {
    const source = `${key} = ["skills"]\n`;
    await withConfig(source, async (path) => {
      expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
      const text = await readFile(path, "utf8");
      expectPersistedSelection(text, ["definition-overrides", "experiments", "side-question", "skills", "mcp", "papercuts", "project-notifications", ...providerModules]);
      expect(text).not.toContain('"provider-google-vertex"');
      expect(text).not.toContain('"experiments"');
      expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toBe(text);
    });
  });

  test("preserves explicit module and provider disablement without rewriting", async () => {
    const source = 'disabled_modules = ["experiments", "provider-openai-api"]\n';
    await withConfig(source, async (path) => {
      expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toBe(source);
    });
  });

  test("leaves an absent module-selection key byte-identical", async () => {
    const source = "show_thinking = true\n";
    await withConfig(source, async (path) => {
      expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toBe(source);
      expect(decodeModuleState(source).moduleIds).toContain("provider-anthropic-api");
      expect(decodeModuleState(source).moduleIds).toContain("provider-chatgpt");
      expect(decodeModuleState(source).moduleIds).toContain("provider-openai-api");
    });
  });

  test("migrates every supported legacy selection member while enabling formerly core modules", async () => {
    const legacyIds = ["workflows", "skills", "subagents", "learning", "background_commands"] as const;
    for (const id of legacyIds) {
      const selection = id === "workflows" ? ["workflows", "skills"] : [id];
      await withConfig(`features = ${JSON.stringify(selection)}\n`, async (path) => {
        expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
        const text = await readFile(path, "utf8");
        expect(text).not.toContain("features =");
        expectPersistedSelection(text, migratedLegacyModules(selection));
      });
    }
  });

  test("migrates empty legacy selection and an enabled obsolete Learning authority", async () => {
    await withConfig("features = []\n", async (path) => {
      expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
      const text = await readFile(path, "utf8");
      expect(text).not.toContain("features =");
      expectPersistedSelection(text, migratedLegacyModules([]));
    });
    await withConfig("[self_improvement]\nenabled = true\n", async (path) => {
      expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
      const text = await readFile(path, "utf8");
      expect(text).not.toContain("self_improvement");
      expectPersistedSelection(text, MODULE_IDS);
    });
  });

  test("migrates every removable obsolete Learning form", async () => {
    const forms = [
      "[self_improvement]\nenabled = false\n",
      "self_improvement.enabled = false\n",
      "self_improvement = { enabled = false }\n",
      '["self_improvement"]\n"enabled" = false\n',
      '"self_improvement"."enabled" = false\n',
    ];
    for (const source of forms) {
      await withConfig(source, async (path) => {
        expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
        const text = await readFile(path, "utf8");
        expect(text).not.toContain("self_improvement");
        expectPersistedSelection(text, MODULE_IDS.filter((id) => id !== "learning"));
      });
    }
  });

  test("canonical selection decides Learning and migration is byte-idempotent", async () => {
    await withConfig('modules = ["skills", "learning"]\n[self_improvement]\nenabled = false\n', async (path) => {
      const first = await migrateCapabilityModules({ configPath: path });
      expect(first.write).toEqual({ ok: true });
      expect(first.notice).toContain("module selection decides Learning");
      const migrated = await readFile(path, "utf8");
      expectPersistedSelection(migrated, ["definition-overrides", "experiments", "side-question", "skills", "learning", "mcp", "papercuts", "project-notifications", ...providerModules]);
      expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toBe(migrated);
    });
  });

  test("legacy migration preserves CRLF bytes outside removed authorities", async () => {
    await withConfig("show_thinking = true\r\n[self_improvement]\r\nenabled = false\r\n", async (path) => {
      expect((await migrateCapabilityModules({ configPath: path })).write).toEqual({ ok: true });
      const text = await readFile(path, "utf8");
      expect(text).toContain("show_thinking = true\r\n");
      expect(text).toContain('disabled_modules = ["learning"]\n');
      expect(text).not.toContain("self_improvement");
    });
  });

  test("refuses every malformed, ambiguous, or unclassifiable legacy form byte-for-byte", async () => {
    const refused = [
      'modules = []\nfeatures = []\n',
      'features = ["unknown"]\n',
      'self_improvement.enabled = "false"\n',
      "self_improvement.enabled = 0\n",
      "self_improvement.enabled = [false]\n",
      "self_improvement = false\n",
      "self_improvement.enabled = { value = false }\n",
      "self_improvement = { enabled = false, cadence = 3 }\n",
      'disabled_modules = ["unknown"]\n',
      'require_workflow_confirmation = true\ndisabled_modules = ["ask-user"]\n[self_improvement]\nenabled = false\n',
      'disabled_modules = ["skills"]\nmodules = ["skills"]\n',
    ];
    for (const source of refused) {
      await withConfig(source, async (path) => {
        const result = await migrateCapabilityModules({ configPath: path });
        expect(result.write.ok).toBe(false);
        if (result.write.ok) throw new Error("expected refusal");
        expect(result.write.error).toBeInstanceOf(ConfigWriteError);
        expect(await readFile(path, "utf8")).toBe(source);
      });
    }
  });
});