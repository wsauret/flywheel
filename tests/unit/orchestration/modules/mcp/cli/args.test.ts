import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseMcpArgs } from "../../../../../../src/orchestration/modules/mcp/cli/args.js"
import { runMcp } from "../../../../../../src/orchestration/modules/mcp/cli/mcp.js"
import { canonicalTestDirectory, temporaryDirectories, testDirectories } from "../../../../../helpers/directories.js"
import type { McpManager } from "../../../../../../src/orchestration/modules/mcp/manager.js"
import type { McpCredential, McpCredentialStore } from "../../../../../../src/orchestration/modules/mcp/credentials.js"
import { Redacted } from "effect"

const temporaryDirectory = temporaryDirectories()
const originalLog = console.log
const originalError = console.error
const originalExitCode = process.exitCode
let lines: string[] = []
let errorLines: string[] = []

beforeEach(() => {
  lines = []
  errorLines = []
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
  console.error = (...args: unknown[]) => errorLines.push(args.map(String).join(" "))
  process.exitCode = 0
})

afterEach(() => {
  console.log = originalLog
  console.error = originalError
  process.exitCode = originalExitCode ?? 0
})

describe("MCP CLI arguments", () => {
  test("local scope supports every command and preserves child options", () => {
    expect(parseMcpArgs(["list", "--local"])).toEqual({ kind: "status", local: true })
    expect(parseMcpArgs(["remove", "--local", "work"])).toEqual({ kind: "remove", name: "work", local: true })
    expect(parseMcpArgs(["import", "--local", "file.json"])).toEqual({ kind: "import", path: "file.json", local: true })
    expect(parseMcpArgs(["login", "work", "--local"])).toEqual({ kind: "login", name: "work", askClientSecret: false, local: true })
    expect(parseMcpArgs(["add", "work", "--local", "--", "cmd", "--local"])).toEqual({ kind: "add", local: true, spec: { name: "work", server: { command: "cmd", args: ["--local"], env: {} }, askClientSecret: false } })
    expect(parseMcpArgs(["remove", "work", "--unknown"]).kind).toBe("error")
  })
  test("parses interleaved options, repeated values, and options after --", () => {
    expect(parseMcpArgs(["add", "work", "--header", "X-A: 1", "--url", "https://mcp.example", "--header", "X-B: 2"])).toEqual({
      kind: "add",
      spec: { name: "work", server: { url: "https://mcp.example", headers: { "X-A": "1", "X-B": "2" } }, askClientSecret: false },
    })
    expect(parseMcpArgs(["add", "local", "--", "cmd", "--url", "https://kept-as-arg"])).toEqual({
      kind: "add",
      spec: { name: "local", server: { command: "cmd", args: ["--url", "https://kept-as-arg"], env: {} }, askClientSecret: false },
    })
    expect(parseMcpArgs(["add", "local", "--"]).kind).toBe("error")
  })

  test("accepts the vendor-published add shapes", () => {
    expect(parseMcpArgs(["add", "--transport", "http", "linear-server", "https://mcp.linear.app/mcp"])).toEqual({
      kind: "add",
      spec: { name: "linear-server", server: { url: "https://mcp.linear.app/mcp", headers: {} }, askClientSecret: false },
    })
    expect(parseMcpArgs(["add", "--scope", "user", "--header", "X-Key: v", "--transport", "http", "context7", "https://mcp.context7.com/mcp"])).toEqual({
      kind: "add",
      spec: { name: "context7", server: { url: "https://mcp.context7.com/mcp", headers: { "X-Key": "v" } }, askClientSecret: false },
    })
    expect(parseMcpArgs(["add", "--scope", "user", "context7", "--", "npx", "-y", "@upstash/context7-mcp", "--api-key", "KEY"])).toEqual({
      kind: "add",
      spec: { name: "context7", server: { command: "npx", args: ["-y", "@upstash/context7-mcp", "--api-key", "KEY"], env: {} }, askClientSecret: false },
    })
    expect(parseMcpArgs(["add", "--transport", "sse", "old", "https://mcp.example"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "name", "https://a.example", "--url", "https://b.example"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "name", "https://a.example", "extra"]).kind).toBe("error")
  })

  test("parses a pre-registered OAuth client in the vendor-published flag shape", () => {
    expect(parseMcpArgs(["add", "--transport", "http", "--client-id", "123.456", "--client-secret", "--callback-port", "3118", "slack", "https://mcp.slack.com/mcp"])).toEqual({
      kind: "add",
      spec: { name: "slack", server: { url: "https://mcp.slack.com/mcp", headers: {}, oauth: { client_id: "123.456", callback_port: 3118 } }, askClientSecret: true },
    })
    expect(parseMcpArgs(["login", "slack", "--client-secret"])).toEqual({ kind: "login", name: "slack", askClientSecret: true })
    expect(parseMcpArgs(["login", "slack"])).toEqual({ kind: "login", name: "slack", askClientSecret: false })
    expect(parseMcpArgs(["add", "slack", "https://a", "--client-secret"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "slack", "https://a", "--callback-port", "0"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "local", "--client-id", "x", "--", "cmd"]).kind).toBe("error")
    expect(parseMcpArgs(["login", "slack", "--bogus"]).kind).toBe("error")
  })

  test("rejects malformed add invocations", () => {
    expect(parseMcpArgs(["add"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "--url", "https://mcp.example"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "name"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "name", "--url", "https://a", "--", "cmd"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "name", "--url", "https://a", "--env", "K=V"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "name", "--header", "Bad-Header", "--", "cmd"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "name", "--env", "NOEQUALS", "--", "cmd"]).kind).toBe("error")
    expect(parseMcpArgs(["add", "name", "--bogus", "x", "--url", "https://a"]).kind).toBe("error")
  })

  test("rejects missing and extra arguments", () => {
    expect(parseMcpArgs(["login"]).kind).toBe("error")
    expect(parseMcpArgs(["status", "extra"]).kind).toBe("error")
    expect(parseMcpArgs(["unknown"]).kind).toBe("error")
  })

  test("status lists every configured server state", async () => {
    const dir = temporaryDirectory("flywheel-mcp-status-")
    const config = join(dir, "flywheel.toml")
    await writeFile(config, '[mcp.servers.alpha]\ncommand = "alpha"\nenabled = false\n\n[mcp.servers.beta]\nurl = "https://mcp.example"\nenabled = false\n')

    await runMcp(["status"], testDirectories(dir), { configPath: config })

    expect(lines).toEqual(["alpha [global]: disabled", "beta [global]: disabled"])
    expect(process.exitCode).toBe(0)
  })

  test("local listing and login select project definitions without changing global login", async () => {
    const dir = temporaryDirectory("flywheel-mcp-local-login-")
    const directories = testDirectories(dir)
    const config = join(dir, "flywheel.toml")
    await writeFile(config, `mcp = { servers.work = { url = "https://global.example", enabled = false }, projects.${JSON.stringify(directories.projectRoot)}.servers = { work = { url = "https://project.example", enabled = false }, extra = { command = "extra", enabled = false } } }\n`)
    await runMcp(["list", "--local"], directories, { configPath: config })
    expect(lines).toEqual(["work [project]: disabled", "extra [project]: disabled"])
    const observed: string[] = []
    const createManager: typeof import("../../../../../../src/orchestration/modules/mcp/manager.js").createMcpManager = (options) => {
      observed.push(options.servers.work?.url ?? "")
      return { ...emptyManager, authorize: async () => ({ url: "https://identity.example", redirectUrl: "http://127.0.0.1/callback", complete: async () => {}, close: async () => {} }) }
    }
    await runMcp(["login", "work"], directories, { configPath: config, createManager })
    await runMcp(["login", "--local", "work"], directories, { configPath: config, createManager })
    expect(observed).toEqual(["https://global.example", "https://project.example"])
  })

  test("unknown login fails with the configured server names", async () => {
    const dir = temporaryDirectory("flywheel-mcp-unknown-")
    const config = join(dir, "flywheel.toml")
    await writeFile(config, '[mcp.servers.zeta]\nurl = "https://zeta.example"\nenabled = false\n\n[mcp.servers.alpha]\nurl = "https://alpha.example"\nenabled = false\n')

    await runMcp(["login", "missing"], testDirectories(dir), { configPath: config })

    expect(errorLines).toEqual(["MCP command failed: MCP server not found: missing. Configured servers: alpha, zeta"])
    expect(process.exitCode).toBe(1)
  })

  test("standalone login persists before explaining that a running TUI is not refreshed", async () => {
    const dir = temporaryDirectory("flywheel-mcp-login-")
    const config = join(dir, "flywheel.toml")
    await writeFile(config, '[mcp.servers.work]\nurl = "https://mcp.example"\nenabled = false\n')
    const order: string[] = []
    const manager: McpManager = {
      ...emptyManager,
      servers: () => ["work"],
      credentialUpdated: async (server) => { order.push(`persisted:${server}`) },
      authorize: async () => ({
        url: "https://identity.example/authorize",
        redirectUrl: "http://127.0.0.1/callback",
        complete: async () => { order.push("callback-complete") },
        close: async () => { order.push("closed") },
      }),
      status: () => [],
      subscribe: () => () => {},
      dispose: async () => { order.push("disposed") },
    }

    await runMcp(["login", "work"], testDirectories(dir), {
      configPath: config,
      createManager: () => manager,
      openBrowser: async (url) => { order.push(`opened:${url}`); return true },
    })

    expect(order).toEqual([
      "opened:https://identity.example/authorize",
      "callback-complete",
      "persisted:work",
      "closed",
      "disposed",
    ])
    expect(lines.at(-1)).toContain("authenticated")
    expect(lines.at(-1)).toContain("A separately running Flywheel TUI does not live-refresh")
    expect(process.exitCode).toBe(0)
  })

  test("add writes the client to flywheel.toml and its secret only to the credential store", async () => {
    const dir = temporaryDirectory("flywheel-mcp-client-")
    const config = join(dir, "flywheel.toml")
    await writeFile(config, "")
    const store = memoryCredentialStore()
    const questions: string[] = []

    await runMcp(["add", "slack", "https://mcp.slack.com/mcp", "--client-id", "123.456", "--client-secret", "--callback-port", "3118"], testDirectories(dir), {
      configPath: config,
      credentialStore: store,
      prompt: async (question) => { questions.push(question); return " client-secret \n" },
    })

    const text = await readFile(config, "utf8")
    expect(Bun.TOML.parse(text)).toMatchObject({ mcp: { servers: { slack: { oauth: { client_id: "123.456", callback_port: 3118 } } } } })
    expect(text).not.toContain("client-secret")
    expect(questions).toHaveLength(1)
    expect(Redacted.value(store.saved("slack", "https://mcp.slack.com/mcp")?.clientSecret ?? Redacted.make(""))).toBe("client-secret")
    expect(process.exitCode).toBe(0)
  })

  test("login stores a new client secret before it authorizes", async () => {
    const dir = temporaryDirectory("flywheel-mcp-client-login-")
    const config = join(dir, "flywheel.toml")
    await writeFile(config, '[mcp.servers.slack]\nurl = "https://mcp.slack.com/mcp"\noauth.client_id = "123.456"\n')
    const store = memoryCredentialStore()
    let secretAtAuthorize: string | undefined

    await runMcp(["login", "slack", "--client-secret"], testDirectories(dir), {
      configPath: config,
      credentialStore: store,
      prompt: async () => "client-secret",
      openBrowser: async () => true,
      createManager: () => ({
        ...emptyManager,
        authorize: async () => {
          const secret = store.saved("slack", "https://mcp.slack.com/mcp")?.clientSecret
          secretAtAuthorize = secret === undefined ? undefined : Redacted.value(secret)
          return { url: "https://identity.example/authorize", redirectUrl: "http://127.0.0.1/callback", complete: async () => {}, close: async () => {} }
        },
      }),
    })

    expect(secretAtAuthorize).toBe("client-secret")
    expect(process.exitCode).toBe(0)
  })

  // MCP servers run in the session's execution directory the startup
  // boundary selected, which is not the directory this process happens to
  // start in (ARCH-DIRECTORIES-007).
  test("runs MCP servers in the startup execution directory, not the process directory", async () => {
    const projectRoot = canonicalTestDirectory(temporaryDirectory("flywheel-mcp-project-"))
    const executionCwd = canonicalTestDirectory(temporaryDirectory("flywheel-mcp-exec-"))
    const config = join(projectRoot, "flywheel.toml")
    await writeFile(config, '[mcp.servers.alpha]\ncommand = "alpha"\nenabled = false\n')
    let observedExecutionCwd: string | undefined

    await runMcp(["status"], testDirectories(projectRoot, executionCwd), {
      configPath: config,
      createManager: (options) => {
        observedExecutionCwd = options.executionCwd
        return { ...emptyManager, status: () => [] }
      },
    })

    expect(observedExecutionCwd).toBe(executionCwd)
  })
})

function memoryCredentialStore(): McpCredentialStore & { saved(server: string, url: string): McpCredential | undefined } {
  const credentials = new Map<string, McpCredential>()
  return {
    get: (server, url) => credentials.get(`${server} ${url}`),
    save: async (server, url, credential) => { credentials.set(`${server} ${url}`, credential) },
    delete: async (server, url) => { credentials.delete(`${server} ${url}`) },
    saved: (server, url) => credentials.get(`${server} ${url}`),
  }
}

const emptyManager: McpManager = {
  servers: () => [],
  entries: () => [],
  acquire: async () => { throw new Error("not used") },
  tools: () => [],
  call: async () => { throw new Error("not used") },
  replaceServers: async () => {},
  credentialUpdated: async () => {},
  authorize: async () => { throw new Error("not used") },
  status: () => [],
  subscribe: () => () => {},
  dispose: async () => {},
}
