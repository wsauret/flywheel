import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveModelAssignment } from "../../../../src/orchestration/config/model-selection.js";

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { NO_CREDENTIALS, USER_DATA_ROOT } from "./_config-models-fixtures.js";

/** Saving writes only the named config file; the account and credential deps stay inert. */
function saveDeps(configPath: string, profileId: string) {
  return {
    configPath,
    authProfileId: () => profileId,
    userDataRoot: USER_DATA_ROOT,
    authDirectory: () => NO_CREDENTIALS,
    resolveKey: async () => undefined,
    moduleSelection: () => composeFirstPartyModules(),
    config: CONFIG_DEFAULTS,
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-model-assignment-save-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("saveModelAssignment", () => {
  test("saves chat model and effort without requiring provider listings", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "flywheel.toml"), "");

      await expect(saveModelAssignment(
        roleSlot("chat"),
        { model: "claude-opus-4-6", effort: "high" },
        saveDeps(join(dir, "flywheel.toml"), "work"),
      )).resolves.toBeUndefined();

      const text = await readFile(join(dir, "flywheel.toml"), "utf8");
      expect(text).toContain("[profiles.work.roles.chat]");
      expect(text).toContain('model = "claude-opus-4-6"');
      expect(text).toContain('effort = "high"');
    });
  });

  test("scrubs a legacy provider line from the section it rewrites", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "flywheel.toml"), `[profiles.work.roles.chat]\nmodel = "gpt-5.5"\nprovider = "openai_api"\n`);

      await expect(saveModelAssignment(
        roleSlot("chat"),
        { model: "gpt-5.5", effort: "low" },
        saveDeps(join(dir, "flywheel.toml"), "work"),
      )).resolves.toBeUndefined();

      const text = await readFile(join(dir, "flywheel.toml"), "utf8");
      expect(text).toContain("[profiles.work.roles.chat]");
      expect(text).toContain('model = "gpt-5.5"');
      expect(text).toContain('effort = "low"');
      expect(text).not.toContain("provider");
    });
  });

  test("clears one profile's assignment without changing another profile", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      await writeFile(configPath, `[profiles.personal.roles.chat]\nmodel = "gpt-5.5"\n\n[profiles.work.roles.chat]\nmodel = "gpt-5-mini"\neffort = "low"\n`);

      await saveModelAssignment(roleSlot("chat"), { model: null, effort: null }, saveDeps(configPath, "work"));

      const text = await readFile(configPath, "utf8");
      expect(text).toContain('[profiles.personal.roles.chat]\nmodel = "gpt-5.5"');
      expect(text).not.toContain("[profiles.work.roles.chat]");
    });
  });

  test("updates and clears a quoted legacy profile without duplicating its section", async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, "flywheel.toml");
      const profileId = 'legacy"profile';
      const options = saveDeps(configPath, profileId);
      const header = '[profiles."legacy\\"profile".roles.chat]';
      await writeFile(configPath, "");

      await saveModelAssignment(roleSlot("chat"), { model: "gpt-5.5", effort: "low" }, options);
      await saveModelAssignment(roleSlot("chat"), { model: "gpt-5-mini", effort: "high" }, options);

      const updated = await readFile(configPath, "utf8");
      expect(updated.split(header)).toHaveLength(2);
      expect(updated).toContain('model = "gpt-5-mini"');
      expect(updated).not.toContain('model = "gpt-5.5"');

      await saveModelAssignment(roleSlot("chat"), { effort: "medium" }, options);
      expect(await readFile(configPath, "utf8")).toContain('effort = "medium"');

      await saveModelAssignment(roleSlot("chat"), { model: null, effort: null }, options);
      expect(await readFile(configPath, "utf8")).not.toContain(header);
    });
  });

});
