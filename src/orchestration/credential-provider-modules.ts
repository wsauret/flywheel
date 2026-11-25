import { customProviderModules } from "./agent-runtime/llm/custom-provider-modules.js"
import { publishCustomProviderModules, publishShippedCredentialProviders, type FirstPartyModule } from "./module-contract/module-catalog.js"
import { anthropicApiModule } from "./modules/provider-anthropic-api/module.js"
import { chatgptModule } from "./modules/provider-chatgpt/module.js"
import { claudeAgentSdkModule } from "./modules/provider-claude-agent-sdk/module.js"
import { deepseekModule } from "./modules/provider-deepseek/module.js"
import { githubCopilotModule } from "./modules/provider-github-copilot/module.js"
import { googleAntigravityModule } from "./modules/provider-google-antigravity/module.js"
import { googleApiModule } from "./modules/provider-google-api/module.js"
import { googleVertexModule } from "./modules/provider-google-vertex/module.js"
import { openaiApiModule } from "./modules/provider-openai-api/module.js"
import { opencodeGoModule } from "./modules/provider-opencode-go/module.js"
import { openrouterModule } from "./modules/provider-openrouter/module.js"
import { supergrokModule } from "./modules/provider-supergrok/module.js"
import { webExaModule } from "./modules/web-exa.js"

/** Every shipped module that claims a credential provider id: each access
 *  provider and each web auth provider. The module registry composes this
 *  tuple into the whole catalog. A process that only logs in can load this
 *  registry alone, so it loads the provider definitions and never a tool or
 *  another module. Loading it also publishes how `[custom_providers]`
 *  entries become modules. */
export const CREDENTIAL_PROVIDER_MODULES = [anthropicApiModule, chatgptModule, claudeAgentSdkModule, deepseekModule, githubCopilotModule, googleAntigravityModule, googleApiModule, googleVertexModule, openaiApiModule, opencodeGoModule, openrouterModule, supergrokModule, webExaModule] as const satisfies readonly FirstPartyModule[]
publishShippedCredentialProviders(CREDENTIAL_PROVIDER_MODULES)
publishCustomProviderModules(customProviderModules)
