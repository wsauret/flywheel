import { resolve } from "node:path";
import type { AuthContext } from "../../../src/infra/auth/auth-context.js";
import { composeFirstPartyModules, moduleSelectionFromConfig, normalizeModuleSelection } from "../../../src/orchestration/modules.js";
import { MODULE_IDS } from "../../../src/protocol/module-ids.js";
import { ToolActionSchema } from "../../../src/infra/workflow-types.js";
import { toolRegistryFromComposition, type ToolRegistration } from "../../../src/orchestration/agent-runtime/tools/tool-registry.js";
import type { AdvertisedTool } from "../../../src/orchestration/agent-runtime/tools/types.js";
import { buildSystemPromptParts } from "../../../src/orchestration/agent-runtime/system-prompt.js";
import { buildCommandCatalog } from "../../helpers/command-catalog.js";
import { createWebSearch } from "../../../src/orchestration/agent-runtime/web-search/select.js";
import type { WebSearchProvider, WebSearchProviderId } from "../../../src/orchestration/agent-runtime/web-search/types.js";
import { learningModule } from "../../../src/orchestration/modules/learning.js";
import { NO_MODULE_RUNTIMES } from "../../../src/infra/module-runtime.js";
import { testKernelToolDeps } from "../../helpers/request-tool-surface.js";

import { accessProviderRegistry } from "../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { authProviders } from "../../helpers/auth-context.js";
import { promptCapabilities, promptOptions } from "../../helpers/prompt-capabilities.js";
const fixturePath = resolve(import.meta.dir, "../../fixtures/modules/baseline.json");

function runtimeToolManifest(tool: AdvertisedTool) {
  return {
    name: tool.name,
    action: tool.action,
    description: tool.description,
    promptGuidelines: tool.promptGuidelines ?? [],
    promptExamples: tool.promptExamples ?? null,
    codeMode: tool.codeMode ?? null,
    codeModeOutput: tool.codeModeOutput?.kind ?? null,
    gateAdmission: tool.gateAdmission ?? null,
    execution: tool.execution ?? { mode: "foreground", traceKind: "tool" },
    deferUntilAssistantCommitted: tool.deferUntilAssistantCommitted ?? false,
    isConcurrencySafe: typeof tool.isConcurrencySafe === "boolean" ? tool.isConcurrencySafe : "dynamic",
    hasReservedPaths: tool.reservedPaths !== undefined,
    uncappedOutput: tool.uncappedOutput ?? false,
    validatesOwnInput: tool.validatesOwnInput ?? false,
    unboundedDuration: tool.unboundedDuration ?? false,
  };
}

/** What one registration yields for a bare kernel with no module runtime:
 *  the self-contained tool it carries, the definition a tree-hosted agent
 *  advertises and refuses while it waits for a host surface, or the reason
 *  it is omitted. */
function toolCreation(registration: ToolRegistration) {
  const result = registration.create({ kernel: testKernelToolDeps({ userDataRoot: "stable" }), modules: NO_MODULE_RUNTIMES });
  if (result.tool) return { kind: "tool", tool: runtimeToolManifest(result.tool) };
  if (result.unusable) return { kind: "unusable", reason: result.unusable.reason, tool: runtimeToolManifest(result.unusable.tool) };
  return { kind: "omitted", reason: result.reason ?? null };
}

function commandSurface(producersOn: boolean): object[] {
  const builtInCommands = producersOn
    ? [
      { id: "bg", title: "Background work", description: "Show the work this chat runs in the background", aliases: ["tasks"] },
      { id: "learn" as const, title: "Learn", description: "Run the learning review on this session now", aliases: ["reflect"] },
    ]
    : []
  return buildCommandCatalog(() => "stable-chord", builtInCommands).map((command) => ({
    id: command.id,
    title: command.title,
    description: command.description,
    aliases: command.aliases ?? [],
    keybinding: command.keybinding ?? null,
    hidden: command.hidden ?? false,
  }));
}

const allAuth: AuthContext = {
  providers: authProviders({ apiKeys: { anthropic_api: "stable", openai_api: "stable", openrouter: "stable", google_api: "stable", google_vertex: "stable", exa: "stable" }, oauth: ["github_copilot", "chatgpt", "supergrok"] }),
  credentialLineages: {}, droppedCredentials: [],
};

