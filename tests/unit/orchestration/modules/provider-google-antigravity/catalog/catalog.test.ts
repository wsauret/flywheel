import type { FileSink } from "bun"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AuthContext } from "../../../../../../src/infra/auth/auth-context.js"
import { createAccessProviderSelection, type AccessProviderCatalogFetchInput, type AccessProviderDefinition } from "../../../../../../src/infra/llm/access/access-provider.js"
import type { CatalogDiscovery } from "../../../../../../src/infra/llm/catalog/model-catalog-resolution.js"
import { createModelListingClient } from "../../../../../../src/infra/llm/access/model-listing.js"
import { Log } from "../../../../../../src/infra/log.js"
import type { OwnedProcess, OwnedProcessExit } from "../../../../../../src/infra/owned-subprocess.js"
import type { LauncherScope } from "../../../../../../src/infra/process-supervisor.js"
import { antigravityDynamicCatalog } from "../../../../../../src/orchestration/modules/provider-google-antigravity/catalog/catalog.js"
import { sweepLogin } from "../../../../../../src/orchestration/modules/provider-google-antigravity/engine/session-files.js"
import { credentialSlotClassifier } from "../../../../../../src/orchestration/auth/credential-slot-classifier.js"
import { authProviders } from "../../../../../helpers/auth-context.js"
import { temporaryDirectories } from "../../../../../helpers/directories.js"
import { modelInfo } from "../../../../../helpers/model-tier-fixtures.js"
import { testCapabilityModules } from "../../../../../helpers/provider-authority.js"
import { AUTH_DIR, AUTH_NONE } from "../../../config/_model-listing-fixtures.js"
import { accessProviderAccountKey } from "../../../../../../src/infra/auth/provider-account.js"

const temporary = temporaryDirectories()
const providerLog = Log.create({ service: "provider-google-antigravity" })
const info = spyOn(providerLog, "info").mockImplementation(() => {})
const warn = spyOn(providerLog, "warn").mockImplementation(() => {})
afterEach(() => {
  info.mockClear()
  warn.mockClear()
})

const SESSION = "6f2c1d0e-8a4b-4c3d-9e5f-0a1b2c3d4e5f"
const SESSION_FILES = [`conversations/${SESSION}.db`, `conversations/${SESSION}.db-wal`, `conversations/${SESSION}.db-shm`, `brain/${SESSION}`, `annotations/${SESSION}.pbtxt`]

const option = (value: string, name: string) => ({ value, name })
const thoughtLevel = (values: readonly string[]) => ({ id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: values[0], options: values.map((value) => option(value, value)) })
const modelOption = (currentValue: string) => ({
  id: "model", name: "Model", category: "model", type: "select", currentValue,
  options: [
    option("gemini-3.1-pro", "Gemini 3.1 Pro"),
    option("gemini-4-neon", "Gemini 4 Neon"),
    option("gemini-3.7-flash", "Gemini 3.7 Flash"),
    option("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"),
    option("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
  ],
})
/** The `thought_level` options that agy 1.5.14 states for each family (recorded spike frames); another vendor's model
 *  has none. */
const THOUGHT_LEVELS = new Map<string, readonly string[]>([
  ["gemini-3.1-pro", ["low", "high"]],
  ["gemini-4-neon", ["low", "medium", "high", "xhigh"]],
  ["gemini-3.7-flash", ["low", "medium", "high"]],
])
const configOptions = (model: string) => {
  const levels = THOUGHT_LEVELS.get(model)
  return [modelOption(model), ...(levels === undefined ? [] : [thoughtLevel(levels)])]
}

/** One JSON-RPC request that the fake engine reads, and the answer that it writes. */
interface Frame {
  readonly id: number
  readonly method: string
  readonly params: { readonly value?: string; readonly configId?: string; readonly clientInfo?: unknown }
}
interface Answer {
  readonly result?: object
  readonly error?: { readonly code: number; readonly message: string }
}

interface FakeEngineOptions {
  /** Replaces the `session/new` answer. */
  readonly newSession?: () => Answer | Promise<Answer>
  /** Replaces the `session/set_config_option` answer. */
  readonly setConfig?: (frame: Frame) => Answer | Promise<Answer>
  /** What `agy --version` prints. */
  readonly version?: string
  /** False for an engine that never exits by itself; the scope's close then answers `closeSettled`. */
  readonly exits?: boolean
  readonly closeSettled?: boolean
}

const exitOf = (code: number): OwnedProcessExit => ({ code, signal: null, statusOf: "payload", ownership: "surrendered" })
const closedStream = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })

