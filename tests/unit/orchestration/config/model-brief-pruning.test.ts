import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelConfigValidity } from "../../../../src/orchestration/app-service/model-assignment-service.js";
import { pruneStaleConfig, updateModelAssignment } from "../../../../src/orchestration/config/writer.js";
import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-step-pruning-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
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
      pruneStaleConfig(modelConfigValidity({ personas: new Map() }), { configPath, authProfileId: () => "personal" });
      updateModelAssignment(roleSlot("chat"), { model: "gpt-5.5" }, { configPath, authProfileId: () => "personal" });
      const text = await readFile(configPath, "utf8");
      for (const id of valid) expect(text).toContain(`[profiles.personal.roles."${id}"]`);
      expect(text).toContain('model = "gpt-5.5"');
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
      await updateModelAssignment(roleSlot("brief.plan-review.persona.reviewer"), { model: "gpt-5-mini" }, { configPath, authProfileId: () => "personal" });
      await updateModelAssignment(roleSlot("brief.plan-review.persona.reviewer"), { model: null }, { configPath, authProfileId: () => "personal" });
      const text = await readFile(configPath, "utf8");
      expect(text).not.toContain("brief.plan-review.persona.reviewer");
    });
  });
});
