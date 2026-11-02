import { NO_MODULE_SERVICES } from "../../src/infra/module-service.js"
import { createChildSlotRegistry } from "../../src/orchestration/agent-runtime/child-slot-registry.js"
import { createProviderRequestAuditWriter } from "../../src/orchestration/agent-runtime/llm/provider-request-audit.js"
import type { ModuleRuntimeServices } from "../../src/orchestration/agent-runtime/module-runtime-services.js"
import { composeFirstPartyModules } from "../../src/orchestration/modules.js"
import { fixedDefinitions } from "./project-definitions.js"
import { testRuntimeConfigCapture } from "./request-tool-surface.js"

const refuse = (authority: string) => (): never => {
  throw new Error(`this test provides no ${authority}`)
}

/** The per-runner kernel bag a module runtime factory reads, for an
 *  interactive chat runner at `/scratch/project`. Runner, client, and
 *  provider construction refuse when called, events go nowhere, the
 *  definitions are empty, and no module service is built. A test names
 *  only the authorities its runtime reads in `provided`. */
export function moduleRuntimeServices(provided: Partial<ModuleRuntimeServices> = {}): ModuleRuntimeServices {
  return {
    purpose: { kind: "interactive-chat" },
    userDataRoot: "/scratch/account/.flywheel",
    accountHome: "/scratch/account",
    projectRoot: "/scratch/project",
    executionCwd: "/scratch/project",
    conversation: { providerSessionKey: "test-conversation", artifactScopeId: "test-conversation" },
    promptKind: "chat",
    model: "test-model",
    servingModel: { model: "test-model", modelFamily: "anthropic" },
    personas: new Map(),
    childSlots: createChildSlotRegistry(),
    definitions: fixedDefinitions(),
    createRunner: refuse("runner factory"),
    createLLMClient: refuse("model client factory"),
    captureRuntimeConfig: testRuntimeConfigCapture,
    awaitModelAccessSettled: async () => {},
    budgetStreamId: "test-budget",
    auxiliaryRequestAudit: createProviderRequestAuditWriter({ identity: { providerSessionKey: "test-conversation" }, promptKind: "chat" }),
    onEvent: () => {},
    loadedSkillIds: new Set(),
    moduleSelection: composeFirstPartyModules,
    modules: NO_MODULE_SERVICES,
    inheritableRuntimeSurfaces: {},
    ...provided,
  }
}
