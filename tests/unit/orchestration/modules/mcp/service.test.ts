import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js"
import type { ModuleProcessServices } from "../../../../../src/orchestration/app-service/module-service-host.js"
import { installedConfigSchema, type FlywheelConfig } from "../../../../../src/orchestration/config/schema.js"
import { createRuntimeConfigOwner, type RuntimeConfigSnapshot } from "../../../../../src/orchestration/config/runtime-config-owner.js"
import { createMcpService } from "../../../../../src/orchestration/modules/mcp/service.js"
import { testDirectories, temporaryDirectories } from "../../../../helpers/directories.js"
import { refusingLauncher } from "../../../../helpers/launcher-fake.js"
import { moduleProcessServices } from "../../../../helpers/module-kernel.js"
import { fakeConnection } from "./_manager-fixtures.js"
import type { McpConnection } from "../../../../../src/orchestration/modules/mcp/connection.js"
import { McpNeedsAuthError } from "../../../../../src/orchestration/modules/mcp/errors.js"

const directories = { ...testDirectories(process.cwd()), executionCwd: process.cwd() }
const temporary = temporaryDirectories()

/** A configuration authority the test edits by hand: every subscriber sees the next snapshot. */
function configOver(initial: FlywheelConfig) {
  let config = initial
  let revision = 0
  const subscribers = new Set<(snapshot: RuntimeConfigSnapshot) => void | Promise<void>>()
  const snapshot = (): RuntimeConfigSnapshot => ({ revision, config, warnings: [], diagnostics: [], sourceIdentity: "test", status: { kind: "valid" } })
  const owner: ModuleProcessServices["config"] = {
    snapshot,
    subscribe: (_setting, subscriber) => { subscribers.add(subscriber); return async () => { subscribers.delete(subscriber) } },
    mutateSection: async () => { throw new Error("manual publication fixture does not mutate") },
  }
  return {
    owner,
    snapshot,
    subscriberCount: () => subscribers.size,
    async publish(next: FlywheelConfig): Promise<void> {
      config = next
      revision += 1
      await Promise.all([...subscribers].map((subscriber) => subscriber(snapshot())))
    },
  }
}

const launcher: LauncherScope = { ...refusingLauncher, spawnOwned: () => { throw new Error("no server starts in this test") } }

function decode(raw: unknown): FlywheelConfig {
  return Schema.decodeUnknownSync(installedConfigSchema())(raw)
}

function servicesFor(config: ModuleProcessServices["config"], projectRoot: string, selection: Pick<ModuleProcessServices, "enabled" | "onSelectionChanged"> = { enabled: () => true, onSelectionChanged: () => () => {} }): ModuleProcessServices {
  return moduleProcessServices({ directories: { ...directories, projectRoot, executionCwd: "/scratch/shared" }, config, launcher, ...selection })
}

