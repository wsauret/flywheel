import { createInterface } from "node:readline"
import { Redacted } from "effect"
import { mcpRemovalConfirmation } from "../../../../protocol/modules/mcp.js"
import type { AccountDirectories, StartupDirectories } from "../../../../infra/directory-authorities.js"
import { openExternalUrl, type ExternalUrlOpener } from "../../../../infra/open-external-url.js"
import type { LauncherScope } from "../../../../infra/process-supervisor.js"
import { accountAuthDir, globalConfigFile } from "../../../../infra/paths.js"
import { createRuntimeConfigOwner, type RuntimeConfigOwner } from "../../../config/runtime-config-owner.js"
import { configSection } from "../../../config/config-section.js"
import { mcpConfigSection, resolveMcpConfig, resolveMcpTemplate, isMcpEnabledOverride, type McpServerConfig, type McpConfig, type McpScope } from "../config.js"
import { addMcpServers, removeMcpServer, mcpExpectedToken, mcpMutationMessage } from "../config-mutation.js"
import { createMcpCredentialStore, type McpCredential, type McpCredentialStore } from "../credentials.js"
import { createMcpManager } from "../manager.js"
import { MCP_USAGE, parseMcpArgs } from "./args.js"

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|.*(?:token|api[-_]?key|secret).*)$/i
// A config-safe sensitive header value is a single ${VAR} template, optionally framed by one
// auth-scheme word (e.g. "Bearer ${TOKEN}"). Fully literal sensitive values are diverted to the
// credential store; a literal fragment mixed with a template is rejected because it cannot be
// split into a safe config part and a secret part.
const TEMPLATE_VALUE = /^(?:[A-Za-z][A-Za-z0-9._-]*[ ])?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
const CONTAINS_TEMPLATE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/

interface StringDictionary {
  [key: string]: string
}

interface UnknownDictionary {
  [key: string]: unknown
}

interface NormalizedClaudeServers {
  [name: string]: NormalizedClaudeServer
}

export interface RunMcpOptions {
  readonly configPath?: string
  readonly createManager?: typeof createMcpManager
  readonly openBrowser?: ExternalUrlOpener
  readonly credentialStore?: McpCredentialStore
  /** Asks the user one question on the terminal; tests replace it. */
  readonly prompt?: (question: string) => Promise<string>
  /** Launch authority of this command: the stdio servers it connects to and
   *  the browser handoff its login performs both run inside it. */
  readonly launcher?: LauncherScope
}

/** `directories` carries the account authorities the credential store and
 *  configuration hang off. Project choices use the startup-canonical project
 *  root; stdio servers use the separate execution directory (ARCH-DIRECTORIES-001). */
