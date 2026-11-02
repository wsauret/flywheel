import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureProviderConnection } from "../../../../src/infra/auth/auth-context.js";
import type { AgentFactory } from "../../../../src/orchestration/agent-runtime/types.js";
import { runHeadlessTask } from "../../../../src/orchestration/headless/run-headless-task.js";
import type { WorkflowDeps } from "../../../../src/orchestration/workflow-host/deps.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { testDirectories } from "../../../helpers/directories.js";
import { repoDefinitions } from "../../../helpers/project-definitions.js";
import { testCapabilityModules } from "../../../helpers/provider-authority.js";
import { testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js";
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js";
import type { ModelFamily } from "../../../../src/infra/llm/model-family.js";
import { roleCapture } from "../../../helpers/role-capture.js";
import type { RoleSettingEntry } from "../../../../src/orchestration/session/schemas.js";

const launcher = { spawnOwned: async () => { throw new Error("unused"); }, adoptOwned: async () => { throw new Error("unused"); }, open() { return this; }, close: async () => ({ settled: true as const }) };

test.each([
  { model: "lost-model", effort: "high", expectedEffort: "medium" },
  { effort: "low", expectedEffort: "low" },
])("headless run settings resolve against captured availability: %j", async ({ expectedEffort, ...setting }) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-role-authority-"));
  const directories = testDirectories(projectRoot);
  const auth = {
    providers: authProviders({ apiKeys: { openai_api: "test-openai-key" } }),
    credentialLineages: {},
    droppedCredentials: [],
  };
  const connection = captureProviderConnection({ profileId: "default", authDir: join(directories.userDataRoot, "auth"), auth });
  let authorityProof: Promise<void> | undefined;
  let savedSetting: RoleSettingEntry | undefined;
  const createAgent: AgentFactory = (options) => {
    authorityProof = options.resolveRoles!().then(async (roles) => {
      expect(roles.get("reviewer")?.model).toBe("gpt-6.1-sol");
      savedSetting = roles.get("chat")?.setting;
      expect(await options.requestSelection?.(roles)).toMatchObject({ model: "gpt-6.1-sol", effort: expectedEffort });
      expect(options.model).toBe("gpt-6.1-sol");
    });
    return {
      send() {},
      end() {},
      abort() {},
      done: authorityProof.then(() => ({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" as const } })),
    };
  };
  const workflowDeps: WorkflowDeps = {
    accountHome: directories.accountHome,
    userDataRoot: directories.userDataRoot,
    definitions: repoDefinitions(),
    createLLMClient: () => { throw new Error("unused"); },
    prepareRequest: () => { throw new Error("This fixture prepares no pre-start") },
    captureProviderConnection: async () => ({ ...roleCapture(["gpt-6.1-sol"]), connection }),
    runOwnedCommand: async () => { throw new Error("unused"); },
    resolveEnvSnapshot: async (scope) => ({
      envBlock: `<env>\nWorking directory: ${scope.executionCwd}\n</env>`,
    }),
    captureRuntimeConfig: testRuntimeConfigCapture,
    createAgent,
    auth,
    modelsClient: fakeModelsClient,
    modelInfos: fakeModelsClient.modelInfos,
    availableModels: new Map<ModelFamily, ReadonlySet<string>>([["openai", new Set(["gpt-6.1-sol"])]]),
    moduleSelection: testCapabilityModules,
    awaitModelAccessSettled: async () => {},
  };

  try {
    const result = await runHeadlessTask("do the work", {
      modelsClient: fakeModelsClient,
      directories,
      launcher,
      printErrorsToStderr: false,
      prepareWorkflowDeps: async () => workflowDeps,
      ...setting,
    });

    expect(result).toMatchObject({ completed: true });
    await authorityProof;
    expect(savedSetting).toEqual(setting);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

