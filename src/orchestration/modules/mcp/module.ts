import { MCP_COMMAND, MCP_COMMAND_NAME, MCP_SURFACE, mcpProtocol } from "../../../protocol/modules/mcp.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../modules.js"
import type { CliCommandContext } from "../../cli-contribution.js"
import { MCP_USAGE } from "./cli/args.js"
import { mcpConfigSection } from "./config.js"
import { createMcpProtocol } from "./protocol.js"
import { createMcpRuntime, mcpRuntime } from "./runtime.js"
import type { RuntimeConfigOwner } from "../../config/runtime-config-owner.js"
import type { CommandClaudeLogins } from "./cli/mcp.js"
import { CLAUDE_PROVIDER_MODULE_ID, claudeLoginEngines, createMcpService, mcpService } from "./service.js"

/** Each verb hands its argument vector back to the one parser, so the verb
 *  grammar lives in `cli/args.ts` and the noun table stays a listing. */
const runMcpVerb = (verb: string) => async (args: readonly string[], { directories, launcher, enabledModuleIds }: CliCommandContext) => {
  const { runMcp } = await import("./cli/mcp.js")
  await runMcp([verb, ...args], directories, { launcher: launcher.scope, claudeLogins: (config) => commandClaudeLogins(directories, launcher.scope, config, enabledModuleIds) })
}

/** The Claude logins of the resolved auth profile for one command, read through the Claude provider module's
 *  service, as a runtime reads them. The command builds that one service, and none while the module is off. */
async function commandClaudeLogins(directories: CliCommandContext["directories"], launcher: CliCommandContext["launcher"]["scope"], config: Pick<RuntimeConfigOwner, "snapshot" | "subscribe" | "mutateSection">, enabledModuleIds: readonly string[]): Promise<CommandClaudeLogins> {
  const [{ installedModules }, { composePortableModuleServices }] = await Promise.all([import("../../module-catalog.js"), import("../../app-service/module-service-host.js")])
  const provider = installedModules().filter((module) => module.id === CLAUDE_PROVIDER_MODULE_ID)
  const services = composePortableModuleServices(provider, () => enabledModuleIds, { directories, config, launcher, onSelectionChanged: () => () => {} })
  services.start()
  return { logins: await services.services.get(claudeLoginEngines)?.logins() ?? [], dispose: () => services.dispose() }
}

/** External tool servers over the Model Context Protocol: the `[mcp]` config
 *  section, the connections that follow it, the code-only tools the
 *  connected servers list, the status domain both clients fold, the `/mcp`
 *  surface with reauthentication, and the `flywheel mcp` verbs. */
export const mcpModule = {
  id: "mcp",
  dependencies: [],
  availability: { kind: "available" },
  service: { handle: mcpService, portable: true, create: createMcpService },
  runtime: { handle: mcpRuntime, create: createMcpRuntime },
  protocol: moduleProtocol({ contract: mcpProtocol, create: createMcpProtocol }),
  contributions: [
    { domain: "config", id: mcpConfigSection.key, value: mcpConfigSection },
    { domain: "codeTools", id: "mcp", value: {
      create: ({ modules }) => modules.get(mcpRuntime)?.nestedTools() ?? [],
      namespaces: ({ modules }) => modules.get(mcpRuntime)?.namespaces() ?? [],
    } },
    { domain: "commands", id: MCP_COMMAND, value: {
      id: MCP_COMMAND,
      title: MCP_COMMAND_NAME,
      description: "View MCP server status and reauthenticate",
      aliases: [],
      menu: { group: "top", rank: 90 },
      opens: MCP_SURFACE,
    } },
    { domain: "settings", id: "mcp", value: { control: "binary", group: "Tools", label: "MCP servers", description: "Connect external tool servers and offer their tools through code" } },
    { domain: "cli", id: "mcp", value: {
      usage: MCP_USAGE,
      verbs: {
        add: { syntax: "add <name> [--local] ...", description: "Add an MCP server: --url <url> for remote servers, or -- <executable> [args...] for local stdio servers.", run: runMcpVerb("add") },
        login: { syntax: "login <name> [--local]", description: "Authenticate a global or project-effective remote MCP server via OAuth.", run: runMcpVerb("login") },
        status: { syntax: "status [--local]", description: "Show global or project-effective MCP servers and their state.", run: runMcpVerb("status") },
        list: { syntax: "list [--local]", description: "List global or project-effective MCP servers.", run: runMcpVerb("list") },
        remove: { syntax: "remove <name> [--local]", description: "Confirm scoped removal and keep saved credentials.", run: runMcpVerb("remove") },
        import: { syntax: "import <path> [--local]", description: "Import servers into global or private project configuration.", run: runMcpVerb("import") },
      },
    } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
