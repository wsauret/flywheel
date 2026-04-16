import type { Engine, EngineMetadata, RunnerOptions } from "../../core/types.js";
import { createModelsClient, type ModelsClient } from "./llm/models.js";
import { createClient } from "./llm/client-factory.js";
import { HarnessRunner } from "./runner.js";
import type { LLMClient } from "./llm/types.js";

const metadata: EngineMetadata = {
  id: "harness",
  name: "Flywheel Harness",
  defaultModel: "claude-opus-4-6",
  description: "Direct LLM API engine (Anthropic + OpenAI)",
};

// Bare aliases → full Anthropic model IDs for direct API usage (no context-window suffixes).
const MODEL_ALIASES: Record<string, string> = {
  opus:   "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5-20251001",
};

function resolveModel(raw: string): string {
  return MODEL_ALIASES[raw.toLowerCase().trim()] ?? raw;
}

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
        (model) => clientFactory(resolveModel(model), modelsClient),
      );
    },
  };
}
