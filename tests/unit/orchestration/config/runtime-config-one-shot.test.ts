import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema.js";
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";
import { loadConfig } from "../../../../src/orchestration/config/loader.js";
import { migrateModelAssignments } from "../../../../src/orchestration/config/writer.js";

const temporaryDirectory = temporaryDirectories();

async function writeConfig(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

describe("one-shot runtime config boundaries", () => {
  test.each([
    '[roles.chat]\nmodel = "retired"\n',
    '["roles"."chat"]\nmodel = "retired"\n',
    'roles.chat.model = "retired"\n',
    'roles = { chat = { model = "retired" } }\n',
    '[model_efforts]\n"gpt-6-luna" = "high"\n',
    '["model_efforts"]\n"gpt-6-luna" = "high"\n',
    'model_efforts."gpt-6-luna" = "high"\n',
    'model_efforts = { "gpt-6-luna" = "high" }\n',
    'model_efforts = { "gpt-6-luna" = "high" }\n[roles.chat]\nmodel = "retired"\n',
  ])("shares root retirement with startup migration and blocking loads: %s", async (rootRoles) => {
    const root = temporaryDirectory("config-retirement-");
    const configPath = join(root, "flywheel.toml");
    const sibling = '[profiles.personal.roles.chat]\nmodel = "gpt-6-luna"\neffort = "low"\n[profiles.other]\nallow_training_routes = true\n';
    const source = `show_thinking = true\n${rootRoles}${sibling}`;
    writeFileSync(configPath, source);
    const owner = await createRuntimeConfigOwner({ configPath, userDataRoot: root, env: {}, watch: false });
    const first = owner.snapshot();
    await owner.dispose();
    const committed = readFileSync(configPath, "utf8");
    expect(Bun.TOML.parse(committed)).toEqual({
      show_thinking: true,
      profiles: {
        ...(Object.hasOwn(Bun.TOML.parse(rootRoles), "roles") ? { default: { roles: { chat: { model: "retired" } } } } : {}),
        personal: { roles: { chat: { model: "gpt-6-luna", effort: "low" } } },
        other: { allow_training_routes: true },
      },
    });
    expect(first.config.show_thinking).toBe(true);
    expect(first.config.profiles.personal?.roles.chat?.model).toBe("gpt-6-luna");
    expect(first.config.profiles.personal?.roles.chat?.effort).toBe("low");
    expect(loadConfig(configPath, {}, root).config).toEqual(first.config);
    expect(readFileSync(configPath, "utf8")).toBe(committed);
    writeFileSync(configPath, source);
    expect(migrateModelAssignments({ configPath, userDataRoot: root })).toEqual({ ok: true });
    expect(readFileSync(configPath, "utf8")).toBe(committed);
    writeFileSync(configPath, source);
    expect(loadConfig(configPath, {}, root).config).toEqual(first.config);
    expect(readFileSync(configPath, "utf8")).toBe(committed);
  });

  test("AuthProfileManager uses an injected one-shot snapshot instead of disk loading", async () => {
    const root = temporaryDirectory("flywheel-one-shot-auth-");
    const configPath = join(root, "flywheel.toml");
    await writeConfig(configPath, "malformed = [");
    const manager = new AuthProfileManager({
      userDataRoot: root,
      projectRoot: root,
      configPath,
      config: () => CONFIG_DEFAULTS,
    });

    const profile = await manager.resolve();
    expect(profile.id).toBe("default");
    expect(profile.source).toBe("default");
  });
});
