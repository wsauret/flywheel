import type { Engine, EngineMetadata, RunnerOptions } from "../../core/types.js";
import type { AuthContext } from "../../../../infra/auth/auth-context.js";
import { createModelsClient, type ModelsClient } from "./llm/models.js";
import { createClient } from "./llm/client-factory.js";
import { HarnessRunner } from "./runner.js";
import type { LLMClient } from "./llm/types.js";

const metadata: EngineMetadata = {
  id: "harness",
  name: "Flywheel Harness",
  defaultModel: "claude-opus-4-7",
  description: "Direct LLM API engine with model-family-aware routing",
  parity: {
    resumeMode: "local_transcript",
    handoffMode: "dedicated_handoff_tool",
    progressMode: "stateful_progress_tool",
    toolExecutionMode: "shell_emulated",
    taskScopeMode: "progress_tool",
    supportsExternalToolResults: false,
  },
};

export function createHarnessEngine(deps?: {
  modelsClient?: ModelsClient;
  createLLMClient?: (model: string, modelsClient: ModelsClient, auth: AuthContext) => LLMClient;
}): Engine {
  const modelsClient = deps?.modelsClient ?? createModelsClient();
  const clientFactory = deps?.createLLMClient ?? createClient;

  return {
    metadata,
    createRunner(options: RunnerOptions) {
      const auth = options.auth;
      if (!auth) {
        throw new Error("Harness engine requires RunnerOptions.auth to be set");
      }
      return new HarnessRunner(
        options,
        (model) => clientFactory(model, modelsClient, auth),
      );
    },
  };
}
