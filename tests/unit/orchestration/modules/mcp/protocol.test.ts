import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { accountAuthDir } from "../../../../../src/infra/paths.js"
import type { ModuleProtocolServices } from "../../../../../src/orchestration/app-service/module-protocol-host.js"
import type { ModuleProcessServices } from "../../../../../src/orchestration/app-service/module-service-host.js"
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js"
import { createRuntimeConfigOwner } from "../../../../../src/orchestration/config/runtime-config-owner.js"
import { ConfigWriteError } from "../../../../../src/orchestration/config/writer.js"
import type { McpConnection } from "../../../../../src/orchestration/modules/mcp/connection.js"
import { McpNeedsAuthError } from "../../../../../src/orchestration/modules/mcp/errors.js"
import { createMcpManager, type McpManager } from "../../../../../src/orchestration/modules/mcp/manager.js"
import { createMcpProtocol } from "../../../../../src/orchestration/modules/mcp/protocol.js"
import { createMcpService, type McpService } from "../../../../../src/orchestration/modules/mcp/service.js"
import { mcpCursor, mcpDomain, mcpEnabledAction, mcpProjectEnabledAction, mcpRemovalConfirmation, mcpProtocol, type McpStatusRow } from "../../../../../src/protocol/modules/mcp.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { testDirectories, temporaryDirectories } from "../../../../helpers/directories.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { fakeManager, fakeSessionStore } from "../../app-service/app-service-doubles.js"
import type { DomainReader } from "../../../../../src/protocol/protocol-module.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import { refusingLauncher } from "../../../../helpers/launcher-fake.js"
import { moduleProcessServices } from "../../../../helpers/module-kernel.js"

// The account credential directory the composition root publishes. It resolves
// under the isolated test account home, so no case reads real credentials.
const AUTH_DIR = accountAuthDir(testDirectories(process.cwd()).userDataRoot)
const temporary = temporaryDirectories()
const globalMetadata = { definitionScope: "global", enabledScope: "global", enabled: true, hasGlobalFallback: false, expected: "test-expectation" } as const

function readMcp(rows: readonly McpStatusRow[]): DomainReader {
  return moduleDomainReader((domain) => domain.domain === mcpDomain.domain ? rows : undefined)
}

/** The protocol runtime over one manager, with the module on or off. */
function protocolOver(manager: McpManager, options: { readonly enabled?: boolean; readonly authenticate?: (server: string) => Promise<void>; readonly service?: McpService } = {}) {
  const patches: RuntimeUiPatchInput[] = []
  const service: McpService = options.service ?? {
    manager,
    ports: { servers: manager.servers, tools: manager.tools, call: manager.call },
    authentication: { authenticate: options.authenticate ?? (async () => {}) },
    status: () => manager.status().map((row) => ({ ...row, ...globalMetadata })),
    settleStartup: async () => [],
    subscribe: manager.subscribe,
    setEnabled: async () => { throw new Error("status fixture does not mutate") },
    remove: async () => { throw new Error("status fixture does not mutate") },
    dispose: () => manager.dispose(),
  }
  const reader = asAsyncEventReadSurface(inMemoryEventReader([]))
  const services: ModuleProtocolServices = {
    eventStore: reader,
    eventWriter: { append: async () => { throw new Error("No MCP fact write") }, appendBatch: async () => { throw new Error("No MCP fact write") }, pruneSupersededEvents: async () => 0 },
    projectionReader: reader,
    manager: fakeManager(),
    sessionStore: fakeSessionStore(new Map()),
    definitions: repoDefinitions(),
    onStored: () => () => {},
    publish: (input) => { patches.push(input); return { ...input, position: patches.length, prevPosition: patches.length - 1 } },
    snapshotPosition: () => 37,
    hasLiveSession: () => false,
    background: async () => { throw new Error("The MCP domain reads no background history") },
    modules: composeModuleServices([["mcp", service]]),
    enabled: () => options.enabled ?? true,
    interruptSession: async () => false,
  }
  return { runtime: createMcpProtocol(services), patches }
}

