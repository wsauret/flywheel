import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelFamily } from "../../../../src/infra/llm/model-family.js";
import { listModelAssignments, resetRoleAssignmentsToDetectedDefaults } from "../../../../src/orchestration/config/model-assignments.js";
import { fakeModelsClient, tierAvailableModels } from "../../../helpers/model-tier-fixtures.js";
import { USER_DATA_ROOT } from "./_config-models-fixtures.js";
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-model-assignment-reset-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const openaiModels = new Map<ModelFamily, ReadonlySet<string>>([
  ["openai", tierAvailableModels.get("openai") ?? new Set()],
]);
// The auth directory lives in the case's own directory: the shared test
// account home can hold credentials another test file left there.
const tierOptions = (dir: string) => ({ userDataRoot: USER_DATA_ROOT, authDirectory: () => join(dir, "auth"), authProfileId: () => "work", resolveKey: async () => undefined, config: CONFIG_DEFAULTS, moduleSelection: () => composeFirstPartyModules(), modelInfos: fakeModelsClient.modelInfos, modelsClient: fakeModelsClient });

describe("resetRoleAssignmentsToDetectedDefaults", () => {
  test("resets role overrides and clears explicit providers", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "flywheel.toml"), [
        "[model_efforts]",
        'gpt-5 = "max"',
        '"claude-opus-4.1" = "high"',
        "",
        "[profiles.work.roles.step-agent]",
        'model = "gpt-5-mini"',
        'effort = "low"',
        'provider = "github_copilot"',
        "",
        "[profiles.work.roles.skill-review]",
        'model = "gpt-5-mini"',
        'effort = "low"',
        "",
      ].join("\n"));

      await resetRoleAssignmentsToDetectedDefaults({
        configPath: join(dir, "flywheel.toml"),
        availableModels: openaiModels,
        ...tierOptions(dir),
      }, () => true);

      const text = await readFile(join(dir, "flywheel.toml"), "utf8");
      expect(text).not.toContain("provider =");
      expect(text).not.toContain("[profiles.work.roles.skill-review]");
      expect(Bun.TOML.parse(text)).not.toHaveProperty("model_efforts");

      const rows = await listModelAssignments({
        configPath: join(dir, "flywheel.toml"),
        availableModels: openaiModels,
        slots: [roleSlot("workflow-agent"), roleSlot("learning-review")],
        ...tierOptions(dir),
      });
      expect(rows[0]).toMatchObject({ model: "gpt-5.4", effort: "medium" });
      expect(rows[1]).toMatchObject({ model: "gpt-5.4", effort: "medium", modelSource: "default" });
    });
  });
});
