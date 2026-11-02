import type { CaptureModelRuntime, CaptureProviderConnection, LLMClientFactory } from "../../src/orchestration/agent-runtime/factory.js";
import { LiveAgent } from "../../src/orchestration/agent-runtime/runner.js";
import type { AgentOptions } from "../../src/orchestration/agent-runtime/types.js";
import type { ModelClient } from "../../src/orchestration/agent-runtime/llm/types.js"
import type { ProviderRuntimeCache } from "../../src/orchestration/agent-runtime/provider-runtime-cache.js";
import { repoDefinitions } from "./project-definitions.js";
import { createBreadcrumbMaintenance } from "../../src/orchestration/session/session-artifacts.js";
import { testCapabilityModules } from "./request-tool-surface.js";
import { testRuntimeConfigCapture } from "./request-tool-surface.js";

/** A runner bound to the repository's definition owner, the registry a run in
 *  this project composes its steps, workflows, and packages from. Tests that
 *  need another project's definitions construct LiveAgent directly. A provider
 *  capture resolves request settings through real eligibility before the fake adapter serves them. */
export function newTestRunner(
  options: AgentOptions,
  createLLMClient: LLMClientFactory,
  providerRuntimeCache?: ProviderRuntimeCache<ModelClient>,
  captureProviderConnection?: CaptureProviderConnection,
): LiveAgent {
  const captureModelRuntime: CaptureModelRuntime | undefined = captureProviderConnection === undefined ? undefined : async () => ({
    generation: createLLMClient,
    createLLMClient,
    captureProviderConnection: async (...args) => {
      const capture = await captureProviderConnection(...args);
      return { ...capture, admit: (plans) => ({ ...capture.admit(plans), createLLMClient }) };
    },
  });
  return new LiveAgent({ captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {}, ...options, runtimeSurfaces: options.runtimeSurfaces ?? {}, moduleSelection: options.moduleSelection ?? testCapabilityModules }, createLLMClient, repoDefinitions(), createBreadcrumbMaintenance(options.projectRoot), providerRuntimeCache, captureModelRuntime);
}
