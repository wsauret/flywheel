import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ClaudeLoginEngineLaunch, ClaudeLoginHost } from "../../../../../src/infra/claude-engine.js"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js"
import type { ModuleProcessServices } from "../../../../../src/orchestration/app-service/module-service-host.js"
import { createRuntimeConfigOwner } from "../../../../../src/orchestration/config/runtime-config-owner.js"
import { createMcpService, type McpService } from "../../../../../src/orchestration/modules/mcp/service.js"
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js"
import { refusingLauncher } from "../../../../helpers/launcher-fake.js"
import { moduleProcessServices } from "../../../../helpers/module-kernel.js"

const temporary = temporaryDirectories()
/** The stderr window of a real discovery engine's context usage request, which holds the Claude Docs connector's
 *  eight tools; see connector-tools-capture.test.ts. */
const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "connector-count-tokens.log"), "utf8").replace(/\n$/u, "").split("\n")
const DOCS = "claude.ai Claude Docs"
const ON = "[mcp]\nclaude_ai_connectors = true\n"

interface FakeConnector {
  readonly name: string
  status: "connected" | "needs-auth"
}

/** What the fake logins saw: each engine start, each stop, and each tool call with the login that carried it. */
interface Journal {
  readonly starts: { readonly login: string; readonly discovery: boolean }[]
  readonly calls: { readonly login: string; readonly tool: string }[]
  stops: number
}

/**
 * One Claude login whose engines answer as the engine does: the call engine lists the login's connectors as they were
 * when it started and calls their tools, and the discovery engine connects the one connector it is given and logs the
 * real count block. A stopped engine answers nothing more. `key` names the login location, which tells the logins of
 * two profiles apart; a login that `fails` starts no engine.
 */
function fakeLogin(accountId: string, connectors: readonly FakeConnector[], journal: Journal, { key = accountId, fails = false } = {}): ClaudeLoginHost {
  return {
    key,
    accountId,
    identity: `${accountId}@example.com`,
    async start(launch: ClaudeLoginEngineLaunch) {
      journal.starts.push({ login: key, discovery: launch.debugLog !== undefined })
      if (fails) throw new Error("The Claude login is signed out")
      const fetched = connectors.map((connector) => ({ ...connector }))
      let explicit: readonly string[] = []
      let stopped = false
      const answering = () => { if (stopped) throw new Error("the engine stopped") }
      const status = (connector: FakeConnector) => ({ name: connector.name, status: connector.status, config: { type: "claudeai-proxy", url: `https://upstream.example/${accountId}`, id: `id-${connector.name}` }, tools: connector.name === DOCS ? ["batch", "create", "delete", "export", "guide", "query", "read", "update"].map((name) => ({ name })) : [] })
      const query = {
        mcpServerStatus: async () => {
          answering()
          return launch.connectors ? fetched.map(status) : connectors.filter((connector) => explicit.includes(connector.name)).map(status)
        },
        setMcpServers: async (servers: { readonly [name: string]: unknown }) => { explicit = Object.keys(servers) },
        getContextUsage: async () => { for (const line of FIXTURE) launch.debugLog?.(line) },
        request: async (request: { readonly tool: string }) => {
          answering()
          journal.calls.push({ login: key, tool: request.tool })
          return { response: { content: [{ type: "text", text: "answered" }] } }
        },
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- the fake implements only the requests that the connectors send.
      return { query: query as never, ended: new Promise<void>(() => {}), stop: async () => { stopped = true; journal.stops += 1 } }
    },
  }
}

const services: McpService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
})

