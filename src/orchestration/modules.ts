// The module registry: every shipped module that claims no credential
// provider id. Loading it publishes the shipped catalog and the module-id
// vocabulary of selection decoding into the catalog (module-catalog.ts), which
// the kernel reads. Only a process entry loads it (src/cli/composition/module-registries.ts),
// so no kernel file depends on a module home.
import { publishModuleSelectionVocabulary, publishShippedOtherModules, type FirstPartyModule, type ModuleId } from "./module-catalog.js"
import { askUserModule } from "./modules/ask-user.js"
import { backgroundCommandsModule } from "./modules/background-commands.js"
import { bashModule } from "./modules/bash/module.js"
import { bugReportsModule } from "./modules/bug-reports/module.js"
import { codeModeModule } from "./modules/code-mode/module.js"
import { definitionOverridesModule } from "./modules/definition-overrides.js"
import { discoveryModule } from "./modules/discovery.js"
import { experimentsModule } from "./modules/experiments.js"
import { fileToolsModule } from "./modules/file-tools.js"
import { learningModule } from "./modules/learning.js"
import { mcpModule } from "./modules/mcp/module.js"
import { papercutsModule } from "./modules/papercuts.js"
import { projectNotificationsModule } from "./modules/project-notifications/module.js"
import { recallModule } from "./modules/recall.js"
import { reclaimStorageModule } from "./modules/reclaim-storage/module.js"
import { remoteModule } from "./modules/remote/module.js"
import { sideQuestionModule } from "./modules/side-question/module.js"
import { skillsModule } from "./modules/skills.js"
import { subagentsModule } from "./modules/subagents.js"
import { subscriptionUsageModule } from "./modules/subscription-usage/module.js"
import { webChatgptModule } from "./modules/web-chatgpt.js"
import { webModule } from "./modules/web.js"
import { workflowsModule } from "./modules/workflows.js"

/** Every shipped module that claims no credential provider id. The credential
 *  provider registry lists the others, so auth reads them without loading
 *  these. A source run adds the development catalog to this half through
 *  `installModuleCatalog`; nothing here names that catalog by value, so a
 *  release bundle never contains it. */
export const SHIPPED_OTHER_MODULES = [askUserModule, backgroundCommandsModule, bashModule, bugReportsModule, codeModeModule, definitionOverridesModule, discoveryModule, experimentsModule, fileToolsModule, learningModule, mcpModule, papercutsModule, projectNotificationsModule, recallModule, reclaimStorageModule, remoteModule, sideQuestionModule, skillsModule, subagentsModule, subscriptionUsageModule, webModule, webChatgptModule, workflowsModule] as const satisfies readonly FirstPartyModule[]
publishShippedOtherModules(SHIPPED_OTHER_MODULES)

// Retired module-id spellings mapped to their canonical ids; a selection
// stored under an old spelling keeps selecting the same capability.
// `benchmark` became one contribution of the development module.
export const RETIRED_MODULE_ID_SPELLINGS: ReadonlyMap<string, ModuleId> = new Map([["background_commands", "background-commands"], ["benchmark", "development"]])

publishModuleSelectionVocabulary({
  workflowsModuleId: workflowsModule.id,
  retiredSpellings: RETIRED_MODULE_ID_SPELLINGS,
  // The features vocabulary predates the kebab module ids.
  legacyFeatureTokens: new Map([["workflows", "workflows"], ["skills", "skills"], ["subagents", "subagents"], ["learning", "learning"], ["background-commands", "background_commands"]]),
  retiredExpansions: new Map([
    ["core-tools", ["bash", "discovery", "file-tools"]],
    ["runtime-tools", ["ask-user", "recall"]],
  ]),
  // IDs shipped after the retired `modules` snapshot format. A retired snapshot
  // cannot state a decision about them, so migration and reads treat them as enabled.
  enabledSinceModulesSnapshot: [
    "definition-overrides", "experiments", "mcp", "papercuts", "project-notifications", "side-question", "reclaim-storage",
    "provider-anthropic-api", "provider-chatgpt", "provider-claude-agent-sdk", "provider-deepseek", "provider-github-copilot", "provider-google-antigravity", "provider-google-api",
    "provider-google-vertex", "provider-openai-api", "provider-opencode-go", "provider-openrouter", "provider-supergrok",
  ],
  // Each is now on by default (`provider-claude-agent-sdk`) or replaced by one
  // that is (`provider-claude-subscription`). Remove after 2027-04-08.
  retiredOptInModuleIds: new Set(["provider-claude-agent-sdk", "provider-claude-subscription"]),
})