async function webRouting(): Promise<object> {
  const calls: WebSearchProviderId[] = [];
  const provider = (id: WebSearchProviderId, available: boolean): WebSearchProvider => ({
    id,
    available: () => available,
    run: async () => {
      calls.push(id);
      return { results: [] };
    },
  });
  const preferred = createWebSearch({ preference: "exa", providers: [provider("chatgpt", true), provider("exa", true)] });
  await preferred.run({ search_query: [{ q: "stable" }] }, { retrievalSessionId: "stable" });
  const fallback = createWebSearch({ preference: "exa", providers: [provider("chatgpt", true), provider("exa", false)] });
  await fallback.run({ search_query: [{ q: "stable" }] }, { retrievalSessionId: "stable" });
  return { providerIds: ["chatgpt", "exa"], preferred: calls[0], fallback: calls[1] };
}

function learningMemoryPrompt(snapshot: string): string {
  const prompt = learningModule.contributions.find((contribution) => contribution.domain === "promptFragments");
  if (!prompt || prompt.domain !== "promptFragments") throw new Error("Learning memory prompt contribution is missing");
  const rendered = prompt.value.render({ kernel: testKernelToolDeps({ userDataRoot: "stable" }), modules: NO_MODULE_RUNTIMES, tools: new Map(), memorySnapshot: snapshot, capabilities: promptCapabilities([]) });
  if (rendered === undefined) throw new Error("Learning memory prompt rendered nothing for a snapshot");
  return rendered;
}

export async function generateCapabilityModuleBaseline(): Promise<string> {
  const composition = composeFirstPartyModules();
  const providers = accessProviderRegistry(composition).selection;
  const providerIds = providers.definitions.map((definition) => definition.id);
  const toolRegistrations = toolRegistryFromComposition(composition);
  const tools = [...toolRegistrations].map(([name, registration]) => ({
    name,
    tool: registration.tool,
    policy: { action: registration.action, personaBaseline: registration.personaBaseline },
    category: registration.category,
    capabilities: registration.capabilities,
    cloneInheritance: registration.cloneInheritance,
    learningReviewExecutable: registration.learningReviewExecutable,
    semanticBundle: registration.semanticBundle,
    creation: toolCreation(registration),
  }));
  const promptTools = tools.slice(0, 2).map(({ name, policy }) => ({ name, action: policy.action, description: `${name} stable description` }));
  const manifest = {
    format: "capability-module-baseline-v3",
    tools: { actions: ToolActionSchema.literals, registrations: tools },
    commands: { available: commandSurface(true), unavailable: commandSurface(false) },
    capabilities: {
      backgroundProducers: composeFirstPartyModules().backgroundWorkProducerIds,
      dependencyRejection: moduleSelectionFromConfig({ modules: ["workflows"] }),
      normalizationRejections: [normalizeModuleSelection("invalid"), normalizeModuleSelection(["unknown"]), normalizeModuleSelection(["workflows"])],
      registeredModules: MODULE_IDS,
    },
    promptFragments: buildSystemPromptParts(promptOptions({
      promptKind: "chat",
      corePrompt: "stable core",
      engineeringDoctrine: "stable doctrine",
      promptNotes: { progress: "stable progress", modelNotes: "stable model notes" },
      tools: promptTools,
      chatHost: { communication: true },
      agentsMd: "stable agents",
      envBlock: "stable environment",
      moduleFragments: [learningMemoryPrompt("stable memory")],
    })),
    accessProviders: {
      ids: providerIds,
      definitions: providerIds.map((id) => ({ id, displayName: providers.displayName(id), shortName: providers.shortName(id), billing: providers.billing(id), catalogId: providers.catalogId(id) ?? null })),
      configuredOrder: providers.getConfigured(allAuth),
      familyOrder: {
        anthropic: providers.getConfiguredForFamily("anthropic", allAuth),
        openai: providers.getConfiguredForFamily("openai", allAuth),
        google: providers.getConfiguredForFamily("google", allAuth),
      },
    },
    webProviders: await webRouting(),
    workflowObservers: ["doom-loop", "budget-awareness", "context-pressure"],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (import.meta.main) {
  await Bun.write(fixturePath, await generateCapabilityModuleBaseline());
}