/** An MCP service whose Claude provider offers the logins that `logins` names, while `provider.on` holds. */
async function connectorService(toml: string, logins: (seen: Journal) => readonly ClaudeLoginHost[]) {
  const configPath = join(temporary("mcp-connectors-"), "flywheel.toml")
  writeFileSync(configPath, toml)
  const owner = await createRuntimeConfigOwner({ configPath, watch: false })
  const journal: Journal = { starts: [], calls: [], stops: 0 }
  const provider = { on: true, logins: logins(journal) }
  const launcher: LauncherScope = { ...refusingLauncher, spawnOwned: () => { throw new Error("no process launches") } }
  const selectionListeners: (() => void)[] = []
  const onSelectionChanged: ModuleProcessServices["onSelectionChanged"] = (listener) => {
    selectionListeners.push(listener)
    return () => {}
  }
  const service = createMcpService({
    ...moduleProcessServices({ config: owner, directories: { ...testDirectories(process.cwd()), projectRoot: "/scratch/project" }, onSelectionChanged, launcher }),
    modules: composeModuleServices([["provider-claude-agent-sdk", { logins: async () => provider.on ? provider.logins : [], dispose: async () => {} }]]),
  })
  services.push(service)
  service.start?.()
  /** Changes the module selection, as turning the Claude provider module on or off does, and settles what it read. */
  const select = async (change: () => void) => {
    change()
    for (const listener of selectionListeners) listener()
    await service.settleStartup()
  }
  return { service, journal, owner, provider, select }
}

const rows = (service: McpService) => service.status().map((row) => [row.name, row.status, row.source?.login])

