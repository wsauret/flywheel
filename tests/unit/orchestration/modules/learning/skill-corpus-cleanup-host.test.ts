import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSkillCorpusCleanupForProject } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup-host.js";
import { runSkillMaintenanceForProject } from "../../../../../src/orchestration/modules/learning/skill-maintenance-host.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { withEventStore } from "../../../../../src/infra/with-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import type { StartupDirectories } from "../../../../../src/infra/directory-authorities.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import { clearSharedModelListingClients, getSharedModelsClient } from "../../../../../src/orchestration/config/models/llm-clients.js";
import * as workflowDeps from "../../../../../src/orchestration/workflow-host/deps.js";

describe("skill maintenance request hosts", () => {
  const temporary = temporaryDirectories();
  const launcher: LauncherScope = {
    spawnOwned: () => Promise.reject(new Error("unexpected process")),
    adoptOwned: () => Promise.reject(new Error("unexpected process")),
    open: () => launcher,
    close: async () => ({ settled: true }),
  };
  function directories(count: number): StartupDirectories {
    const root = temporary("skill-request-host-");
    const accountHome = join(root, "home");
    const userDataRoot = join(accountHome, ".flywheel");
    const projectRoot = join(root, "project");
    mkdirSync(userDataRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(userDataRoot, "flywheel.toml"), 'features = ["skills", "learning"]\n');
    for (let index = 0; index < count; index += 1) {
      const dir = join(projectRoot, ".flywheel/skills", `candidate-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: candidate-${index}\ndescription: Use for candidate ${index}.\nmanaged: flywheel\n---\nA repeatable procedure.\n`);
    }
    return { accountHome, userDataRoot, projectRoot, executionCwd: projectRoot };
  }
  const hosts = [
    { name: "cleanup", run: (dirs: StartupDirectories) => withEventStore(dirs.projectRoot, (store) => runSkillCorpusCleanupForProject({ directories: dirs, launcher, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), force: true })) },
    { name: "maintain", run: (dirs: StartupDirectories) => runSkillMaintenanceForProject({ directories: dirs, launcher, surveyOnly: true }) },
  ];

  test.each(hosts)("$name prepares exact profile eligibility before workflow dependencies", async (host) => {
    const dirs = directories(2);
    clearSharedModelListingClients();
    const refresh = spyOn(getSharedModelsClient(dirs.userDataRoot), "refresh").mockResolvedValue(undefined);
    let prepared: workflowDeps.PrepareWorkflowDepsInput | undefined;
    const prepare = spyOn(workflowDeps, "prepareWorkflowDeps").mockImplementation(async (input) => {
      prepared = input;
      throw new Error("prepared request boundary");
    });
    try {
      const result = await host.run(dirs).catch((error: unknown) => ({ kind: "refused", reason: String(error) }));
      expect(prepared?.providerModelEligibility?.()).toBeDefined();
      expect(prepared?.activeProfileId?.()).toBe("default");
      expect(prepared?.authDirectory?.()).toBe(join(dirs.userDataRoot, "auth/profiles/default"));
      expect(result).toMatchObject({ reason: expect.stringContaining("prepared request boundary") });
    } finally {
      prepare.mockRestore();
      refresh.mockRestore();
      clearSharedModelListingClients();
    }
  });

  test.each([0, 1])("maintain skips %i candidates without provider preparation", async (count) => {
    const prepare = spyOn(workflowDeps, "prepareWorkflowDeps").mockRejectedValue(new Error("unexpected provider preparation"));
    try {
      expect(await runSkillMaintenanceForProject({ directories: directories(count), launcher })).toEqual({
        kind: "skipped", candidates: count, reason: "At least two eligible learned skills are required for a maintenance survey.",
      });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
  });
});
