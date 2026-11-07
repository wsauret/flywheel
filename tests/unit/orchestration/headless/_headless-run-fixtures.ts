import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { WorkflowDeps } from "../../../../src/orchestration/workflow-host/deps.js"
import type { AgentFactory } from "../../../../src/orchestration/agent-runtime/types.js"
import { captureProviderConnection } from "../../../../src/infra/auth/auth-context.js"
import { testDirectories } from "../../../helpers/directories.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testCapabilityModules, testProviderEligibility, testProviderRegistry } from "../../../helpers/provider-authority.js"
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js"
import { testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { authProviders } from "../../../helpers/auth-context.js"
import { planEveryCapability } from "../../../helpers/attempt-brief.js"

const directories = testDirectories(process.cwd())
const accountHome = directories.accountHome
export const userDataRoot = directories.userDataRoot

export function makeWorkflowDeps(createAgent: AgentFactory = () => { throw new Error("unexpected runner creation") }): WorkflowDeps {
  const auth = {
    providers: authProviders({ apiKeys: { openai_api: "test-openai-key" } }),
    credentialLineages: {}, droppedCredentials: [],
  }
  const connection = captureProviderConnection({ profileId: "default", authDir: join(userDataRoot, "auth"), auth })
  return {
    accountHome,
    userDataRoot,
    definitions: repoDefinitions(),
    createLLMClient: () => { throw new Error("unexpected LLM client creation") },
    prepareRequest: () => { throw new Error("This fixture prepares no pre-start") },
    planCapabilities: planEveryCapability,
    captureProviderConnection: async () => ({ connection, providers: testProviderRegistry(), eligibility: testProviderEligibility(), runtimeConfig: testRuntimeConfigCapture(), admit: () => { throw new Error("unexpected provider admission") } }),
    runOwnedCommand: async () => { throw new Error("unexpected command") },
    resolveEnvSnapshot: async (scope) => ({
      envBlock: `<env>\nWorking directory: ${scope.executionCwd}\n</env>`,
    }),
    captureRuntimeConfig: testRuntimeConfigCapture,
    createAgent,
    auth,
    availableModels: new Map([["openai", new Set(["gpt-5.5"])]]),
    modelInfos: fakeModelsClient.modelInfos,
    modelsClient: fakeModelsClient,
    moduleSelection: testCapabilityModules,
    awaitModelAccessSettled: async () => {},
  }
}

/** Shared holders remain live for this process until the owning run closes. */
export function generationHolders(projectRoot: string): string[] {
  const flywheel = join(projectRoot, ".flywheel")
  return existsSync(flywheel) ? readdirSync(flywheel).filter((entry) => entry.startsWith("project-generation.lock.shared")) : []
}

