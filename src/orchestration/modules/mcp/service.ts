import type { ClaudeLoginEngines } from "../../../infra/claude-engine.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { Log } from "../../../infra/log.js"
import { accountAuthDir } from "../../../infra/paths.js"
import { createOrderedLane } from "../../../infra/ordered-lane.js"
import type { McpStatusRow } from "../../../protocol/modules/mcp.js"
import type { ModuleServiceInstance, PortableModuleServices } from "../../app-service/module-service-host.js"
import { configSection } from "../../config/config-section.js"
import type { ConfigMutationResult, RuntimeConfigSnapshot } from "../../config/runtime-config-owner.js"
import { createMcpAuthenticationService, type McpAuthenticationService } from "./authentication.js"
import { processClaudeEngine } from "./claude-engine.js"
import { resolveMcpClient } from "./clients.js"
import { isMcpConnector, mcpConfigSection, resolveMcpConfig, withMcpConnectors, type McpConfig, type McpConnectorServer } from "./config.js"
import { mcpExpectedToken, removeMcpServer, setMcpClaudeAiConnectors, setMcpClient, setMcpEnabled, type McpSelectedMutation } from "./config-mutation.js"
import { createMcpConnectors } from "./connectors.js"
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
  /** Whether the person turned claude.ai connectors on, in the applied config. */
  claudeAiConnectors(): boolean
  /** Starts a fresh call engine for one claude.ai connector, reads the connectors again, applies the list, and
   *  starts a new connection attempt of the connector, also when the list did not change. */
  reconnectConnector(name: string): Promise<void>
  /** Settles every first connection attempt, each bounded by the startup
   *  deadline, and names each server that needs a sign-in or failed with the
   *  `flywheel mcp` verb that repairs it. It never starts a sign-in. */
  settleStartup(): Promise<readonly string[]>
  subscribe(listener: () => void): () => void
  setEnabled(request: Omit<McpSelectedMutation, "projectRoot"> & { readonly enabled: boolean }): Promise<ConfigMutationResult>
  setClient(request: Omit<McpSelectedMutation, "projectRoot"> & { readonly client: "flywheel" | "claude" }): Promise<ConfigMutationResult>
  setClaudeAiConnectors(enabled: boolean): Promise<ConfigMutationResult>
  remove(request: Omit<McpSelectedMutation, "projectRoot">): Promise<ConfigMutationResult>
}

export const mcpService = moduleServiceHandle<McpService>("mcp")

/** The Claude provider module's service, as far as the MCP module reads it: the Claude logins of the resolved auth
 *  profile, which carry no token. Absent while that module was never on. */
export const CLAUDE_PROVIDER_MODULE_ID = "provider-claude-agent-sdk"
export const claudeLoginEngines = moduleServiceHandle<ClaudeLoginEngines>(CLAUDE_PROVIDER_MODULE_ID)