/** A fake `agy` for one listing: `--version` prints its version, and `acp` answers from recorded frames, makes the
 *  files that agy makes for a new session, and exits when its input ends, as agy does. */
function fakeEngine(loginDir: string, options: FakeEngineOptions = {}) {
  const frames: Frame[] = []
  const terminations: unknown[] = []
  const commands: string[][] = []
  const encoder = new TextEncoder()
  const engineData = join(loginDir, "home", ".gemini", "antigravity-cli")
  const make = (path: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "")
  }
  const makeSessionFiles = () => {
    for (const file of SESSION_FILES) make(join(engineData, file === `brain/${SESSION}` ? `${file}/.system_generated/steps` : file))
  }
  const answer = (frame: Frame): Answer | Promise<Answer> => {
    switch (frame.method) {
      case "initialize":
        return { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" } } }
      case "session/new":
        if (options.newSession !== undefined) return options.newSession()
        makeSessionFiles()
        return opened
      case "session/set_config_option":
        return options.setConfig?.(frame) ?? { result: { configOptions: configOptions(frame.params.value ?? "") } }
      default:
        return { error: { code: -32601, message: `the fake engine does not answer ${frame.method}` } }
    }
  }
  const versionProcess = (): OwnedProcess => ({
    pid: 2,
    token: "version",
    stdin: undefined,
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(encoder.encode(`${options.version ?? "1.5.14"}\n`)); controller.close() } }),
    stderr: closedStream(),
    exited: Promise.resolve(exitOf(0)),
    terminate: async () => exitOf(0),
  })
  let launch: { readonly command: readonly string[]; readonly cwd: string | undefined } | undefined
  const scopes: { readonly priority: string | undefined }[] = []
  const launcher: LauncherScope = {
    spawnOwned: async (command, spawnOptions) => {
      commands.push([...command])
      if (command[1] === "--version") return versionProcess()
      launch = { command, cwd: spawnOptions?.cwd }
      const logFile = command[command.indexOf("--log-file") + 1] ?? ""
      make(logFile)
      writeFileSync(logFile, "I composite_token_storage.go:176] Using file-based token storage because no D-Bus session bus detected\n")
      let stdout!: ReadableStreamDefaultController<Uint8Array>
      const exit = Promise.withResolvers<OwnedProcessExit>()
      const reply = (frame: Frame) => Promise.resolve(answer(frame)).then((answered) => stdout.enqueue(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...answered })}\n`)))
      const stdin: FileSink = {
        write: (chunk) => {
          const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
          for (const line of text.split("\n").filter(Boolean)) {
            const frame: Frame = JSON.parse(line)
            frames.push(frame)
            void reply(frame)
          }
          return text.length
        },
        flush: () => 0,
        end: () => {
          if (options.exits !== false) exit.resolve(exitOf(0))
          return 0
        },
        start: () => {},
        ref: () => {},
        unref: () => {},
      }
      return {
        pid: 1,
        token: "listing",
        stdin,
        stdout: new ReadableStream<Uint8Array>({ start: (controller) => { stdout = controller } }),
        stderr: closedStream(),
        exited: exit.promise,
        terminate: async (end) => {
          terminations.push(end)
          return exitOf(0)
        },
      }
    },
    adoptOwned: () => Promise.reject(new Error("the listing adopts nothing")),
    open: (policy) => {
      scopes.push({ priority: policy?.priority })
      return launcher
    },
    close: async () => options.closeSettled === false ? { settled: false, reason: "the engine did not end" } : { settled: true },
  }
  const sessionFilesLeft = () => SESSION_FILES.filter((file) => existsSync(join(engineData, file)))
  const records = () => existsSync(join(loginDir, "processes")) ? readdirSync(join(loginDir, "processes")) : []
  return { launcher, makeSessionFiles, frames, terminations, commands, scopes, sessionFilesLeft, records, launch: () => launch }
}

function fetchInput(loginDir: string, launcher: LauncherScope): AccessProviderCatalogFetchInput {
  mkdirSync(loginDir, { recursive: true })
  return {
    credential: { type: "external", configDir: loginDir },
    authDir: AUTH_DIR,
    classifySlot: () => "subscription",
    oauthPersistence: "access-only",
    launcher,
    signal: new AbortController().signal,
  }
}

const opened: Answer = { result: { sessionId: SESSION, configOptions: configOptions("gemini-3.1-pro") } }

const SEAMS = { enginePath: "/engine/agy", platform: "linux" } as const

describe("the Google Antigravity catalog", () => {
  test("lists one row per qualified Gemini family from a short-lived engine's options, and never a model of another vendor", async () => {
    const loginDir = join(temporary("antigravity-catalog-"), "login")
    const engine = fakeEngine(loginDir)
    const catalog = antigravityDynamicCatalog(SEAMS)

    const { discovery } = await catalog.fetch!(fetchInput(loginDir, engine.launcher))

    if (discovery.kind !== "rows") throw new Error(`the listing failed: ${JSON.stringify(discovery)}`)
    const rows = discovery.rows.map((row) => catalog.canonicalize(row))
    expect(rows.map((row) => [row?.modelId, row?.wireModelId, row?.resolvedMetadata?.reasoningEfforts])).toEqual([
      ["gemini-3.1-pro-preview", "gemini-3.1-pro", ["low", "high"]],
      ["gemini-4-neon", "gemini-4-neon", ["low", "medium", "high", "xhigh"]],
    ])
    // Each offered family that is not selected is selected once to read its thought levels; nothing is prompted, and
    // no other vendor's model or unqualified family is ever selected.
    expect(engine.frames.map(({ method, params }) => method === "session/set_config_option" ? `${method} ${String(params.configId)}=${String(params.value)}` : method)).toEqual([
      "initialize", "session/new", "session/set_config_option model=gemini-4-neon",
    ])
    expect(engine.frames[0]?.params.clientInfo).toMatchObject({ name: "flywheel" })
    // The engine's version is qualified before `agy acp` starts.
    expect(engine.commands.map((command) => command.slice(0, 2))).toEqual([["/engine/agy", "--version"], ["/engine/agy", "acp"]])
    expect(engine.launch()?.command.slice(0, 4)).toEqual(["/engine/agy", "acp", "--agent", "flywheel"])
    expect(engine.launch()?.cwd).toBe(join(loginDir, "workspace"))
    expect(engine.scopes).toEqual([{ priority: "background" }])
    // 3.7 Flash has no qualified context window.
    expect(info.mock.calls.filter(([message]) => String(message).includes("not offered"))).toEqual([[expect.any(String), { family: "gemini-3.7-flash" }]])
  })

  test("waits for the engine to exit on its closed input, ends nothing, and removes the listing session's files, record, and log", async () => {
    const loginDir = join(temporary("antigravity-catalog-"), "login")
    const engine = fakeEngine(loginDir)

    await antigravityDynamicCatalog(SEAMS).fetch!(fetchInput(loginDir, engine.launcher))

    expect(engine.terminations).toEqual([])
    expect(engine.sessionFilesLeft()).toEqual([])
    expect(engine.records()).toEqual([])
    const logFile = engine.launch()?.command[(engine.launch()?.command.indexOf("--log-file") ?? 0) + 1] ?? ""
    expect(logFile.startsWith(join(loginDir, "logs"))).toBe(true)
    expect(existsSync(logFile)).toBe(false)
  })

  test("a sweep of the login while the listing opens its session keeps the files that the session already has", async () => {
    const loginDir = join(temporary("antigravity-catalog-"), "login")
    const pending = Promise.withResolvers<Answer>()
    const asked = Promise.withResolvers<void>()
    const engine = fakeEngine(loginDir, {
      newSession: () => {
        engine.makeSessionFiles()
        asked.resolve()
        return pending.promise
      },
    })

    const listing = antigravityDynamicCatalog(SEAMS).fetch!(fetchInput(loginDir, engine.launcher))
    await asked.promise
    sweepLogin(loginDir)
    expect(engine.sessionFilesLeft()).toEqual(SESSION_FILES)
    pending.resolve(opened)

    expect((await listing).discovery.kind).toBe("rows")
    expect(engine.sessionFilesLeft()).toEqual([])
  })

  test("a sweep of the login while the listing reads options keeps the listing session's files", async () => {
    const loginDir = join(temporary("antigravity-catalog-"), "login")
    const pending = Promise.withResolvers<Answer>()
    const asked = Promise.withResolvers<void>()
    const engine = fakeEngine(loginDir, { setConfig: () => { asked.resolve(); return pending.promise } })

    const listing = antigravityDynamicCatalog(SEAMS).fetch!(fetchInput(loginDir, engine.launcher))
    await asked.promise
    sweepLogin(loginDir)
    expect(engine.sessionFilesLeft()).toEqual(SESSION_FILES)
    pending.resolve({ result: { configOptions: configOptions("gemini-4-neon") } })

    expect((await listing).discovery.kind).toBe("rows")
    expect(engine.sessionFilesLeft()).toEqual([])
  })

  test("an option request that fails after the session opened fails the listing, removes its files, and logs no engine text", async () => {
    const loginDir = join(temporary("antigravity-catalog-"), "login")
    const engine = fakeEngine(loginDir, { setConfig: () => ({ error: { code: -32603, message: "engine secret detail" } }) })

    const { discovery } = await antigravityDynamicCatalog(SEAMS).fetch!(fetchInput(loginDir, engine.launcher))

    expect(discovery).toEqual({ kind: "failed", reason: "transport" })
    expect(engine.sessionFilesLeft()).toEqual([])
    expect(engine.records()).toEqual([])
    expect(warn.mock.calls).toEqual([["Google Antigravity model listing failed", { failure: "acp", method: "session/set_config_option", code: -32603 }]])
  })

  test("an engine that does not exit fails the listing, and its files and record stay while its end is unproven", async () => {
    const loginDir = join(temporary("antigravity-catalog-"), "login")
    const engine = fakeEngine(loginDir, { exits: false, closeSettled: false })

    const { discovery } = await antigravityDynamicCatalog({ ...SEAMS, exitDeadlineMs: 1 }).fetch!(fetchInput(loginDir, engine.launcher))

    expect(discovery).toEqual({ kind: "failed", reason: "transport" })
    expect(engine.sessionFilesLeft()).toEqual(SESSION_FILES)
    expect(engine.records()).toHaveLength(1)
  })

  test("an engine that is not the qualified version lists nothing and never starts `agy acp`", async () => {
    const loginDir = join(temporary("antigravity-catalog-"), "login")
    const engine = fakeEngine(loginDir, { version: "1.5.13" })

    const { discovery } = await antigravityDynamicCatalog(SEAMS).fetch!(fetchInput(loginDir, engine.launcher))

    expect(discovery).toEqual({ kind: "failed", reason: "transport" })
    expect(engine.launch()).toBeUndefined()
    expect(engine.records()).toEqual([])
    expect(warn.mock.calls).toEqual([["Google Antigravity model listing failed", { failure: "engine-unqualified" }]])
  })

  test("a login that agy refuses is an invalid credential", async () => {
    const loginDir = join(temporary("antigravity-catalog-"), "login")
    const engine = fakeEngine(loginDir, { newSession: () => ({ error: { code: -32000, message: "Authentication required" } }) })

    const { discovery } = await antigravityDynamicCatalog(SEAMS).fetch!(fetchInput(loginDir, engine.launcher))

    expect(discovery).toEqual({ kind: "auth-invalid" })
    expect(engine.terminations).toEqual([])
    expect(engine.records()).toEqual([])
  })

  test("the listing is the lineup, and models.dev only describes it and can only lower its window below the engine's compaction", async () => {
    const listed: CatalogDiscovery = {
      kind: "rows",
      rows: [
        { family: "gemini-3.1-pro", name: "Gemini 3.1 Pro", thoughtLevels: ["low", "high"] },
        { family: "gemini-4-neon", name: "Gemini 4 Neon", thoughtLevels: ["low", "medium", "high", "xhigh"] },
        { family: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", thoughtLevels: ["low", "high"] },
        // A row of another vendor, as agy lists to every client, never becomes a model.
        { family: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", thoughtLevels: [] },
      ],
    }
    let discovery: CatalogDiscovery = listed
    const definition: AccessProviderDefinition = {
      id: "google_antigravity", displayName: "Google Antigravity", shortName: "Antigravity", rank: 1, configHints: [], catalogId: undefined,
      dynamicCatalog: { ...antigravityDynamicCatalog(), fetch: async ({ credential }) => ({ discovery, credential }) },
      auth: { kind: "api_key", statusRank: 1 }, cli: { name: "antigravity" }, billing: "metered", spendMode: "direct_api",
    }
    const google = (wireModelId: string, contextLimit: number) => ({
      providerId: "google", providerName: "Google", wireModelId, provenance: "bundled" as const, canonical: { providerId: "google", modelId: wireModelId }, transport: { npm: "@ai-sdk/google" },
      metadata: modelInfo("google", wireModelId, "gemini", 2, 12, "2026-02-19", { contextLimit, totalContextLimit: contextLimit, outputLimit: 65_536 }),
    })
    const client = createModelListingClient({
      classifySlot: credentialSlotClassifier(testCapabilityModules()),
      authDir: AUTH_DIR,
      oauthPersistence: "access-only",
      providers: createAccessProviderSelection([definition]),
      modelsClient: {
        refresh: async () => {},
        getTokenizerIdentity: () => undefined,
        getProviderCatalog: () => [google("gemini-3.1-pro-preview", 1_048_576), google("gemini-4-neon", 128_000), google("gemini-3.5-flash", 1_048_576)],
      },
    })
    const auth: AuthContext = { ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { google_antigravity: "key" } }), credentialLineages: { google_antigravity: "lineage" } }

    const candidate = (await client.getModelCatalogs(auth, { mode: "fresh" })).candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "google_antigravity" }))

    expect(candidate?.visibleModels?.keys().toArray()).toEqual(["gemini-3.1-pro-preview", "gemini-4-neon", "gemini-4-hydrogen"])
    expect(candidate?.models?.keys().toArray()).toEqual(["gemini-3.1-pro-preview", "gemini-4-neon", "gemini-4-hydrogen"])
    // models.dev states 1,048,576: the cap below the engine's compaction holds.
    expect(candidate?.models?.get("gemini-3.1-pro-preview")?.[0]).toMatchObject({
      wireModelId: "gemini-3.1-pro",
      resolvedMetadata: { contextLimit: 230_000, totalContextLimit: 230_000, outputLimit: 65_536, reasoningEfforts: ["low", "high"], pricing: { status: "available", rateCard: { input: 2, output: 12 } } },
    })
    // models.dev states 128,000, below the cap of 460,000: it lowers the window.
    expect(candidate?.models?.get("gemini-4-neon")?.[0]?.resolvedMetadata).toMatchObject({ contextLimit: 128_000, totalContextLimit: 128_000 })
    // models.dev does not describe it: the window is the cap.
    expect(candidate?.models?.get("gemini-4-hydrogen")?.[0]?.resolvedMetadata).toMatchObject({ contextLimit: 230_000, totalContextLimit: 230_000 })

    // A listing that fails, as when the engine cannot start, offers no model, not the models.dev rows.
    discovery = { kind: "failed", reason: "transport" }
    const failed = (await client.getModelCatalogs(auth, { mode: "fresh" })).candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "google_antigravity" }))
    expect(failed?.visibleModels?.size).toBe(0)
  })
})
