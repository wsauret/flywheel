// Register the OpenTUI Solid JSX transform before any test module loads a
// first-party .tsx file. A .tsx module cached without this transform breaks
// every later Solid render in the same process (context providers no-op),
// and which tests share a process depends on the shard count. Test files do
// not import `@opentui/solid/preload` themselves: that would register a
// second, uncached transform.
import "./helpers/solid-transform-preload.js"

import { afterAll, afterEach } from "bun:test"
import { createRequire } from "node:module"
import { AGENT_SESSION_ENV } from "../src/infra/cli-subprocess.js"
import { Log } from "../src/infra/log.js"
import { installModuleCatalog } from "../src/orchestration/module-catalog.js"
import { removeTestAccountHome, testAccountHome } from "./helpers/directories.js"
import { assertNoNetworkRequests, installNetworkGuard } from "./helpers/network-guard.js"

Log.suppress()
installNetworkGuard()
// A suite an agent's command runs is still a person's run of the product:
// the agent marker would make every client under test decline to ask its
// service to make way.
delete process.env[AGENT_SESSION_ENV]
// The caller's account selection must not override isolated test profiles.
// Profile-selection tests supply their own environment.
delete process.env.FLYWHEEL_AUTH_PROFILE
// A source test must not load native assets from the invoking Flywheel build.
// Each Bun test process runs this preload, including child test processes.
delete process.env.FLYWHEEL_NATIVE_DIR
afterEach(assertNoNetworkRequests)

// Tests initialize their realm on its first catalog read. Kernel-only bands
// never load the registry; standalone fact readers retain strict decoding.
// The Agent SDK provider runs the Claude CLI with this process's HOME, where
// the CLI finds its keychain, and a test process shares that HOME with the
// developer. The catalog's copy runs on the test account home instead, so no
// test reaches the developer's own keychain.
const load = createRequire(import.meta.url)
installModuleCatalog({
  credentialProviders: () => {
    const registry: typeof import("../src/orchestration/credential-provider-modules.js") = load("../src/orchestration/credential-provider-modules.js")
    const agentSdk: typeof import("../src/orchestration/modules/provider-claude-agent-sdk/module.js") = load("../src/orchestration/modules/provider-claude-agent-sdk/module.js")
    const testAgentSdk = agentSdk.createClaudeAgentSdkModule({ account: () => ({ home: testAccountHome(), user: "flywheel-test" }) })
    return registry.CREDENTIAL_PROVIDER_MODULES.map((module) => module.id === testAgentSdk.id ? testAgentSdk : module)
  },
  otherModules: () => {
    const registry: typeof import("../src/orchestration/modules.js") = load("../src/orchestration/modules.js")
    return registry.SHIPPED_OTHER_MODULES
  },
})

// A hook registered here runs once, after the last test file of the process.
afterAll(removeTestAccountHome)
// A request can start after the last test ends. This hook comes last because
// a failing hook stops the hooks after it, and the cleanup above must run.
afterAll(assertNoNetworkRequests)
