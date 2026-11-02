import type { PreparedPackage } from "../../../../../src/orchestration/agent-runtime/review-types.js";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeSkillCorpusCleanupResponse } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup-classifier.js";
import { runSkillCorpusCleanupForProject, runSkillCorpusCleanupWorkHost } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup-host.js";
import { runSkillMaintenanceForProject } from "../../../../../src/orchestration/modules/learning/skill-maintenance-host.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { withEventStore } from "../../../../../src/infra/with-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import type { StartupDirectories } from "../../../../../src/infra/directory-authorities.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import { getSharedModelsClient, resetSharedLlmClients } from "../../../../../src/orchestration/config/llm-clients.js";
import * as workflowDeps from "../../../../../src/orchestration/workflow-host/deps.js";


function work(id: string) {
  const identity = { sha256: id.padEnd(64, "0"), bytes: id.length };
  const pkg: PreparedPackage = { identity, files: [] };
  return {
    requestIdentity: identity,
    coreIdentity: { version: 1 as const, ...identity },
    corePackageId: `core-${id}`,
    corePackageIdentity: identity,
    candidateShardIdentity: identity,
    corePackage: { id: `core-${id}`, files: [] },
    candidates: [{ id: `candidate-${id}`, identity, package: pkg }],
  };
}

describe("runSkillCorpusCleanupWorkHost", () => {
  test("does not acquire provider resources when it receives no work", async () => {
    let acquisitions = 0;
    const result = await runSkillCorpusCleanupWorkHost({
      work: [],
      acquireClassifier: async () => { acquisitions += 1; throw new Error("unexpected acquisition"); },
    });
    expect(result).toEqual([]);
    expect(acquisitions).toBe(0);
  });

  test("captures one host runtime and disposes it once for several requests", async () => {
    let acquisitions = 0;
    let disposals = 0;
    const result = await runSkillCorpusCleanupWorkHost({
      work: [work("a"), work("b"), work("c")],
      concurrency: 2,
      acquireClassifier: async () => {
        acquisitions += 1;
        return {
          classify: async (request) => request.corePackageId,
          dispose: async () => { disposals += 1; },
        };
      },
    });
    expect(result).toEqual(["core-a", "core-b", "core-c"]);
    expect(acquisitions).toBe(1);
    expect(disposals).toBe(1);
  });

  test("limits concurrent child requests", async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = runSkillCorpusCleanupWorkHost({
      work: [work("a"), work("b"), work("c"), work("d")],
      concurrency: 2,
      acquireClassifier: async () => ({
        classify: async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await gate;
          active -= 1;
          return "done";
        },
        dispose: async () => {},
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(maximum).toBe(2);
    release();
    expect(await running).toEqual(["done", "done", "done", "done"]);
  });

  test("does not dequeue new work after a sibling rejects and waits for active settlement before disposal", async () => {
    let releaseSibling!: () => void;
    const sibling = new Promise<void>((resolve) => { releaseSibling = resolve; });
    const started: string[] = [];
    let disposed = false;
    const running = runSkillCorpusCleanupWorkHost({
      work: [work("a"), work("b"), work("c"), work("d")],
      concurrency: 2,
      acquireClassifier: async () => ({
        classify: async (request) => {
          started.push(request.corePackageId);
          if (request.corePackageId === "core-a") throw new Error("rejected");
          await sibling;
          return "done";
        },
        dispose: async () => { disposed = true; },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["core-a", "core-b"]);
    expect(disposed).toBe(false);
    releaseSibling();
    await expect(running).rejects.toThrow("rejected");
    expect(started).toEqual(["core-a", "core-b"]);
    expect(disposed).toBe(true);
  });

  test.each([undefined, "not-json"])("does not start queued work after strict decoding rejects %p", async (output) => {
    const started: string[] = [];
    const running = runSkillCorpusCleanupWorkHost({
      work: [work("a"), work("b"), work("c")],
      concurrency: 1,
      acquireClassifier: async () => ({
        classify: async (request) => {
          started.push(request.corePackageId);
          if (!decodeSkillCorpusCleanupResponse(request, output)) throw new Error("invalid cleanup output");
          return output;
        },
        dispose: async () => {},
      }),
    });

    await expect(running).rejects.toThrow("invalid cleanup output");
    expect(started).toEqual(["core-a"]);
  });
});

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
    resetSharedLlmClients();
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
      resetSharedLlmClients();
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