describe("MCP protocol runtime", () => {
  test("publishes the whole redacted server list on every transition and ignores stale callbacks", async () => {
    let closeCallback = (): void => {}
    const connection: McpConnection = {
      instructions: undefined,
      tools: () => [{ server: "work", name: "search", description: "", inputSchema: {}, annotations: {} }],
      callTool: async () => ({ content: [], isError: false }),
      onClose: (callback) => { closeCallback = callback },
      onToolsChanged: () => {},
      close: async () => {},
    }
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { work: { command: "server", args: [], env: {}, enabled: true } },
      connect: async () => connection,
    })
    const { runtime, patches } = protocolOver(manager)
    await manager.acquire("work")
    expect(await runtime.serve.mcpStatusSnapshot({ type: "mcpStatusSnapshot" })).toEqual({ servers: [{ name: "work", status: "ready", toolCount: 1, ...globalMetadata }], snapshotPosition: 37 })
    expect(patches).toContainEqual({ cursor: mcpCursor(), payload: { kind: "mcp.changed", servers: [{ name: "work", status: "ready", toolCount: 1, ...globalMetadata }] } })
    closeCallback()
    const count = patches.length
    closeCallback()
    expect(patches).toHaveLength(count)
    await manager.replaceServers({})
    expect(patches).toHaveLength(count + 1)
    expect(patches.at(-1)).toEqual({ cursor: mcpCursor(), payload: { kind: "mcp.changed", servers: [] } })
    expect(await runtime.serve.mcpStatusSnapshot({ type: "mcpStatusSnapshot" })).toEqual({ servers: [], snapshotPosition: 37 })
    runtime.dispose()
    await manager.dispose()
  })

  test("keeps raw connection failures out of patches and snapshots", async () => {
    const rawFailure = "https://example.test/mcp?token=query-token Authorization: authorization-secret command-secret env-secret"
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { work: { command: "command-secret", args: [], env: { TOKEN: "env-secret" }, enabled: true } },
      connect: async () => { throw new Error(rawFailure) },
    })
    const { runtime, patches } = protocolOver(manager)

    await expect(manager.acquire("work")).rejects.toThrow("query-token")

    const snapshot = await runtime.serve.mcpStatusSnapshot({ type: "mcpStatusSnapshot" })
    for (const sentinel of ["query-token", "authorization-secret", "command-secret", "env-secret"]) {
      expect(JSON.stringify(snapshot)).not.toContain(sentinel)
      expect(JSON.stringify(patches)).not.toContain(sentinel)
    }
    expect(snapshot.servers).toEqual([{
      name: "work",
      status: "failed",
      toolCount: 0,
      error: "Connection failed. Check the server settings and try again.",
      errorCode: "connection_failed",
      ...globalMetadata,
    }])
    runtime.dispose()
    await manager.dispose()
  })

  test("answers empty and refuses reauthentication while the module is off", async () => {
    const manager = createMcpManager({ executionCwd: "/scratch", authDir: AUTH_DIR, servers: { work: { url: "https://mcp.example", headers: {}, enabled: false } } })
    const { runtime, patches } = protocolOver(manager, { enabled: false })
    expect((await runtime.serve.mcpStatusSnapshot({ type: "mcpStatusSnapshot" })).servers).toEqual([])
    expect(await runtime.mutate["mcp.authenticate"]({ type: "mcp.authenticate", server: "work" })).toEqual({ ok: false, error: "MCP servers are off" })
    expect(await runtime.mutate["mcp.reconnect"]({ type: "mcp.reconnect", server: "work" })).toEqual({ ok: false, error: "MCP servers are off" })
    expect(await runtime.mutate["mcp.remove"]({ type: "mcp.remove", server: "work", scope: "global", expected: "test" })).toEqual({ ok: false, error: "MCP servers are off" })
    expect(await runtime.mutate["mcp.setEnabled"]({ type: "mcp.setEnabled", server: "work", scope: "project", enabled: false, expected: "test" })).toEqual({ ok: false, error: "MCP servers are off" })
    expect(patches).toEqual([])
    runtime.dispose()
    await manager.dispose()
  })

  test("runs the closed reauthentication and answers a failure without its cause", async () => {
    const manager = createMcpManager({ executionCwd: "/scratch", authDir: AUTH_DIR, servers: {} })
    let fail = false
    const authenticated: string[] = []
    const { runtime } = protocolOver(manager, { authenticate: async (server) => { if (fail) throw new Error("https://provider.example/?token=secret"); authenticated.push(server) } })
    expect(await runtime.mutate["mcp.authenticate"]({ type: "mcp.authenticate", server: "work" })).toEqual({ ok: true })
    expect(authenticated).toEqual(["work"])
    fail = true
    expect(await runtime.mutate["mcp.authenticate"]({ type: "mcp.authenticate", server: "work" })).toEqual({ ok: false, error: "MCP authentication failed. Try again." })
    runtime.dispose()
    await manager.dispose()
  })

  test("reconnects only the named failed server and answers each failure without its cause", async () => {
    const rawFailure = "https://private.example/mcp?token=query-token"
    const ready = (): McpConnection => ({ instructions: undefined, tools: () => [], callTool: async () => ({ content: [], isError: false }), onClose: () => {}, onToolsChanged: () => {}, close: async () => {} })
    let closeStuck = (): void => {}
    let steadyCloses = 0
    const outcomes = new Map<string, () => McpConnection>([
      ["work", () => { throw new Error(rawFailure) }],
      ["other", () => { throw new Error(rawFailure) }],
      ["steady", () => ({ ...ready(), close: async () => { steadyCloses++ } })],
      // A connection whose close rejects leaves its server failed without a safe retry.
      ["stuck", () => ({ ...ready(), onClose(callback) { closeStuck = callback }, close: async () => { throw new Error(rawFailure) } })],
    ])
    const connects = new Map<string, number>()
    const command = { command: "server", args: [], env: {}, enabled: true }
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { work: command, other: command, steady: command, stuck: command },
      connect: async ({ server }) => { connects.set(server, (connects.get(server) ?? 0) + 1); return outcomes.get(server)!() },
    })
    const { runtime } = protocolOver(manager)
    const reconnect = (server: string) => runtime.mutate["mcp.reconnect"]({ type: "mcp.reconnect", server })
    const statuses = () => Object.fromEntries(manager.status().map((row) => [row.name, row.status]))
    await expect(manager.acquire("work")).rejects.toThrow("query-token")
    await expect(manager.acquire("other")).rejects.toThrow("query-token")
    await manager.acquire("steady")
    await manager.acquire("stuck")
    closeStuck()
    await expect(manager.acquire("stuck")).rejects.toThrow("MCP attempt retirement failed")
    const before = new Map(connects)
    const attemptsSince = (server: string) => (connects.get(server) ?? 0) - (before.get(server) ?? 0)
    try {
      expect(await reconnect("work")).toEqual({ ok: false, error: "work could not connect. Check the server settings and try again." })
      outcomes.set("work", () => { throw new McpNeedsAuthError("work") })
      expect(await reconnect("work")).toEqual({ ok: false, error: "work needs authentication. Authenticate it to connect." })
      outcomes.set("other", ready)
      expect(await reconnect("other")).toEqual({ ok: true })
      expect(await reconnect("stuck")).toEqual({ ok: false, error: "stuck cannot reconnect because its last connection did not close. Restart Flywheel to reconnect it." })
      expect(["work", "other", "steady", "stuck"].map(attemptsSince)).toEqual([2, 1, 0, 0])
      expect(steadyCloses).toBe(0)
      expect(statuses()).toEqual({ work: "needs_auth", other: "ready", steady: "ready", stuck: "failed" })
    } finally {
      runtime.dispose()
      await expect(manager.dispose()).rejects.toThrow("MCP manager disposal failed")
    }
  })

  test("scoped mutations settle real persistence, patches and attention without exposing configuration", async () => {
    const configPath = join(temporary("mcp-protocol-"), "flywheel.toml")
    const projectRoot = "/scratch/selected-private-project"
    writeFileSync(configPath, `[mcp.servers.work]\ncommand = "command-secret"\nenv = { TOKEN = "env-secret" }\n[mcp.servers.other]\ncommand = "other"\n[mcp.servers.local]\ncommand = "inherited-secret"\n[mcp.projects."${projectRoot}".servers.local]\nurl = "https://private.example/endpoint"\nheaders = { KEY = "header-secret" }\nenabled = false\n[mcp.projects."/scratch/other-private-project".servers.hidden]\ncommand = "hidden-secret"\nenabled = false\n`)
    const owner = await createRuntimeConfigOwner({ configPath, watch: false })
    const config: ModuleProcessServices["config"] = owner
    const launcher: LauncherScope = { ...refusingLauncher, spawnOwned: () => { throw new Error("no process launches") } }
    const enabled: ModuleProcessServices["enabled"] = () => true
    const onSelectionChanged: ModuleProcessServices["onSelectionChanged"] = () => () => {}
    const services = moduleProcessServices({ config, directories: { ...testDirectories(process.cwd()), projectRoot }, enabled, onSelectionChanged, launcher })
    const service = createMcpService(services, { connect: async () => { throw new Error("private-connection-failure") } })
    const { runtime, patches } = protocolOver(service.manager, { service })
    try {
      await expect(service.manager.acquire("work")).rejects.toThrow("private")
      await expect(service.manager.acquire("other")).rejects.toThrow("private")
      const before = await runtime.serve.mcpStatusSnapshot({ type: "mcpStatusSnapshot" })
      expect(mcpProtocol.rows.intro(readMcp(before.servers))?.[0]?.value).toBe("2 need attention")
      const row = before.servers.find((current) => current.name === "work")!
      const response = await runtime.mutate["mcp.setEnabled"]({ type: "mcp.setEnabled", server: row.name, scope: "project", enabled: false, expected: row.expected })
      expect(response).toEqual({ ok: true })
      const after = await runtime.serve.mcpStatusSnapshot({ type: "mcpStatusSnapshot" })
      expect(after.servers.find((current) => current.name === "work")).toMatchObject({ definitionScope: "global", enabledScope: "project", enabled: false, status: "disabled" })
      expect(mcpProtocol.rows.intro(readMcp(after.servers))?.[0]?.value).toBe("1 needs attention")
      expect(mcpProtocol.rows.status(readMcp(after.servers))?.[0]?.value).toBe("1 of 3 needs attention")
      const saved = readFileSync(configPath, "utf8")
      expect(await runtime.mutate["mcp.remove"]({ type: "mcp.remove", server: row.name, scope: "global", expected: row.expected })).toEqual({ ok: false, error: "MCP settings changed. Review the current server and try again." })
      expect(readFileSync(configPath, "utf8")).toBe(saved)
      const disabled = after.servers.find((current) => current.name === "work")!
      expect(await runtime.mutate["mcp.remove"]({ type: "mcp.remove", server: disabled.name, scope: disabled.definitionScope, expected: disabled.expected })).toEqual({ ok: true })
      const removed = await runtime.serve.mcpStatusSnapshot({ type: "mcpStatusSnapshot" })
      expect(removed.servers.map((current) => current.name)).toEqual(["other", "local"])
      const local = removed.servers.find((current) => current.name === "local")!
      expect(local).toMatchObject({ definitionScope: "project", hasGlobalFallback: true, status: "disabled" })
      expect(await runtime.mutate["mcp.remove"]({ type: "mcp.remove", server: local.name, scope: local.definitionScope, expected: local.expected })).toEqual({ ok: true })
      const fallback = await runtime.serve.mcpStatusSnapshot({ type: "mcpStatusSnapshot" })
      expect(fallback.servers.find((current) => current.name === "local")).toMatchObject({ definitionScope: "global", status: "failed", enabled: true })
      expect(mcpProtocol.rows.intro(readMcp(fallback.servers))[0]?.value).toBe("2 need attention")
      for (const snapshot of [before, after, removed, fallback]) {
        expect(Schema.decodeUnknownSync(mcpDomain.snapshot.result)(Schema.encodeSync(mcpDomain.snapshot.result)(snapshot))).toEqual(snapshot)
      }
      const patch = patches.at(-1)!
      if (patch.payload.kind !== "mcp.changed") throw new Error("Expected MCP patch")
      expect(Schema.decodeUnknownSync(mcpDomain.patch)(Schema.encodeSync(mcpDomain.patch)(patch.payload))).toEqual(patch.payload)
      for (const privateValue of ["command-secret", "env-secret", "header-secret", "https://private", "selected-private-project", "other-private-project", "hidden-secret", "private-connection-failure", "inherited-secret"]) {
        expect(JSON.stringify([before, after, removed, fallback, patches])).not.toContain(privateValue)
      }
    } finally {
      runtime.dispose()
      await service.dispose()
      await owner.dispose()
    }
  })

  test("shared actions remove definitions, not overrides, and describe retained credentials and fallback", () => {
    const global: McpStatusRow = { ...globalMetadata, name: "work", status: "needs_auth", toolCount: 0 }
    expect(mcpEnabledAction(global)).toEqual({ scope: "global", enabled: false, label: "Disable in all projects" })
    expect(mcpProjectEnabledAction(global)).toEqual({ scope: "project", enabled: false, label: "Disable in this project" })
    const overridden: McpStatusRow = { ...global, enabledScope: "project", enabled: false, status: "disabled" }
    expect(mcpEnabledAction(overridden)).toEqual({ scope: "project", enabled: true, label: "Enable in this project" })
    expect(mcpProjectEnabledAction(overridden)).toBeUndefined()
    expect(mcpRemovalConfirmation(overridden)).toEqual(mcpRemovalConfirmation(global))
    expect(mcpRemovalConfirmation(global).message).toContain("all projects")
    expect(mcpRemovalConfirmation(global).message).toContain("Full project definitions remain")
    const local: McpStatusRow = { ...overridden, definitionScope: "project", hasGlobalFallback: true }
    expect(mcpProjectEnabledAction(local)).toBeUndefined()
    expect(mcpRemovalConfirmation(local).title).toBe("Remove project server")
    expect(mcpRemovalConfirmation(local).message).toContain("inherited global definition")
    expect(mcpRemovalConfirmation(local).message).toContain("Saved credentials are kept")
    expect(mcpRemovalConfirmation({ ...local, hasGlobalFallback: false }).message).not.toContain("inherited")
  })

  test("reports saved degradation and unknown outcome without exposing raw failures", async () => {
    const manager = createMcpManager({ executionCwd: "/scratch", authDir: AUTH_DIR, servers: {} })
    const snapshot = await createRuntimeConfigOwner({ configPath: join(temporary("mcp-reply-"), "flywheel.toml"), watch: false })
    const service: McpService = {
      manager,
      ports: { servers: manager.servers, tools: manager.tools, call: manager.call },
      authentication: { authenticate: async () => {} },
      status: () => [],
      settleStartup: async () => [],
      subscribe: manager.subscribe,
      setEnabled: async () => ({ ok: true, snapshot: snapshot.snapshot(), subscriberOutcome: { kind: "committed-but-degraded", errors: ["raw-secret"] } }),
      remove: async () => ({ ok: false, kind: "write-outcome-unknown", error: new ConfigWriteError("raw-secret") }),
      dispose: () => manager.dispose(),
    }
    const { runtime } = protocolOver(manager, { service })
    try {
      expect(await runtime.mutate["mcp.setEnabled"]({ type: "mcp.setEnabled", server: "work", scope: "project", enabled: false, expected: "test" })).toEqual({ ok: true, warning: "MCP settings were saved, but connections could not fully update. Check their status." })
      expect(await runtime.mutate["mcp.remove"]({ type: "mcp.remove", server: "work", scope: "global", expected: "test" })).toEqual({ ok: false, error: "Saving could not be verified. Check MCP settings before trying again." })
    } finally {
      runtime.dispose()
      await manager.dispose()
      await snapshot.dispose()
    }
  })
})