export async function runMcp(
  args: readonly string[],
  directories: AccountDirectories & Pick<StartupDirectories, "executionCwd" | "projectRoot">,
  options: RunMcpOptions = {},
): Promise<void> {
  const launcher = options.launcher
  // A command with no launch authority has nothing to hand a browser to; the
  // authorization URL is printed either way, which is the instruction the user
  // follows when no browser opens.
  const openAuthorizationUrl: ExternalUrlOpener = options.openBrowser
    ?? (launcher ? (url) => openExternalUrl(launcher, url) : async () => false)
  const action = parseMcpArgs(args)
  if (action.kind === "help") { console.log(MCP_USAGE); return }
  if (action.kind === "error") { console.error(`${action.message}\n\n${MCP_USAGE}`); process.exitCode = 1; return }
  const configPath = options.configPath ?? globalConfigFile(directories.userDataRoot)
  const runtimeConfig = await createRuntimeConfigOwner({ configPath, userDataRoot: directories.userDataRoot, watch: false })
  const configStatus = runtimeConfig.snapshot().status
  const scope = action.local ? "project" : "global"
  try {
    if (action.kind === "import") {
      let source: unknown
      try {
        source = await Bun.file(action.path).json()
      } catch {
        throw new Error("Invalid .mcp.json: malformed JSON")
      }
      const servers = normalizeClaudeMcp(source)
      const diverted = Object.fromEntries(Object.entries(servers)
        .filter(([, entry]) => entry.config.url !== undefined && Object.keys(entry.secretHeaders).length > 0)
        .map(([name, entry]) => [name, { url: entry.config.url ?? "", secretHeaders: entry.secretHeaders }]))
      const result = await addMcpServers(runtimeConfig, directories.projectRoot, scope,
        Object.fromEntries(Object.entries(servers).map(([name, entry]) => [name, entry.config])),
      )
      if (!result.ok) throw new Error(mcpMutationMessage(result))
      console.log(`Imported ${Object.keys(servers).length} MCP server(s) into ${scope} configuration.`)
      const warning = mcpMutationMessage(result)
      if (warning) console.warn(warning)
      for (const [name, entry] of Object.entries(servers)) {
        if (entry.config.oauth?.client_id !== undefined) console.log(`'${name}' uses a pre-registered OAuth client. If the client has a secret, store it with: flywheel mcp login ${name}${action.local ? " --local" : ""} --client-secret`)
      }
      for (const [name, entry] of Object.entries(diverted)) await storeSecretHeaders(name, entry.url, entry.secretHeaders, options, accountAuthDir(directories.userDataRoot))
      return
    }
    if (action.kind === "add") {
      const { name, server } = action.spec
      // Ask before the config write, so a cancelled prompt adds nothing.
      const clientSecret = action.spec.askClientSecret ? await readClientSecret(options) : undefined
      let secretHeaders: StringDictionary = {}
      let configServer: McpServerConfig = { ...server, enabled: true }
      if ("url" in server) {
        const split = splitSecretHeaders(name, server.headers)
        secretHeaders = split.secret
        configServer = { url: server.url, headers: split.safe, ...(server.oauth === undefined ? {} : { oauth: server.oauth }), enabled: true }
      }
      const result = await addMcpServers(runtimeConfig, directories.projectRoot, scope, { [name]: configServer })
      if (!result.ok) throw new Error(mcpMutationMessage(result))
      console.log(`Added MCP server '${name}' to ${scope} configuration.`)
      const warning = mcpMutationMessage(result)
      if (warning) console.warn(warning)
      if ("url" in server) {
        if (Object.keys(secretHeaders).length > 0) await storeSecretHeaders(name, server.url, secretHeaders, options, accountAuthDir(directories.userDataRoot))
        if (clientSecret !== undefined) await storeClientSecret(name, server.url, clientSecret, options, accountAuthDir(directories.userDataRoot))
        if (Object.keys(server.headers).length === 0) console.log(`Next: flywheel mcp login ${name}${action.local ? " --local" : ""}`)
      }
      return
    }
    if (configStatus.kind === "malformed") throw new Error("Invalid Flywheel configuration. Check the configuration and try again.")
    const config = configSection(runtimeConfig.snapshot().config, mcpConfigSection)
    const effective = resolveMcpConfig(config, directories.projectRoot)
    const servers = action.local ? effective.servers : config.servers
    if (action.kind === "remove") {
      await removeConfiguredServer(runtimeConfig, config, directories.projectRoot, scope, action.name, options)
      return
    }
    if (action.kind === "login" && servers[action.name] === undefined) {
      const names = Object.keys(servers).sort()
      throw new Error(`MCP server not found: ${action.name}. Configured servers: ${names.length > 0 ? names.join(", ") : "none"}`)
    }
    if (action.kind === "login" && action.askClientSecret) {
      const server = servers[action.name]
      if (server?.oauth?.client_id === undefined || server.url === undefined) throw new Error(`--client-secret requires oauth.client_id in the config of MCP server '${action.name}'`)
      await storeClientSecret(action.name, server.url, await readClientSecret(options), options, accountAuthDir(directories.userDataRoot))
    }
    const manager = (options.createManager ?? createMcpManager)({
      servers,
      executionCwd: directories.executionCwd,
      authDir: accountAuthDir(directories.userDataRoot),
      ...(launcher ? { spawnOwned: launcher.spawnOwned } : {}),
    })
    try {
      if (action.kind === "status") {
        await Promise.allSettled(manager.entries()
          .filter((entry) => entry.state.tag !== "disabled")
          .map((entry) => manager.acquire(entry.name)))
        for (const row of manager.status()) {
          const source = action.local ? effective.metadata[row.name] : undefined
          const label = source?.definitionScope ?? "global"
          const override = source?.definitionScope === "global" && source.enabledScope === "project" ? ", project enabled override" : ""
          console.log(`${row.name} [${label}${override}]: ${row.status}${row.status === "ready" ? ` (${row.toolCount} tools)` : ""}${row.error ? ` - ${row.error}` : ""}`)
        }
        if (manager.status().length === 0) console.log("No MCP servers configured.")
        return
      }
      const authorization = await manager.authorize(action.name)
      try {
        console.log(`Open this URL to authenticate ${action.name}:\n  ${authorization.url}\n\nWaiting for authorization...`)
        await openAuthorizationUrl(authorization.url)
        await authorization.complete()
        await manager.credentialUpdated(action.name)
        console.log(`${action.name} authenticated. A separately running Flywheel TUI does not live-refresh; use /mcp there to reauthenticate or restart it.`)
      } finally {
        await authorization.close()
      }
    } finally {
      await manager.dispose()
    }
  } catch (error) {
    console.error(`MCP command failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    await runtimeConfig.dispose()
  }
}

async function removeConfiguredServer(owner: RuntimeConfigOwner, config: McpConfig, projectRoot: string, scope: McpScope, name: string, options: RunMcpOptions): Promise<void> {
  const selected = scope === "project" ? config.projects[projectRoot]?.servers[name] : config.servers[name]
  if (selected === undefined) throw new Error(`MCP server not found in ${scope} configuration: ${name}`)
  const expected = mcpExpectedToken(config, projectRoot, name)
  const override = isMcpEnabledOverride(selected)
  const confirmation = scope === "project" && override
    ? "Remove this project's enabled override? This restores the inherited global enabled state. Saved credentials are kept."
    : mcpRemovalConfirmation({ name, definitionScope: scope, hasGlobalFallback: config.servers[name] !== undefined }).message
  const answer = await (options.prompt ?? promptFromTerminal)(`${confirmation} [y/N] `)
  if (!/^(?:y|yes)$/i.test(answer.trim())) { console.log("MCP removal canceled."); return }
  const result = await removeMcpServer(owner, { projectRoot, server: name, scope, expected })
  if (!result.ok) throw new Error(mcpMutationMessage(result))
  console.log(`Removed ${scope} MCP server '${name}'.${scope === "project" && override ? " Restored inherited enabled state." : ""} Saved credentials are kept.`)
  const warning = mcpMutationMessage(result)
  if (warning) console.warn(warning)
}

// Literal secret header values never reach flywheel.toml: they go to the 0600 credential store
// keyed by server name + URL, and the manager merges them back in at connect time.
function splitSecretHeaders(
  name: string,
  headers: Readonly<StringDictionary>,
) {
  const safe: StringDictionary = {}
  const secret: StringDictionary = {}
  for (const [header, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADER.test(header) || TEMPLATE_VALUE.test(value)) {
      safe[header] = value
      continue
    }
    if (CONTAINS_TEMPLATE.test(value)) throw new Error(`Sensitive MCP header '${header}' for '${name}' mixes literal text with a \${VAR} template; use a single \${VAR} template (optionally after a scheme word like Bearer)`)
    secret[header] = value
  }
  return { safe, secret }
}

async function storeSecretHeaders(name: string, urlTemplate: string, secretHeaders: Readonly<StringDictionary>, options: RunMcpOptions, credentials: string): Promise<void> {
  await updateStoredCredential(name, urlTemplate, options, credentials, (existing) => ({
    ...existing,
    headers: {
      ...existing?.headers,
      ...Object.fromEntries(Object.entries(secretHeaders).map(([header, value]) => [header, Redacted.make(value)])),
    },
  }))
  const count = Object.keys(secretHeaders).length
  console.log(`Stored ${count} secret header${count === 1 ? "" : "s"} for '${name}' in the Flywheel credential store (kept out of flywheel.toml).`)
}

async function storeClientSecret(name: string, urlTemplate: string, clientSecret: Redacted.Redacted<string>, options: RunMcpOptions, credentials: string): Promise<void> {
  await updateStoredCredential(name, urlTemplate, options, credentials, (existing) => ({ ...existing, clientSecret }))
  console.log(`Stored the OAuth client secret for '${name}' in the Flywheel credential store (kept out of flywheel.toml).`)
}

async function updateStoredCredential(
  name: string,
  urlTemplate: string,
  options: RunMcpOptions,
  credentials: string,
  update: (existing: McpCredential | undefined) => McpCredential,
): Promise<void> {
  const url = Redacted.value(resolveMcpTemplate(urlTemplate, process.env))
  const store = options.credentialStore ?? createMcpCredentialStore(credentials)
  await store.save(name, url, update(store.get(name, url)))
}

// MCP_CLIENT_SECRET supplies the secret, so a scripted add needs no terminal.
// Other MCP clients read the same variable name.
async function readClientSecret(options: RunMcpOptions): Promise<Redacted.Redacted<string>> {
  const secret = process.env.MCP_CLIENT_SECRET ?? await (options.prompt ?? promptFromTerminal)("Enter the OAuth client secret: ")
  if (secret.trim().length === 0) throw new Error("The OAuth client secret is empty")
  return Redacted.make(secret.trim())
}

function promptFromTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.once("close", () => resolve(""))
    rl.question(question, (answer) => {
      resolve(answer)
      rl.close()
    })
  })
}

interface NormalizedClaudeServer {
  readonly config: McpServerConfig
  readonly secretHeaders: StringDictionary
}

function normalizeClaudeMcp(source: unknown): Readonly<NormalizedClaudeServers> {
  if (!isRecord(source) || !isRecord(source.mcpServers)) throw new Error("Invalid .mcp.json: expected an mcpServers object")
  const servers: NormalizedClaudeServers = {}
  for (const [name, value] of Object.entries(source.mcpServers)) {
    if (!name || !isRecord(value)) throw new Error(`Invalid .mcp.json server: ${name || "<empty>"}`)
    const command = typeof value.command === "string" && value.command.length > 0 ? value.command : undefined
    const url = typeof value.url === "string" && value.url.length > 0 ? value.url : undefined
    if ((command === undefined) === (url === undefined)) throw new Error(`Invalid .mcp.json server '${name}': specify exactly one of command or url`)
    if (command !== undefined && (value.headers !== undefined || value.url !== undefined)) throw new Error(`Invalid stdio fields for MCP server '${name}'`)
    if (url !== undefined && (value.command !== undefined || value.args !== undefined || value.env !== undefined)) throw new Error(`Invalid HTTP fields for MCP server '${name}'`)
    if (command !== undefined) {
      const args = value.args === undefined ? [] : value.args
      const env = value.env === undefined ? {} : value.env
      if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) throw new Error(`Invalid args for MCP server '${name}'`)
      if (!stringRecord(env)) throw new Error(`Invalid env for MCP server '${name}'`)
      servers[name] = { config: { command, args, env, enabled: true }, secretHeaders: {} }
      continue
    }
    const headers = value.headers === undefined ? {} : value.headers
    if (!stringRecord(headers)) throw new Error(`Invalid headers for MCP server '${name}'`)
    if (url === undefined) throw new Error(`Invalid MCP server URL: ${name}`)
    const split = splitSecretHeaders(name, headers)
    const oauth = claudeOAuthClient(name, value.oauth)
    servers[name] = { config: { url, headers: split.safe, ...(oauth === undefined ? {} : { oauth }), enabled: true }, secretHeaders: split.secret }
  }
  return servers
}

// A `.mcp.json` file keeps a pre-registered client as `oauth: { clientId, callbackPort }`
// and its secret elsewhere, such as the system keychain, which an import cannot read.
function claudeOAuthClient(name: string, value: unknown): McpServerConfig["oauth"] {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`Invalid oauth for MCP server '${name}'`)
  const { clientId, callbackPort } = value
  if (clientId !== undefined && (typeof clientId !== "string" || clientId.length === 0)) throw new Error(`Invalid oauth.clientId for MCP server '${name}'`)
  if (callbackPort !== undefined && (typeof callbackPort !== "number" || !Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535)) throw new Error(`Invalid oauth.callbackPort for MCP server '${name}'`)
  if (clientId === undefined && callbackPort === undefined) return undefined
  return { ...(clientId === undefined ? {} : { client_id: clientId }), ...(callbackPort === undefined ? {} : { callback_port: callbackPort }) }
}

function stringRecord(value: unknown): value is StringDictionary {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is UnknownDictionary {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
