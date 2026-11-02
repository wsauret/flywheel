import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { runMcp } from "../../../../../../src/orchestration/modules/mcp/cli/mcp.js"
import { accountAuthDir } from "../../../../../../src/infra/paths.js"
import { temporaryDirectories, testDirectories } from "../../../../../helpers/directories.js"
import { Redacted, Schema } from "effect"
import { McpConfigSchema } from "../../../../../../src/orchestration/modules/mcp/config.js"
import type { McpCredential, McpCredentialStore } from "../../../../../../src/orchestration/modules/mcp/credentials.js"

const temporaryDirectory = temporaryDirectories()
const originalError = console.error
const originalExitCode = process.exitCode
let errorLines: string[] = []

beforeEach(() => {
  errorLines = []
  console.error = (...args: unknown[]) => errorLines.push(args.map(String).join(" "))
})

afterEach(() => {
  console.error = originalError
  process.exitCode = originalExitCode ?? 0
})

async function writeConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

function parsedMcp(text: string) {
  return Schema.decodeUnknownSync(Schema.Struct({ mcp: McpConfigSchema }))(Bun.TOML.parse(text)).mcp
}

describe("MCP import", () => {
  test("private project setup shadows globals and confirmed removal restores inheritance", async () => {
    const dir = temporaryDirectory("flywheel-mcp-scoped-")
    const config = join(dir, "flywheel.toml")
    const directories = testDirectories(dir, temporaryDirectory("flywheel-mcp-execution-"))
    const original = '# keep\n[mcp.servers.work]\ncommand = "global"\nenabled = false\n'
    await writeConfig(config, original)
    await runMcp(["add", "work", "--local", "--", "project"], directories, { configPath: config })
    const added = await readFile(config, "utf8")
    expect(parsedMcp(added)).toMatchObject({ servers: { work: { command: "global" } }, projects: { [directories.projectRoot]: { servers: { work: { command: "project" } } } } })
    const questions: string[] = []
    await runMcp(["remove", "work", "--local"], directories, { configPath: config, prompt: async (question) => { questions.push(question); return "" } })
    expect(await readFile(config, "utf8")).toBe(added)
    await runMcp(["remove", "work", "--local"], directories, { configPath: config, prompt: async (question) => { questions.push(question); return "yes" } })
    expect(questions.join("\n")).toContain("inherited global")
    expect(questions.join("\n")).toContain("credentials")
    expect(parsedMcp(await readFile(config, "utf8"))).toMatchObject({ servers: { work: { command: "global" } } })
  })

  test("removal compares the reviewed state after confirmation and global impact is disclosed", async () => {
    const dir = temporaryDirectory("flywheel-mcp-remove-stale-")
    const config = join(dir, "flywheel.toml")
    const original = '[mcp.servers.work]\ncommand = "global"\n'
    const changed = original.replace('"global"', '"changed"')
    await writeConfig(config, original)
    let question = ""
    await runMcp(["remove", "work"], testDirectories(dir), { configPath: config, prompt: async (copy) => { question = copy; await writeFile(config, changed); return "y" } })
    expect(question).toContain("all projects")
    expect(await readFile(config, "utf8")).toBe(changed)
    expect(process.exitCode).toBe(1)
  })

  test("local import is atomic and global removal keeps credentials and full project definitions", async () => {
    const dir = temporaryDirectory("flywheel-mcp-local-import-")
    const directories = testDirectories(dir)
    const config = join(dir, "flywheel.toml")
    const source = join(dir, "servers.json")
    const original = `# private\nmcp = { servers.work = { url = "https://mcp.example" }, projects.${JSON.stringify(directories.projectRoot)}.servers.work = { enabled = false } }\n`
    await writeConfig(config, original)
    await writeFile(source, JSON.stringify({ mcpServers: { extra: { command: "extra" }, work: { url: "https://other.example" } } }))
    await runMcp(["import", source, "--local"], directories, { configPath: config })
    expect(await readFile(config, "utf8")).toBe(original)
    process.exitCode = 0
    let overrideCopy = ""
    await runMcp(["remove", "work", "--local"], directories, { configPath: config, prompt: async (question) => { overrideCopy = question; return "yes" } })
    expect(overrideCopy).toContain("restores the inherited global enabled state")
    expect(parsedMcp(await readFile(config, "utf8")).servers.work?.url).toBe("https://mcp.example")
    expect(parsedMcp(await readFile(config, "utf8")).projects[directories.projectRoot]?.servers.work).toBeUndefined()
    const full = original.replace("{ enabled = false }", '{ url = "https://local.example", enabled = false }')
    await writeConfig(config, full)
    let deleted = false
    const credentialStore: McpCredentialStore = { get: () => ({ clientSecret: Redacted.make("retained") }), save: async () => {}, delete: async () => { deleted = true } }
    process.exitCode = 0
    await runMcp(["remove", "work"], directories, { configPath: config, prompt: async () => "yes", credentialStore })
    expect(parsedMcp(await readFile(config, "utf8"))).toMatchObject({ projects: { [directories.projectRoot]: { servers: { work: { url: "https://local.example" } } } } })
    expect(deleted).toBe(false)
    expect(process.exitCode).toBe(0)
    await writeFile(source, JSON.stringify({ mcpServers: { extra: { command: "extra" } } }))
    await runMcp(["import", source, "--local"], directories, { configPath: config })
    expect(parsedMcp(await readFile(config, "utf8"))).toMatchObject({ projects: { [directories.projectRoot]: { servers: { extra: { command: "extra" } } } } })
  })
  test("uses the account-global credential directory for manager operations", async () => {
    const dir = temporaryDirectory("flywheel-mcp-account-auth-")
    const config = join(dir, "flywheel.toml")
    const directories = testDirectories(dir)
    let credentials: string | undefined
    await writeConfig(config, "")
    await runMcp(["status"], directories, {
      configPath: config,
      createManager: (options) => {
        credentials = options.authDir
        return {
          servers: () => [],
          entries: () => [],
          tools: () => [],
          status: () => [],
          subscribe: () => () => {},
          acquire: async () => { throw new Error("unused") },
          call: async () => { throw new Error("unused") },
          authorize: async () => { throw new Error("unused") },
          credentialUpdated: async () => {},
          replaceServers: async () => {},
          dispose: async () => {},
        }
      },
    })
    expect(credentials).toBe(accountAuthDir(directories.userDataRoot))
  })

  test("imports stdio and template-backed HTTP servers while preserving unrelated TOML bytes", async () => {
    const dir = temporaryDirectory("flywheel-mcp-import-")
    const config = join(dir, "flywheel.toml")
    await writeConfig(config, "# keep\nshow_thinking = true\n")
    const source = join(dir, ".mcp.json")
    await writeFile(source, JSON.stringify({ mcpServers: {
      local: { command: "bun", args: ["server.ts"], env: { MODE: "test" } },
      work: { type: "http", url: "https://mcp.example.test", headers: { Authorization: `\${MCP_TOKEN}` } },
      slack: { type: "http", url: "https://mcp.slack.com/mcp", oauth: { clientId: "123.456", callbackPort: 3118 } },
    } }))

    await runMcp(["import", source], testDirectories(dir), { configPath: config })

    const text = await readFile(config, "utf8")
    expect(text).toStartWith("# keep\nshow_thinking = true\n")
    expect(parsedMcp(text)).toMatchObject({ servers: {
      local: { command: "bun", args: ["server.ts"], env: { MODE: "test" } },
      work: { url: "https://mcp.example.test", headers: { Authorization: `\${MCP_TOKEN}` } },
      slack: { url: "https://mcp.slack.com/mcp", oauth: { client_id: "123.456", callback_port: 3118 } },
    } })
    expect(process.exitCode).not.toBe(1)
  })

  test("preserves destination bytes for every rejected source or merged config", async () => {
    const dir = temporaryDirectory("flywheel-mcp-import-fail-")
    const config = join(dir, "flywheel.toml")
    const validOriginal = "[mcp.servers.work]\nurl = \"https://old.example\"\n"
    const cases = [
      { name: "malformed-json", source: "{not json", destination: validOriginal },
      { name: "malformed-source", source: JSON.stringify({ mcpServers: [] }), destination: validOriginal },
      { name: "invalid-merged-schema", source: JSON.stringify({ mcpServers: { other: { url: "https://new.example" } } }), destination: 'show_thinking = "yes"\n' },
      { name: "duplicate", source: JSON.stringify({ mcpServers: { work: { url: "https://new.example" } } }), destination: validOriginal },
    ] as const

    for (const item of cases) {
      const source = join(dir, `${item.name}.json`)
      await writeConfig(config, item.destination)
      await writeFile(source, item.source)
      process.exitCode = 0

      await runMcp(["import", source], testDirectories(dir), { configPath: config })

      expect(await readFile(config, "utf8"), item.name).toBe(item.destination)
      expect(process.exitCode, item.name).toBe(1)
    }
    expect(errorLines.join("\n")).not.toContain("raw-credential")
  })

  test("add writes a remote server and suggests login", async () => {
    const dir = temporaryDirectory("flywheel-mcp-add-")
    const config = join(dir, "flywheel.toml")
    await writeConfig(config, "# keep\n")
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "))
    try {
      await runMcp(["add", "linear", "--url", "https://mcp.linear.app/mcp"], testDirectories(dir), { configPath: config })
    } finally {
      console.log = originalLog
    }

    const text = await readFile(config, "utf8")
    expect(text).toStartWith("# keep\n")
    expect(parsedMcp(text)).toMatchObject({ servers: { linear: { url: "https://mcp.linear.app/mcp" } } })
    expect(logs.join("\n")).toContain("flywheel mcp login linear")
    expect(process.exitCode).not.toBe(1)
  })

  test("add writes a stdio server with args and env", async () => {
    const dir = temporaryDirectory("flywheel-mcp-add-stdio-")
    const config = join(dir, "flywheel.toml")
    await writeConfig(config, "")
    await runMcp(["add", "local", "--env", "MODE=test", "--", "npx", "-y", "mcp-remote", "https://mcp.example"], testDirectories(dir), { configPath: config })

    const text = await readFile(config, "utf8")
    expect(parsedMcp(text)).toMatchObject({ servers: { local: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.example"], env: { MODE: "test" } } } })
    expect(process.exitCode).not.toBe(1)
  })

  test("add keeps template headers in config, diverts literal secrets to the store, rejects mixed values and duplicates", async () => {
    const dir = temporaryDirectory("flywheel-mcp-add-guard-")
    const config = join(dir, "flywheel.toml")
    const stored = new Map<string, McpCredential>()
    const credentialStore: McpCredentialStore = {
      get: (server, url) => stored.get(`${server}:${url}`),
      save: async (server, url, credential) => { stored.set(`${server}:${url}`, credential) },
      delete: async (server, url) => { stored.delete(`${server}:${url}`) },
    }
    await writeConfig(config, "")
    await runMcp(["add", "work", "--url", "https://mcp.example", "--header", `Authorization: Bearer \${WORK_TOKEN}`], testDirectories(dir), { configPath: config, credentialStore })
    expect(parsedMcp(await readFile(config, "utf8"))).toMatchObject({ servers: { work: { headers: { Authorization: `Bearer \${WORK_TOKEN}` } } } })
    expect(stored.size).toBe(0)
    expect(process.exitCode).not.toBe(1)

    await runMcp(["add", "context7", "--url", "https://mcp.context7.com/mcp", "--header", "CONTEXT7_API_KEY: literal-key"], testDirectories(dir), { configPath: config, credentialStore })
    const text = await readFile(config, "utf8")
    expect(parsedMcp(text)).toMatchObject({ servers: { context7: { url: "https://mcp.context7.com/mcp" } } })
    expect(text).not.toContain("literal-key")
    const credential = stored.get("context7:https://mcp.context7.com/mcp")
    expect(credential?.headers === undefined ? undefined : Redacted.value(credential.headers.CONTEXT7_API_KEY ?? Redacted.make(""))).toBe("literal-key")
    expect(process.exitCode).not.toBe(1)

    const before = await readFile(config, "utf8")
    await runMcp(["add", "mixed", "--url", "https://mcp.example", "--header", `Authorization: Bearer leak\${TOKEN}`], testDirectories(dir), { configPath: config, credentialStore })
    expect(await readFile(config, "utf8")).toBe(before)
    expect(process.exitCode).toBe(1)
    expect(errorLines.join("\n")).not.toContain("leak$")

    process.exitCode = 0
    await runMcp(["add", "work", "--url", "https://other.example"], testDirectories(dir), { configPath: config, credentialStore })
    expect(await readFile(config, "utf8")).toBe(before)
    expect(process.exitCode).toBe(1)
  })

  test("import diverts literal sensitive headers to the credential store", async () => {
    const dir = temporaryDirectory("flywheel-mcp-import-divert-")
    const config = join(dir, "flywheel.toml")
    const stored = new Map<string, McpCredential>()
    const credentialStore: McpCredentialStore = {
      get: (server, url) => stored.get(`${server}:${url}`),
      save: async (server, url, credential) => { stored.set(`${server}:${url}`, credential) },
      delete: async (server, url) => { stored.delete(`${server}:${url}`) },
    }
    await writeConfig(config, "")
    const source = join(dir, ".mcp.json")
    await writeFile(source, JSON.stringify({ mcpServers: {
      secretive: { url: "https://mcp.example", headers: { Cookie: "raw-credential", "X-Trace": "plain" } },
    } }))

    await runMcp(["import", source], testDirectories(dir), { configPath: config, credentialStore })

    const text = await readFile(config, "utf8")
    expect(parsedMcp(text)).toMatchObject({ servers: { secretive: { headers: { "X-Trace": "plain" } } } })
    expect(text).not.toContain("raw-credential")
    const credential = stored.get("secretive:https://mcp.example")
    expect(credential?.headers === undefined ? undefined : Redacted.value(credential.headers.Cookie ?? Redacted.make(""))).toBe("raw-credential")
    expect(process.exitCode).not.toBe(1)
  })

  // The lock's liveness/staleness semantics are unit-tested in auth-lock.test.ts;
  // this test only proves the CLI propagates a lock-acquisition failure: exit
  // code 1 and an untouched config. A directory planted at the lock name is not
  // an admissible lock file and fails immediately without a retry backoff.
  test("reports failure and leaves the config untouched when the lock cannot be acquired", async () => {
    const dir = temporaryDirectory("flywheel-mcp-lock-fail-")
    const config = join(dir, "flywheel.toml")
    const original = "# unchanged\n"
    await writeConfig(config, original)
    const source = join(dir, ".mcp.json")
    await writeFile(source, JSON.stringify({ mcpServers: { work: { url: "https://mcp.example" } } }))
    await mkdir(`${config}.lock`)

    await runMcp(["import", source], testDirectories(dir), { configPath: config })

    expect(await readFile(config, "utf8")).toBe(original)
    expect(process.exitCode).toBe(1)
  })
})
