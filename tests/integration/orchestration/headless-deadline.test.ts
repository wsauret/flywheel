import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadlessTask } from "../../../src/orchestration/headless/run-headless-task.js";
import { peekSharedProviderAvailability } from "../../../src/orchestration/agent-runtime/llm/shared-provider-availability.js";
import type { AgentFactory } from "../../../src/orchestration/agent-runtime/types.js";
import type { WorkflowDeps } from "../../../src/orchestration/workflow-host/deps.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";
import { testDirectories } from "../../helpers/directories.js";
import { testCapabilityModules, testProviderEligibility, testProviderRegistry } from "../../helpers/provider-authority.js";
import { captureProviderConnection } from "../../../src/infra/auth/auth-context.js";
import { testRuntimeConfigCapture } from "../../helpers/request-tool-surface.js";
import { createHeadlessDeadline, HeadlessDeadlineExpired } from "../../../src/orchestration/headless/headless-deadline.js";
import { resolveHeadlessAuthProfile } from "../../../src/orchestration/headless/headless-profile-runtime.js";
import { authProviders } from "../../helpers/auth-context.js";
import { fakeModelInfos } from "../../helpers/model-tier-fixtures.js";

function workflowDeps(createAgent: AgentFactory): WorkflowDeps {
  const directories = testDirectories(process.cwd());
  const auth = {
    providers: authProviders({ apiKeys: { openai_api: "test-openai-key" } }),
    credentialLineages: {}, droppedCredentials: [],
  };
  const connection = captureProviderConnection({ profileId: "default", authDir: join(directories.userDataRoot, "auth"), auth });
  return {
    accountHome: directories.accountHome,
    userDataRoot: directories.userDataRoot,
    definitions: repoDefinitions(),
    createAgent,
    prepareRequest: () => { throw new Error("A headless run prepares no pre-start") },
    createLLMClient: async () => { throw new Error("unexpected LLM client creation"); },
    captureProviderConnection: async () => ({ connection, providers: testProviderRegistry(), runtimeConfig: testRuntimeConfigCapture(), eligibility: testProviderEligibility(), admit: () => { throw new Error("unexpected provider admission"); } }),
    runOwnedCommand: async () => { throw new Error("unexpected command"); },
    resolveEnvSnapshot: async (scope) => ({ envBlock: scope.executionCwd }),
    captureRuntimeConfig: testRuntimeConfigCapture,
    auth,
    availableModels: new Map([["openai", new Set(["gpt-5.5"])]]),
    modelInfos: fakeModelInfos,
    moduleSelection: testCapabilityModules,
    awaitModelAccessSettled: async () => {},
  };
}

const launcher = { spawnOwned: async () => { throw new Error("unused"); }, adoptOwned: async () => { throw new Error("unused"); }, open() { return this; }, close: async () => ({ settled: true as const }) };

describe("runHeadlessTask deadline", () => {
  test("closes profile access that arrives after setup expiry", async () => {
    const access = Promise.withResolvers<{ close(): void }>();
    let closeCount = 0;
    const resolution = {
      id: "default",
      persistedId: "default",
      displayName: "Default",
      source: "default" as const,
      directory: "/profiles/default",
      availableProfiles: [{ id: "default", displayName: "Default" }],
      projectBinding: undefined,
      retirements: {},
    };
    const operation = resolveHeadlessAuthProfile({
      acquireAccess: async () => await access.promise,
      resolve: async () => resolution,
    });
    const deadline = createHeadlessDeadline(0);

    let expired = false;
    try {
      await deadline.awaitSetup(operation);
    } catch (error) {
      expired = error instanceof HeadlessDeadlineExpired;
    }
    expect(expired).toBe(true);

    access.resolve({ close: () => { closeCount += 1; } });
    expect(await operation).toEqual(resolution);
    expect(closeCount).toBe(1);
    deadline.dispose();
  });

  test("publishes deadline evidence only after abort quiesces", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-deadline-"));
    const completedRunner: AgentFactory = () => ({
      send() {},
      end() {},
      abort() {},
      done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
    });
    await runHeadlessTask("warm direct task resources", {
      directories: testDirectories(projectRoot),
      launcher,
      printErrorsToStderr: false,
      prepareWorkflowDeps: async () => workflowDeps(completedRunner),
    });
    let aborted = false;
    let settled = false;
    const createAgent: AgentFactory = () => {
      let resolveDone: ((result: { servedRequests: 0, durationMs: number; terminal: { kind: "aborted" } }) => void) | undefined;
      const done = new Promise<{ servedRequests: 0, durationMs: number; terminal: { kind: "aborted" } }>((resolve) => { resolveDone = resolve; });
      return {
        send() {},
        end() {},
        abort() {
          aborted = true;
          setTimeout(() => {
            settled = true;
            resolveDone?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
          }, 5);
        },
        done,
      };
    };

    try {
      const result = await runHeadlessTask("do the work", {
        directories: testDirectories(projectRoot),
        launcher,
        printErrorsToStderr: false,
        // The deadline also counts setup, which can take over 2 s on a
        // saturated 4-core runner; it must fire after the runner starts.
        deadlineSeconds: 3,
        prepareWorkflowDeps: async () => workflowDeps(createAgent),
      });

      expect(aborted).toBe(true);
      expect(settled).toBe(true);
      expect(result.completed).toBe(false);
      expect(result.termination).toEqual({ version: 2, terminal: { kind: "aborted" }, deadlineFired: true });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("settles an expired preparation deadline and releases acquired availability", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-headless-preparation-deadline-"));
    let enteredPreparation: (() => void) | undefined;
    const preparationStarted = new Promise<void>((resolve) => { enteredPreparation = resolve; });

    try {
      const running = runHeadlessTask("do the work", {
        directories: testDirectories(projectRoot),
        launcher,
        printErrorsToStderr: false,
        deadlineSeconds: 0.03,
        prepareWorkflowDeps: async (): Promise<WorkflowDeps> => {
          enteredPreparation?.();
          return await new Promise<never>(() => {});
        },
      });
      await preparationStarted;
      expect(peekSharedProviderAvailability()).toBeDefined();
      const result = await running;

      // The run releases the authority it acquired. A run that kept it would
      // also keep the authority's database open in the account home, which
      // Windows then refuses to remove.
      expect(peekSharedProviderAvailability()).toBeUndefined();
      expect(result.error).toStartWith("Headless deadline expired after ");
      expect(result.termination).toEqual({ version: 2, deadlineFired: true });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

});