describe("claude.ai connectors", () => {
  test("with the switch off, no engine starts and no connector row appears", async () => {
    const { service, journal } = await connectorService("", (seen) => [fakeLogin("work", [{ name: DOCS, status: "connected" }], seen)])
    expect(await service.settleStartup()).toEqual([])
    expect(service.status()).toEqual([])
    expect(service.claudeAiConnectors()).toBe(false)
    expect(journal.starts).toEqual([])
  })

  test("with the switch on, the connectors of every login appear once, and each calls through the first login that has it", async () => {
    const { service, journal } = await connectorService(ON, (seen) => [
      fakeLogin("work", [{ name: DOCS, status: "connected" }], seen),
      fakeLogin("home", [{ name: DOCS, status: "connected" }, { name: "claude.ai Calendar", status: "needs-auth" }], seen),
    ])
    expect(await service.settleStartup()).toEqual(["claude.ai connector 'claude_ai_Calendar' needs a sign-in. Sign in to it at claude.ai."])
    expect(service.status().map((row) => [row.name, row.status, row.toolCount, row.source])).toEqual([
      ["claude_ai_Claude_Docs", "ready", 8, { kind: "claude.ai", login: "work@example.com" }],
      ["claude_ai_Calendar", "needs_auth", 0, { kind: "claude.ai", login: "home@example.com" }],
    ])
    expect(service.ports.tools().map((tool) => `${tool.server}.${tool.name}`)).toContain("claude_ai_Claude_Docs.guide")
    expect(await service.ports.call({ server: "claude_ai_Claude_Docs", name: "guide", arguments: {} })).toMatchObject({ isError: false })
    expect(journal.calls).toEqual([{ login: "work", tool: "mcp__claude_ai_Claude_Docs__guide" }])
    // The home login serves only a connector that needs a sign-in, so its call engine stops once the read ends.
    expect(journal.starts).toEqual([{ login: "work", discovery: false }, { login: "home", discovery: false }, { login: "work", discovery: true }])
    expect(journal.stops).toBe(2)
  })

  test("a connector's enabled choice is stored apart from configured servers; disabling the last one stops its engine, and turning the switch off stops every engine", async () => {
    const { service, journal } = await connectorService(ON, (seen) => [fakeLogin("work", [{ name: DOCS, status: "connected" }], seen)])
    await service.settleStartup()
    const row = service.status()[0]!
    // The discovery engine stopped after its read; the call engine runs for the connection.
    expect(journal.stops).toBe(1)
    expect(await service.setEnabled({ server: row.name, scope: "project", enabled: false, expected: row.expected })).toMatchObject({ ok: true })
    expect(service.status()[0]).toMatchObject({ name: "claude_ai_Claude_Docs", status: "disabled", enabledScope: "project" })
    expect(journal.stops).toBe(2)
    expect(await service.setClaudeAiConnectors(false)).toMatchObject({ ok: true })
    expect(service.status()).toEqual([])
    expect(service.claudeAiConnectors()).toBe(false)
    expect(journal.stops).toBe(journal.starts.length)
  })

  test("a login with no connectors does not hold up the switch, which settles when the config is written", async () => {
    const { service } = await connectorService("", (seen) => [fakeLogin("work", [], seen)])
    const startedAt = Date.now()
    expect(await service.setClaudeAiConnectors(true)).toMatchObject({ ok: true })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(service.claudeAiConnectors()).toBe(true)
  })

  test("the connectors follow the Claude provider module: off removes their rows and tools and stops their engines, on brings them back", async () => {
    const { service, journal, provider, select } = await connectorService("[mcp]\nclaude_ai_connectors = true\n[mcp.servers.local]\ncommand = \"tool\"\n", (seen) => [fakeLogin("work", [{ name: DOCS, status: "connected" }], seen)])
    await service.settleStartup()
    expect(rows(service)).toContainEqual(["claude_ai_Claude_Docs", "ready", "work@example.com"])
    await select(() => { provider.on = false })
    expect(rows(service).map(([name]) => name)).toEqual(["local"])
    expect(service.ports.tools()).toEqual([])
    expect(journal.stops).toBe(journal.starts.length)
    await select(() => { provider.on = true })
    expect(rows(service)).toContainEqual(["claude_ai_Claude_Docs", "ready", "work@example.com"])
  })

  test("after the auth profile changed, a connector calls through the new profile's login, and the old login's engine stops", async () => {
    const { service, journal, provider, select } = await connectorService(ON, (seen) => [fakeLogin("work", [{ name: DOCS, status: "connected" }], seen, { key: "/profiles/a/work" })])
    await service.settleStartup()
    await select(() => { provider.logins = [fakeLogin("work", [{ name: DOCS, status: "connected" }], journal, { key: "/profiles/b/work" })] })
    expect(await service.ports.call({ server: "claude_ai_Claude_Docs", name: "guide", arguments: {} })).toMatchObject({ isError: false })
    expect(journal.calls).toEqual([{ login: "/profiles/b/work", tool: "mcp__claude_ai_Claude_Docs__guide" }])
    const calls = journal.starts.filter((start) => !start.discovery).map((start) => start.login)
    expect(calls).toEqual(["/profiles/a/work", "/profiles/b/work"])
    // The old profile's call and discovery engines stopped; the new profile's call engine runs.
    expect(journal.stops).toBe(journal.starts.length - 1)
  })

  test("a login that cannot be reached shows as one failed row that points to /auth, and the other login's connectors still work", async () => {
    const { service } = await connectorService(ON, (seen) => [
      fakeLogin("work", [], seen, { fails: true }),
      fakeLogin("home", [{ name: DOCS, status: "connected" }], seen),
    ])
    await service.settleStartup()
    expect(service.status().map((row) => [row.name, row.status, row.errorCode, row.error, row.source?.login])).toEqual([
      ["claude_ai_Claude_Docs", "ready", undefined, undefined, "home@example.com"],
      ["claude_ai_login_work_example_com", "failed", "login_unreachable", "Flywheel could not reach this connector's Claude login. Check the login with /auth.", "work@example.com"],
    ])
  })

  test("a connector that needs a sign-in reconnects once the person signed in at claude.ai, on a fresh call engine", async () => {
    const docs: FakeConnector = { name: DOCS, status: "needs-auth" }
    const { service, journal } = await connectorService(ON, (seen) => [fakeLogin("work", [docs], seen)])
    await service.settleStartup()
    expect(rows(service)).toEqual([["claude_ai_Claude_Docs", "needs_auth", "work@example.com"]])
    docs.status = "connected"
    await service.reconnectConnector("claude_ai_Claude_Docs")
    await service.manager.acquire("claude_ai_Claude_Docs")
    expect(rows(service)).toEqual([["claude_ai_Claude_Docs", "ready", "work@example.com"]])
    // The reconnect's read and its connection share one fresh call engine.
    expect(journal.starts.filter((start) => !start.discovery)).toHaveLength(2)
  })
})