describe("the MCP service", () => {
  test("selects private definitions by canonical project root, not execution directory", async () => {
    const config = configOver(decode({ mcp: {
      servers: { global: { command: "global", enabled: false } },
      projects: { "/scratch/a": { servers: { local: { command: "local", enabled: false }, global: { enabled: false } } } },
    } }))
    const open = (projectRoot: string) => createMcpService(servicesFor(config.owner, projectRoot))
    const a = open("/scratch/a")
    const b = open("/scratch/b")
    try {
      expect(a.manager.status().map((row) => row.name)).toEqual(["global", "local"])
      expect(b.manager.status()).toEqual([{ name: "global", status: "disabled", toolCount: 0 }])
      await config.publish(decode({ mcp: {
        servers: { global: { command: "global", enabled: false } },
        projects: { "/scratch/a": { servers: { local: { command: "local", enabled: false }, global: { enabled: false } } } },
      } }))
      expect(a.manager.status().every((row) => row.status === "disabled")).toBe(true)
      expect(b.manager.status()).toEqual([{ name: "global", status: "disabled", toolCount: 0 }])
    } finally {
      await Promise.all([a.dispose(), b.dispose()])
    }
  })

  test("publishes metadata-only choices, isolates tools and preserves full project definitions", async () => {
    const configPath = join(temporary("mcp-service-"), "flywheel.toml")
    writeFileSync(configPath, '[mcp.servers.work]\ncommand = "server"\n[mcp.projects."/scratch/c".servers.work]\ncommand = "private"\n')
    const owner = await createRuntimeConfigOwner({ configPath, watch: false })
    const connect = async (): Promise<McpConnection> => ({
      ...fakeConnection(),
      tools: () => [{ server: "work", name: "search", description: "", inputSchema: {}, annotations: {} }],
    })
    const a = createMcpService(servicesFor(owner, "/scratch/a"), { connect })
    const b = createMcpService(servicesFor(owner, "/scratch/b"), { connect })
    const c = createMcpService(servicesFor(owner, "/scratch/c"), { connect })
    const observations: ReturnType<typeof a.status>[] = []
    a.subscribe(() => observations.push(a.status()))
    try {
      await Promise.all([a.manager.acquire("work"), b.manager.acquire("work"), c.manager.acquire("work")])
      const first = a.status()[0]!
      const beforeTools = b.ports.tools()
      expect((await a.setEnabled({ server: "work", scope: "project", enabled: true, expected: first.expected })).ok).toBe(true)
      expect(a.status()[0]).toMatchObject({ definitionScope: "global", enabledScope: "project", status: "ready" })
      expect(observations.at(-1)?.[0]?.enabledScope).toBe("project")
      expect(b.status()[0]?.enabledScope).toBe("global")
      expect((await a.setEnabled({ server: "work", scope: "project", enabled: false, expected: a.status()[0]!.expected })).ok).toBe(true)
      expect(a.ports.tools()).toEqual([])
      expect(a.status()[0]).toMatchObject({ status: "disabled", enabled: false })
      expect(b.ports.tools()).toEqual(beforeTools)
      expect(b.status()[0]?.status).toBe("ready")
      expect((await a.remove({ server: "work", scope: "global", expected: a.status()[0]!.expected })).ok).toBe(true)
      expect(a.status()).toEqual([])
      expect(b.status()).toEqual([])
      expect(c.status()[0]).toMatchObject({ definitionScope: "project", status: "ready", hasGlobalFallback: false })
      expect(c.ports.tools()).toHaveLength(1)
    } finally {
      await Promise.all([a.dispose(), b.dispose(), c.dispose()])
      await owner.dispose()
    }
  })

  test("holds coherent applied source through queued warmup and selection changes", async () => {
    const config = configOver(decode({ mcp: { servers: { work: { command: "old" } } } }))
    let enabled = true
    let selectionChanged = (): void | Promise<void> => {}
    const selection: Pick<ModuleProcessServices, "enabled" | "onSelectionChanged"> = {
      enabled: () => enabled,
      onSelectionChanged: (listener) => { selectionChanged = listener; return () => {} },
    }
    const opened = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<McpConnection>()
    const service = createMcpService(servicesFor(config.owner, "/scratch/a", selection), {
      connect: async ({ config: server }) => {
        if (server.command === "next") { opened.resolve(); return gate.promise }
        return fakeConnection()
      },
    })
    const observations: ReturnType<typeof service.status>[] = []
    service.subscribe(() => observations.push(service.status()))
    try {
      await service.manager.acquire("work")
      const before = service.status()
      observations.length = 0
      const first = config.publish(decode({ mcp: {
        servers: { work: { command: "next" } },
        projects: { "/scratch/a": { servers: { work: { enabled: true } } } },
      } }))
      await opened.promise
      const second = config.publish(decode({ mcp: { servers: { work: { command: "later" } } } }))
      enabled = false
      const off = selectionChanged()
      expect(service.status()).toBe(before)
      expect(observations).toEqual([])
      gate.resolve(fakeConnection())
      await Promise.all([first, second, off])
      expect(observations.map((rows) => rows[0]?.enabledScope)).toEqual(["project", "global", undefined])
      expect(service.status()).toEqual([])
      expect(service.ports.tools()).toEqual([])
    } finally {
      gate.resolve(fakeConnection())
      await service.dispose()
    }
  })

  test("does not invent healthy rows or candidate scope after failed retirement", async () => {
    const config = configOver(decode({ mcp: { servers: { work: { command: "old" } } } }))
    const service = createMcpService(servicesFor(config.owner, "/scratch/a"), {
      connect: async ({ config: server }) => ({
        ...fakeConnection(),
        close: async () => { if (server.command === "old") throw new Error("retirement refused") },
      }),
    })
    try {
      await service.manager.acquire("work")
      await expect(config.publish(decode({ mcp: {
        servers: { work: { command: "next" } },
        projects: { "/scratch/a": { servers: { work: { enabled: true } } } },
      } }))).rejects.toThrow("disposal")
      expect(service.status().map(({ name, status, toolCount }) => ({ name, status, toolCount }))).toEqual([...service.manager.status()])
      expect(service.status().every((row) => row.enabledScope === "global")).toBe(true)
      expect(service.status().some((row) => row.status === "ready")).toBe(false)
    } finally {
      await expect(service.dispose()).rejects.toThrow("disposal")
    }
  })

  test("follows the [mcp] section and disconnects every server while the module is off", async () => {
    const config = configOver(decode({ mcp: { servers: { alpha: { url: "https://alpha.example", enabled: false } } } }))
    let enabled = true
    const selectionListeners = new Set<() => void | Promise<void>>()
    const onSelectionChanged: ModuleProcessServices["onSelectionChanged"] = (listener) => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } }
    const service = createMcpService(moduleProcessServices({ directories, config: config.owner, enabled: () => enabled, onSelectionChanged, launcher }))
    try {
      expect(service.manager.status().map((row) => row.name)).toEqual(["alpha"])

      await config.publish(decode({ mcp: { servers: { alpha: { url: "https://alpha.example", enabled: false }, beta: { url: "https://beta.example", enabled: false } } } }))
      expect(service.manager.status().map((row) => row.name)).toEqual(["alpha", "beta"])

      enabled = false
      await Promise.all([...selectionListeners].map((listener) => listener()))
      expect(service.manager.status()).toEqual([])

      enabled = true
      await Promise.all([...selectionListeners].map((listener) => listener()))
      expect(service.manager.status().map((row) => row.name)).toEqual(["alpha", "beta"])
    } finally {
      await service.dispose()
      expect(selectionListeners.size).toBe(0)
      expect(config.subscriberCount()).toBe(0)
    }
  })

  test("settles startup once every first connection settles and names each server a person must repair", async () => {
    const config = configOver(decode({ mcp: {
      servers: { ok: { command: "ok" }, login: { url: "https://login.example" }, broken: { command: "broken" } },
      projects: { "/scratch/a": { servers: { private: { url: "https://private.example" } } } },
    } }))
    const service = createMcpService(servicesFor(config.owner, "/scratch/a"), {
      connect: async ({ server }) => {
        if (server === "ok") return fakeConnection()
        if (server === "broken") throw new Error("spawn refused")
        throw new McpNeedsAuthError(server)
      },
    })
    try {
      expect(await service.settleStartup()).toEqual([
        "MCP server 'login' needs authentication. Run `flywheel mcp login login` to sign in.",
        "MCP server 'broken' failed to connect. Run `flywheel mcp status` to inspect it.",
        "MCP server 'private' needs authentication. Run `flywheel mcp login private --local` to sign in.",
      ])
      expect(service.status().find((row) => row.name === "ok")?.status).toBe("ready")
    } finally {
      await service.dispose()
    }
  })
})
