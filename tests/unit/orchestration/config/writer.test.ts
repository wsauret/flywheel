import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStaleWriteError, updateDefinedSetting, updateModelAssignments } from "../../../../src/orchestration/config/writer.js";
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";
import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js";

async function withConfig(source: string, run: (configPath: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-writer-strict-"));
  try {
    const configPath = join(dir, "flywheel.toml");
    await writeFile(configPath, source);
    await run(configPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function preservesUnknownBytes(source: string): Promise<void> {
  await withConfig(source, async (configPath, dir) => {
    const result = updateDefinedSetting("showThinking", false, { configPath, userDataRoot: dir });
    expect(result.ok).toBe(true);
    const written = await readFile(configPath, "utf8");
    expect(written).toContain("show_thinking = false");
    for (const line of source.trim().split("\n")) expect(written).toContain(line);
  });
}

// Unknown keys are tolerated at the load boundary, so a settings write must
// succeed while leaving the unrecognized bytes untouched in the file.
describe("config writer with unrecognized keys", () => {
  test("preserves undeclared root keys", () => preservesUnknownBytes("unknown_root = true\n"));

  test("preserves undeclared nested keys", () => preservesUnknownBytes("[notifications]\ndesktop = true\nunknown_nested = true\n"));
});

describe("updateDefinedSetting", () => {
  // Each of these settings had its own writer before the generic one replaced it.
  test.each([
    ["theme", "aura", 'theme = "aura"\n'],
    ["showThinking", true, "show_thinking = true\n"],
    ["allowPersistentProcesses", true, "allow_persistent_processes = true\n"],
    ["autoInstall", false, "[updates]\nauto_install = false\n"],
    ["diffColors", "standard", 'diff_colors = "standard"\n'],
    ["proactiveCompactionThreshold", 300_000, "proactive_compaction_threshold = 300000\n"],
  ] as const)("writes each formerly dedicated setting with the same TOML result: %s", async (id, value, expected) => {
    await withConfig("", async (configPath) => {
      expect(updateDefinedSetting(id, value, { configPath })).toEqual({ ok: true });
      expect(await readFile(configPath, "utf8")).toBe(expected);
    });
  });
});

// Every model assignment and project binding write states the value it expects
// to replace, so a write from a stale view of the file changes nothing
// (ARCH-RUNTIME-060).
describe("compare-and-swap model assignment and project binding writes", () => {
  const saved = '[profiles.work.roles.chat]\nmodel = "gpt-5.5"\neffort = "low"\n';
  const saveChat = (configPath: string, dir: string, expected: { readonly kind: "value"; readonly value: { readonly model: string; readonly effort: "low" | "medium" } }) =>
    updateModelAssignments({ mutations: [{ slot: roleSlot("chat"), patch: { model: "gpt-5-mini", effort: "high" }, expected }] }, { configPath, userDataRoot: dir, authProfileId: () => "work" });

  test("A model assignment save whose expected value matches writes and publishes one revision", async () => {
    await withConfig(saved, async (configPath, dir) => {
      const owner = await createRuntimeConfigOwner({ configPath, userDataRoot: dir, watch: false });
      try {
        const before = owner.snapshot().revision;
        saveChat(configPath, dir, { kind: "value", value: { model: "gpt-5.5", effort: "low" } });
        expect(Bun.TOML.parse(await readFile(configPath, "utf8"))).toEqual({ profiles: { work: { roles: { chat: { model: "gpt-5-mini", effort: "high" } } } } });
        expect((await owner.refresh()).revision).toBe(before + 1);
      } finally {
        await owner.dispose();
      }
    });
  });

  test("A save whose expected value is stale writes nothing", async () => {
    await withConfig(saved, async (configPath, dir) => {
      expect(() => saveChat(configPath, dir, { kind: "value", value: { model: "gpt-5.5", effort: "medium" } })).toThrow(ConfigStaleWriteError);
      expect(await readFile(configPath, "utf8")).toBe(saved);
    });
  });

  test("A project-profile binding whose file changed since the manager read it is refused", async () => {
    await withConfig("", async (configPath, dir) => {
      const projectRoot = join(dir, "project");
      const manager = new AuthProfileManager({ userDataRoot: dir, projectRoot, configPath, env: {}, config: () => ({ auth: { project_profiles: {} } }) });
      await manager.create("Work");
      const changed = `[auth.project_profiles]\n${JSON.stringify(projectRoot)} = "other"\n`;
      await writeFile(configPath, changed);
      for (const write of [() => manager.bind("work"), () => manager.unbind()]) {
        const result = await write();
        expect(result.ok ? undefined : result.error).toBeInstanceOf(ConfigStaleWriteError);
      }
      expect(await readFile(configPath, "utf8")).toBe(changed);
    });
  });
});
