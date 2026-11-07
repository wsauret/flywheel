import { moduleRuntimeHandle } from "../../infra/module-runtime.js";
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js";
import { createWebTool, WEB_TOOL_DEFINITION } from "../agent-runtime/tools/web.js";
import type { RuntimeToolSurfaces } from "../agent-runtime/types.js";
import { webSearchRemedy } from "../agent-runtime/web-search/select.js";
import type { FirstPartyModule } from "../modules.js";

/** The generation's web retrieval port factory. Availability is read per plan,
 *  so a credential that lands mid-session exposes the tool on the next request
 *  without a restart. */
const webRuntime = moduleRuntimeHandle<NonNullable<RuntimeToolSurfaces["webSearch"]>>("web");

const WEB_TOOL_CONTRIBUTION = {
  category: "opt-in",
  action: "web_search",
  cloneInheritance: "inherit",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: true,
  personaOrder: 7,
  registryOrder: 18,
  registrations: {
    web: {
      capabilities: [],
      create: ({ kernel, modules }) => {
        const port = modules.get(webRuntime)?.(kernel.moduleSnapshot, kernel.runtimeConfig.webSearchProvider);
        if (port?.available()) return { tool: createWebTool(port) };
        const backends = kernel.moduleSnapshot.contributions.flatMap((contribution) => contribution.domain === "webBackends" ? [contribution.value.id] : []);
        return { unusable: { tool: WEB_TOOL_DEFINITION, reason: `no web search provider available (${webSearchRemedy(backends)})` } };
      },
    },
  },
} as const satisfies ToolDeclaration<never>;

export const webModule = {
  id: "web",
  dependencies: [],
  availability: { kind: "available" },
  runtime: { handle: webRuntime, create: (services) => services.webSearch },
  contributions: [
    { domain: "tools", id: "web", value: { kind: "tool", name: "web", declaration: WEB_TOOL_CONTRIBUTION, associatedPromptRosterIds: ["web"] } },
    { domain: "promptRosters", id: "web", value: { definition: "web", visibility: "model-invocable" } },
    { domain: "settings", id: "web", value: { control: "binary", label: "Web", description: "Allow agents to search and retrieve public web content" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule;