export function createMcpService(services: PortableModuleServices, options: Pick<McpManagerOptions, "connect" | "claudeEngine" | "connectors"> = {}): McpService {
  const projectRoot = services.directories.projectRoot
  // Scope and expectations describe settled resources, not the latest desired publication.
  let applied = configSection(services.config.snapshot().config, mcpConfigSection)
  /** The connectors of the last applied read, by server name. Empty while the switch is off. */
  let connectorList: { readonly [name: string]: McpConnectorServer["connector"] } = {}
  /** The login keys of the last applied read, so a selection change sees that the Claude logins changed. */
  let readLogins = ""
  /** Whether the applied registry was built with the switch on, so a later edit knows that the switch turned on. */
  let connectorsApplied = false
  /** Counts the reads, so only the newest read applies, and none after the switch turned off. */
  let readGeneration = 0
  let latestRead: Promise<void> = Promise.resolve()
  let replacing = false
  const applications = createOrderedLane()
  const listeners = new Set<() => void>()
  const authDir = accountAuthDir(services.directories.userDataRoot)
  const claudeEngine = options.claudeEngine ?? processClaudeEngine(authDir, services.launcher)
  const claudeLogins = async () => await services.modules.get(claudeLoginEngines)?.logins() ?? []
  const connectors = options.connectors ?? createMcpConnectors(claudeLogins)
  const registry = (source: McpConfig) => withMcpConnectors(resolveMcpConfig(source, projectRoot), source, projectRoot, source.claude_ai_connectors ? connectorList : {})
  const manager = createMcpManager({
    servers: services.enabled() ? registry(applied).servers : {},
    executionCwd: services.directories.executionCwd,
    authDir,
    log: (message, fields) => log.info(message, fields),
    spawnOwned: services.launcher.spawnOwned,
    ...options,
    claudeEngine,
    connectors,
  })
  const observe = (): readonly McpStatusRow[] => {
    const { servers, metadata } = registry(applied)
    return Object.freeze(manager.status().map((row) => {
      // SAFETY: Applied source describes the manager's settled registry, including retained rows after refusal.
      const server = servers[row.name]!
      // SAFETY: As above, every row of the settled registry has its applied metadata.
      const source = metadata[row.name]!
      if (isMcpConnector(server)) {
        return Object.freeze({ ...row, ...source, expected: mcpExpectedToken(applied, projectRoot, row.name, "connectors"), source: { kind: "claude.ai" as const, login: server.connector.identity } })
      }
      const client = resolveMcpClient(server, process.env)?.choice
      return Object.freeze({
        ...row,
        ...source,
        expected: mcpExpectedToken(applied, projectRoot, row.name),
        ...(client === undefined ? {} : { client }),
      })
    }))
  }
  const isConnectorServer = (name: string): boolean => {
    const server = registry(applied).servers[name]
    return server !== undefined && isMcpConnector(server)
  }
  let status = observe()
  const publish = (): void => {
    status = observe()
    for (const listener of listeners) listener()
  }
  const stopManager = manager.subscribe(() => { if (!replacing) publish() })
  /** Applies `source` to the manager with the connectors of the last read. A switch that is off stops every
   *  connector engine and forgets the list. */
  const apply = async (source: McpConfig, enabled: boolean): Promise<void> => {
    const connectorsOn = enabled && source.claude_ai_connectors
    if (!connectorsOn) {
      readGeneration += 1
      connectorList = {}
      readLogins = ""
    }
    connectorsApplied = connectorsOn
    replacing = true
    try {
      await manager.replaceServers(enabled ? registry(source).servers : {})
      applied = source
    } finally {
      replacing = false
      publish()
      // The connectors' connections closed with the replaced registry; this stops what a read still holds.
      if (!connectorsOn) await connectors.stop()
    }
  }
  /** Reads the connectors outside the application lane, so an edit of the section never waits for the engines, and
   *  applies the list when the read is still the newest and the switch is still on. The read's hold of the call
   *  engines ends once the manager's connections hold what they use, and after `afterApply`, whose connections
   *  then reuse the engines that the read started. */
  const readConnectors = (afterApply?: () => Promise<void>): Promise<void> => {
    const generation = ++readGeneration
    const run = (async () => {
      const read = await connectors.read()
      try {
        await applications.run(async () => {
          if (generation !== readGeneration || !connectorsApplied) return
          connectorList = read.connectors
          readLogins = read.logins.join("\0")
          await apply(applied, services.enabled())
        })
        await afterApply?.()
      } finally {
        await read.release()
      }
    })()
    latestRead = run.catch(() => {})
    return run
  }
  /** Applies one edit of the section or of the module selection. The list is read when the switch turns on, and
   *  while it stays on, again when the Claude logins changed, such as when the Claude provider module turned off. */
  const follow = (snapshot: RuntimeConfigSnapshot, enabled: boolean, selection: boolean): Promise<void> => applications.run(async () => {
    const wasOn = connectorsApplied
    await apply(configSection(snapshot.config, mcpConfigSection), enabled)
    if (!connectorsApplied) return
    if (!wasOn || (selection && (await claudeLogins()).map((login) => login.key).join("\0") !== readLogins)) void readConnectors()
  })
  const unsubscribe = [
    services.config.subscribe(mcpConfigSection, (snapshot) => follow(snapshot, services.enabled(), false)),
    services.onSelectionChanged(() => follow(services.config.snapshot(), services.enabled(), true)),
  ]
  return {
    manager,
    ports: { servers: manager.servers, tools: manager.tools, call: manager.call },
    authentication: createMcpAuthenticationService({ manager, launcher: services.launcher }),
    status: () => status,
    claudeAiConnectors: () => applied.claude_ai_connectors,
    async reconnectConnector(name) {
      await connectors.restart(name)
      const reconnect = () => manager.credentialUpdated(name)
      await (connectorsApplied ? readConnectors(reconnect) : reconnect())
    },
    start() {
      // The list is read when the service starts with the switch on, once the Claude provider's service exists; the
      // configured servers connect meanwhile.
      connectorsApplied = services.enabled() && applied.claude_ai_connectors
      if (connectorsApplied) void readConnectors()
    },
    async settleStartup() {
      // An edit that is still applying can start a read.
      await applications.settled()
      await latestRead
      await Promise.allSettled(manager.entries().flatMap(({ name, state }) => state.tag === "pending" ? [manager.acquire(name)] : []))
      return status.flatMap((row) => {
        const local = row.definitionScope === "project" ? " --local" : ""
        if (row.source !== undefined && row.status === "needs_auth") return [`claude.ai connector '${row.name}' needs a sign-in. Sign in to it at claude.ai.`]
        if (row.status === "needs_auth") return [`MCP server '${row.name}' needs authentication. Run \`flywheel mcp login ${row.name}${local}\` to sign in.`]
        if (row.status === "failed") return [`MCP server '${row.name}' failed to connect. Run \`flywheel mcp status${local}\` to inspect it.`]
        return []
      })
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setEnabled: (request) => setMcpEnabled(services.config, { ...request, projectRoot, connector: isConnectorServer(request.server) }),
    setClient: (request) => setMcpClient(services.config, { ...request, projectRoot }, process.env),
    setClaudeAiConnectors: (enabled) => setMcpClaudeAiConnectors(services.config, enabled),
    remove: (request) => removeMcpServer(services.config, { ...request, projectRoot }),
    async dispose() {
      await Promise.all(unsubscribe.map((stop) => stop()))
      readGeneration += 1
      await applications.settled()
      stopManager()
      listeners.clear()
      await manager.dispose()
      await Promise.all([claudeEngine.dispose(), connectors.stop()])
    },
  }
}
