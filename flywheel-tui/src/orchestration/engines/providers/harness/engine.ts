import type { Engine, EngineMetadata, RunnerOptions } from "../../core/types.js";
import { createModelsClient, type ModelsClient } from "./llm/models.js";
import { createClient } from "./llm/client-factory.js";
import { HarnessRunner } from "./runner.js";
import type { LLMClient } from "./llm/types.js";

const metadata: EngineMetadata = {
  id: "harness",
  name: "Flywheel Harness",
  defaultModel: "claude-opus-4-7",
  description: "Direct LLM API engine (Anthropic + OpenAI)",
};

export function createHarnessEngine(deps?: {
  modelsClient?: ModelsClient;
  createLLMClient?: (model: string, modelsClient: ModelsClient) => LLMClient;
}): Engine {
  const modelsClient = deps?.modelsClient ?? createModelsClient();
  const clientFactory = deps?.createLLMClient ?? createClient;

  return {
    metadata,
    createRunner(options: RunnerOptions) {
      return new HarnessRunner(
        options,
        (model) => clientFactory(model, modelsClient),
      );
    },
  };
}
