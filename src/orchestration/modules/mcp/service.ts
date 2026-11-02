import { moduleServiceHandle } from "../../../infra/module-service.js"
import { Log } from "../../../infra/log.js"
import { accountAuthDir } from "../../../infra/paths.js"
import { createOrderedLane } from "../../../infra/ordered-lane.js"
import type { McpStatusRow } from "../../../protocol/modules/mcp.js"
import type { ModuleServiceInstance, PortableModuleServices } from "../../app-service/module-service-host.js"
import { configSection } from "../../config/config-section.js"
import type { ConfigMutationResult, RuntimeConfigSnapshot } from "../../config/runtime-config-owner.js"
import { createMcpAuthenticationService, type McpAuthenticationService } from "./authentication.js"
import { mcpConfigSection, resolveMcpConfig } from "./config.js"
import { mcpExpectedToken, removeMcpServer, setMcpEnabled, type McpSelectedMutation } from "./config-mutation.js"
import { createMcpManager, type McpManager, type McpManagerOptions, type McpPorts } from "./manager.js"

const log = Log.create({ service: "mcp" })

/** The module's one process-scoped service: the connection manager over the
 *  configured servers, the ports a runner's code projection reaches through
 *  the module's handle, and the interactive reauthentication the protocol
 *  mutation drives. The manager follows the `[mcp]` section and the live
 *  selection: a section edit replaces the connections, and turning the module
 *  off disconnects every server until it is turned on again (ARCH-STRUCTURE-026). The
 *  service is portable, so a headless run, the agents of its workflows, and its
 *  subagents reach the same servers as an interactive session. */
export interface McpService extends ModuleServiceInstance {
  readonly manager: McpManager
  readonly ports: McpPorts
  readonly authentication: McpAuthenticationService
  status(): readonly McpStatusRow[]
  /** Settles every first connection attempt, each bounded by the startup
   *  deadline, and names each server that needs a sign-in or failed with the
   *  `flywheel mcp` verb that repairs it. It never starts a sign-in. */
  settleStartup(): Promise<readonly string[]>
  subscribe(listener: () => void): () => void
  setEnabled(request: Omit<McpSelectedMutation, "projectRoot"> & { readonly enabled: boolean }): Promise<ConfigMutationResult>
  remove(request: Omit<McpSelectedMutation, "projectRoot">): Promise<ConfigMutationResult>
}

export const mcpService = moduleServiceHandle<McpService>("mcp")

export function createMcpService(services: PortableModuleServices, options: Pick<McpManagerOptions, "connect"> = {}): McpService {
  const projectRoot = services.directories.projectRoot
  // Scope and expectations describe settled resources, not the latest desired publication.
  let applied = configSection(services.config.snapshot().config, mcpConfigSection)
  let replacing = false
  const applications = createOrderedLane()
  const listeners = new Set<() => void>()
  const manager = createMcpManager({
    servers: services.enabled() ? resolveMcpConfig(applied, projectRoot).servers : {},
    executionCwd: services.directories.executionCwd,
    authDir: accountAuthDir(services.directories.userDataRoot),
    log: (message, fields) => log.info(message, fields),
    spawnOwned: services.launcher.spawnOwned,
    ...options,
  })
  const observe = (): readonly McpStatusRow[] => {
    const { metadata } = resolveMcpConfig(applied, projectRoot)
    // SAFETY: Applied source describes the manager's settled registry, including retained rows after refusal.
    return Object.freeze(manager.status().map((row) => Object.freeze({
      ...row,
      ...metadata[row.name]!,
      expected: mcpExpectedToken(applied, projectRoot, row.name),
    })))
  }
  let status = observe()
  const publish = (): void => {
    status = observe()
    for (const listener of listeners) listener()
  }
  const stopManager = manager.subscribe(() => { if (!replacing) publish() })
  const follow = (snapshot: RuntimeConfigSnapshot, enabled: boolean): Promise<void> => applications.run(async () => {
    const source = configSection(snapshot.config, mcpConfigSection)
    replacing = true
    try {
      await manager.replaceServers(enabled ? resolveMcpConfig(source, projectRoot).servers : {})
      applied = source
    } finally {
      replacing = false
      publish()
    }
  })
  const unsubscribe = [
    services.config.subscribe(mcpConfigSection, (snapshot) => follow(snapshot, services.enabled())),
    services.onSelectionChanged(() => follow(services.config.snapshot(), services.enabled())),
  ]
  return {
    manager,
    ports: { servers: manager.servers, tools: manager.tools, call: manager.call },
    authentication: createMcpAuthenticationService({ manager, launcher: services.launcher }),
    status: () => status,
    async settleStartup() {
      await Promise.allSettled(manager.entries().flatMap(({ name, state }) => state.tag === "pending" ? [manager.acquire(name)] : []))
      return status.flatMap((row) => {
        const local = row.definitionScope === "project" ? " --local" : ""
        if (row.status === "needs_auth") return [`MCP server '${row.name}' needs authentication. Run \`flywheel mcp login ${row.name}${local}\` to sign in.`]
        if (row.status === "failed") return [`MCP server '${row.name}' failed to connect. Run \`flywheel mcp status${local}\` to inspect it.`]
        return []
      })
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setEnabled: (request) => setMcpEnabled(services.config, { ...request, projectRoot }),
    remove: (request) => removeMcpServer(services.config, { ...request, projectRoot }),
    async dispose() {
      await Promise.all(unsubscribe.map((stop) => stop()))
      await applications.settled()
      stopManager()
      listeners.clear()
      await manager.dispose()
    },
  }
}
