import { moduleRuntimeHandle } from "../../infra/module-runtime.js"
import { definitionOverridesProtocol } from "../../protocol/modules/definition-overrides.js"
import type { DefinitionOverrideOperations } from "../../workflows/definitions/override-staleness.js"
import { createDefinitionOverridesTool, DEFINITION_OVERRIDES_TOOL_DEFINITION, type DefinitionOverridesToolDeps } from "../agent-runtime/tools/definition-overrides.js"
import { MESSAGE_SESSION_TOOL_NAME } from "../agent-runtime/tools/message-session.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import { moduleProtocol } from "../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../modules.js"
import { createDefinitionOverridesProtocol } from "./definition-overrides/protocol.js"

/** The runtime-owned definition resolution and mutation surface, when the
 *  project's definition registry publishes one. */
const definitionOverridesRuntime = moduleRuntimeHandle<DefinitionOverrideOperations>("definition-overrides")

const definitionOverrides = {
  category: "opt-in",
  action: "ui_meta",
  cloneInheritance: "inherit",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 7,
  registrations: {
    definition_overrides: {
      capabilities: [],
      create: ({ kernel, modules }) => {
        const service = modules.get(definitionOverridesRuntime)
        if (!service?.available()) return { unusable: { tool: DEFINITION_OVERRIDES_TOOL_DEFINITION, reason: "no definition override projection available" } }
        const packages = kernel.moduleSnapshot.contributions.flatMap((contribution) => contribution.domain === "managedPackageWrites" ? [contribution.value.create(modules)] : []).find((provider) => provider !== undefined)
        const deps: DefinitionOverridesToolDeps = {
          service,
          ...(packages ? { packages } : {}),
        }
        return {
          tool: createDefinitionOverridesTool(deps),
          // The planned set decides only what a resolving call returns; the
          // advertised definition is the same for every agent.
          refine: (planned) => ({ tool: createDefinitionOverridesTool({ ...deps, askUserAvailable: planned.has("ask_user"), parentChannel: planned.has(MESSAGE_SESSION_TOOL_NAME) }) }),
        }
      },
    },
  },
} as const satisfies ToolDeclaration

export const definitionOverridesModule = {
  id: "definition-overrides",
  dependencies: [],
  availability: { kind: "available" },
  runtime: { handle: definitionOverridesRuntime, create: (services) => services.definitions.definitionOverrides },
  protocol: moduleProtocol({ contract: definitionOverridesProtocol, create: createDefinitionOverridesProtocol }),
  contributions: [
    { domain: "questionDecisions", id: "definition-overrides", value: {
      tool: "definition_overrides",
      create: ({ modules }) => {
        const service = modules.get(definitionOverridesRuntime)
        return service ? { definitionOverrideProposal: (preparationId: string) => service.proposal(preparationId) } : {}
      },
    } },
    { domain: "tools", id: "definition_overrides", value: { kind: "tool", name: "definition_overrides", declaration: definitionOverrides } },
    { domain: "settings", id: "definition-overrides", value: { control: "binary", group: "Tools", label: "Definition overrides", description: "Let agents review upstream updates to overridden definitions" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
