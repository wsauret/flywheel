import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { antigravityEnginePath, requireQualifiedAntigravityVersion, separatedAntigravityEnvironment } from "../../../../infra/providers/antigravity-engine.js"
import { readAppVersion } from "../../../../infra/update/distribution/app-version.js"
import { readBounded } from "../../../../infra/supervision/commands/bounded-stream.js"
import { errorMessage } from "../../../../infra/diagnostics/error-message.js"
import type { AccessProviderCatalogFetchInput, AccessProviderDefinition } from "../../../../infra/providers/llm/access/access-provider.js"
import type { CatalogDiscovery, CatalogSourceRow } from "../../../../infra/providers/llm/catalog/model-catalog-resolution.js"
import { DEFAULT_DYNAMIC_CATALOG_LIMITS } from "../../../../infra/providers/model-catalog-rows.js"
import { PROVIDER_REASONING_EFFORTS } from "../../../../infra/providers/llm/models/models.js"
import { providerModelInfo } from "../../../../infra/providers/llm/catalog/provider-model-info.js"
import { Log } from "../../../../infra/diagnostics/log.js"
import { osAccount } from "../../../../infra/platform/os-account.js"
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../../infra/owned-command.js"
import type { OwnedProcess } from "../../../../infra/supervision/launch/owned-subprocess.js"
import { acquireLock, LockRefusal, releaseLock } from "../../../../infra/process/locks/ownership-file-lock.js"
import type { LauncherScope } from "../../../../infra/process-supervisor.js"
import { isRecord } from "../../../../infra/guards/record.js"
import { AcpRequestError, openAcpConnection, type AcpConnection } from "../acp/connection.js"
import type { AcpConfigOption } from "../acp/schema.js"
import { antigravityContextLimits } from "./context-limits.js"
import { EngineUnavailableError } from "../engine/engine-process.js"
import { antigravityWireIdentity } from "./model-identity.js"
import { acpLaunch } from "../engine/private-home.js"
import { createProcessRecord, type ProcessRecord } from "../engine/session-files.js"
import { keychainReachedFailure, prepareTokenStore, tokenStoreObservation } from "../engine/token-store.js"

const log = Log.create({ service: "provider-google-antigravity" })

/** The JSON-RPC error code with which agy refuses a session on a home that holds no usable login. */
const ACP_AUTHENTICATION_REQUIRED = -32000

/** How long the listing engine may take to exit after its input closed. agy exits in milliseconds; one that does not
 *  is ended with the listing's launch scope. */
const EXIT_DEADLINE_MS = 10_000

/** The most stderr bytes of a listing engine that are kept; the rest is drained and dropped. */
const STDERR_BYTES = 64 * 1024

/** What a fake-host script or a test replaces. Production uses none of them. */
export interface AntigravityCatalogSeams {
  /** An engine executable in place of the one that ships with Flywheel. */
  readonly enginePath?: string
  /** The platform whose token store the listing prepares, in place of this process's. */
  readonly platform?: NodeJS.Platform
  /** Variables the engine receives after the environment allowlist: a local base URL and a dummy key. */
  readonly testEnvironment?: { readonly [name: string]: string }
  /** How long the engine may take to exit after its input closed, in place of `EXIT_DEADLINE_MS`. */
  readonly exitDeadlineMs?: number
}

/** One model family as the listing engine offers it: the `model` option's value and name, and the values of the
 *  family's `thought_level` option. */
interface EngineFamily {
  readonly family: string
  readonly name: string
  readonly thoughtLevels: readonly string[]
}

function isEngineFamily(row: unknown): row is EngineFamily {
  return isRecord(row) && typeof row.family === "string" && typeof row.name === "string"
    && Array.isArray(row.thoughtLevels) && row.thoughtLevels.every((level) => typeof level === "string")
}

/** The family rows of one engine listing (`readEngineFamilies`). */
function extractEngineFamilies(listing: unknown): readonly unknown[] {
  if (!isRecord(listing) || !Array.isArray(listing.families)) throw new TypeError("the engine model listing must hold a family array")
  return listing.families
}

/** One catalog row per engine family, named by the Flywheel model it serves, with its thought levels as the efforts
 *  that serving selects (`thought_level`). The row states no window: the contribution's `contextCap` bounds the
 *  window that models.dev joins, so models.dev can only lower the route's window below the engine's compaction. */
function canonicalizeEngineFamily(row: unknown): CatalogSourceRow | undefined {
  if (!isEngineFamily(row) || antigravityContextLimits(row.family) === undefined) return undefined
  const identity = antigravityWireIdentity(row.family)
  const efforts = PROVIDER_REASONING_EFFORTS.filter((effort) => row.thoughtLevels.includes(effort))
  return {
    modelId: identity.modelId,
    wireModelId: row.family,
    metadata: { name: row.name, thought_levels: [...row.thoughtLevels] },
    resolvedMetadata: providerModelInfo({
      provider: "google",
      id: identity.modelId,
      name: row.name,
      reasoning: efforts.length > 0,
      ...(efforts.length === 0 ? {} : { reasoningEfforts: efforts }),
    }),
  }
}

/** agy names Gemini model families `gemini-<version>-<name>`. It also lists models of other vendors, such as
 *  `claude-sonnet-4-6` and `gpt-oss-120b-medium`, to every client (agy 1.5.14). */
const GEMINI_FAMILY = /^gemini-/u

/** The families that the engine names and that have a qualified window, which only Gemini families have: this route
 *  never offers a model of another vendor. A Gemini family without one is not offered either, which one record per
 *  family and process states. */
const unqualifiedFamilies = new Set<string>()
function offeredFamilies(model: AcpConfigOption | undefined): readonly AcpConfigOption["options"][number][] {
  return (model?.options ?? []).filter(({ value }) => {
    if (antigravityContextLimits(value) !== undefined) return true
    if (!GEMINI_FAMILY.test(value)) return false
    if (!unqualifiedFamilies.has(value)) {
      unqualifiedFamilies.add(value)
      log.info("Google Antigravity model family is not offered: no qualified context window", { family: value })
    }
    return false
  })
}

const option = (options: readonly AcpConfigOption[], id: string) => options.find((candidate) => candidate.id === id)

/** Opens one engine session, counted in the process record while its `session/new` is open, as serving opens one, so
 *  a sweep of the login never removes the files of a session that this listing can still be making. */
async function openListingSession(connection: AcpConnection, record: ProcessRecord, cwd: string, signal: AbortSignal) {
  record.beginOpen()
  let sessionId: string | undefined
  try {
    const session = await connection.request("session/new", { cwd, mcpServers: [] }, signal)
    sessionId = session.sessionId
    return session
  } finally {
    record.endOpen(sessionId)
  }
}

/** Reads the families of one new engine session: its `model` options and, for each offered family, the
 *  `thought_level` options that the engine states once the session selects that family. It sends no prompt, so the
 *  engine makes no model request and no title request. */
async function readEngineFamilies(connection: AcpConnection, record: ProcessRecord, cwd: string, signal: AbortSignal): Promise<{ readonly families: readonly EngineFamily[] }> {
  const session = await openListingSession(connection, record, cwd, signal)
  const model = option(session.configOptions, "model")
  let selected = model?.currentValue
  let configOptions = session.configOptions
  const families: EngineFamily[] = []
  for (const { value, name } of offeredFamilies(model)) {
    if (value !== selected) {
      configOptions = (await connection.request("session/set_config_option", { sessionId: session.sessionId, configId: "model", value }, signal)).configOptions
      selected = value
    }
    families.push({ family: value, name, thoughtLevels: (option(configOptions, "thought_level")?.options ?? []).map((level) => level.value) })
  }
  return { families }
}

function logLines(path: string): readonly string[] {
  try {
    return readFileSync(path, "utf8").split("\n")
  } catch {
    return []
  }
}

/** What a failed listing's record names: the kind of failure, never the engine's text (ARCH-RUNTIME-075). */
function failureFields(error: unknown) {
  if (error instanceof AcpRequestError) return { failure: "acp", method: error.method, code: error.code }
  if (error instanceof EngineUnavailableError) return { failure: error.reason }
  return { failure: error instanceof Error ? error.name : typeof error }
}

/**
 * Asks a short-lived engine on the login for the models it offers, with the launch values of serving: Flywheel's
 * client identity, the login's private home and token store, the qualified engine, and its private workspace. The
 * engine runs in a background scope nested in the listing caller's launch scope, and it joins the login's engine
 * ownership as a serving engine does (`session-files.ts`). It answers `initialize` and `session/new`, and
 * `session/set_config_option` once for each offered family; then its input closes and the listing waits for it to
 * exit, so it never ends while agy writes its login state. Its session's files, its process record, and its log are
 * removed once it exited. A login that agy refuses (`Authentication required`) is an invalid credential.
 */
async function discoverEngineModels({ credential, launcher, signal }: AccessProviderCatalogFetchInput, seams: AntigravityCatalogSeams): Promise<CatalogDiscovery> {
  if (credential.type !== "external" || !isAbsolute(credential.configDir)) return { kind: "auth-invalid" }
  if (launcher === undefined) return { kind: "failed", reason: "transport" }
  const loginDir = credential.configDir
  const scope = launcher.open({ priority: "background" })
  try {
    return await listOnEngine(loginDir, scope, signal, seams)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof AcpRequestError && error.code === ACP_AUTHENTICATION_REQUIRED) return { kind: "auth-invalid" }
    log.warn("Google Antigravity model listing failed", failureFields(error))
    return { kind: "failed", reason: "transport" }
  } finally {
    await scope.close()
  }
}

/** The listing engine and its process record, started under the login's launch lock, the lock that serving launches
 *  take: the token store is prepared and the engine's version qualified before any `agy acp` runs, and the record
 *  exists before the engine can make a session file, so a sweep of another launch never takes them for an orphan. */
async function startListingEngine(loginDir: string, scope: LauncherScope, seams: AntigravityCatalogSeams, processId: string): Promise<{ readonly engine: OwnedProcess; readonly record: ProcessRecord }> {
  const platform = seams.platform ?? process.platform
  const launch = acpLaunch(loginDir, processId)
  const environment = separatedAntigravityEnvironment({ account: osAccount(), platform, hostEnvironment: process.env, ...(seams.testEnvironment === undefined ? {} : { testEnvironment: seams.testEnvironment }) }, loginDir)
  let lock: Awaited<ReturnType<typeof acquireLock>>
  try {
    lock = await acquireLock(join(loginDir, "launch.lock"))
  } catch (error) {
    if (error instanceof LockRefusal) throw new EngineUnavailableError("login-in-use", `Another Flywheel process is starting an Antigravity engine on this login: ${error.message}`)
    throw error
  }
  try {
    const run = ownedCommandRunner(scope)
    await prepareTokenStore(loginDir, { platform, run })
    let enginePath: string
    try {
      enginePath = seams.enginePath ?? antigravityEnginePath()
    } catch (error) {
      throw new EngineUnavailableError("engine-missing", errorMessage(error))
    }
    const separatedRun: OwnedCommandRunner = (command, options) => run(command, { ...options, env: environment, cwd: launch.cwd })
    await requireQualifiedAntigravityVersion(enginePath, separatedRun).catch((error: unknown) => {
      throw new EngineUnavailableError("engine-unqualified", errorMessage(error))
    })
    const record = createProcessRecord(loginDir, processId)
    try {
      const engine = await scope.spawnOwned([enginePath, ...launch.args], { cwd: launch.cwd, env: environment })
      return { engine, record }
    } catch (error) {
      record.remove()
      throw error
    }
  } finally {
    releaseLock(lock)
  }
}

async function listOnEngine(loginDir: string, scope: LauncherScope, signal: AbortSignal, seams: AntigravityCatalogSeams): Promise<CatalogDiscovery> {
  const processId = `listing-${randomUUID()}`
  const launch = acpLaunch(loginDir, processId)
  const { engine, record } = await startListingEngine(loginDir, scope, seams, processId)
  if (engine.stdin === undefined || engine.stdout === undefined) {
    await engine.terminate()
    record.remove()
    throw new Error("the listing engine has no standard input or output")
  }
  const stderr = readBounded(engine.stderr, STDERR_BYTES, "tail")
  const connection = openAcpConnection({ stdin: engine.stdin, stdout: engine.stdout, onNotification: () => {}, onAgentRequestRefused: () => {} })
  let listed: Awaited<ReturnType<typeof readEngineFamilies>> | undefined
  let failure: unknown
  try {
    await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "flywheel", version: await readAppVersion() },
    }, signal)
    listed = await readEngineFamilies(connection, record, launch.cwd, signal)
  } catch (error) {
    failure = error
  }
  await connection.close()
  const deadlineMs = seams.exitDeadlineMs ?? EXIT_DEADLINE_MS
  const exited = await Promise.race([engine.exited.then(() => true), Bun.sleep(deadlineMs).then(() => false)])
  if (!exited) {
    // An engine that had to be ended may have stopped mid-write, so its answers are not a listing. Its files stay
    // with its record until its end is proven; the sweep of a later launch removes them once this process is gone.
    const { settled } = await scope.close()
    log.warn("Google Antigravity listing engine did not exit after its input closed; ended it", { deadlineMs, settled })
    if (settled) {
      record.remove()
      rmSync(launch.logFile, { force: true })
    }
    return { kind: "failed", reason: "transport" }
  }
  await stderr
  record.remove()
  // An engine that reached the person's keyring fails the listing whatever it answered, so the login shows why.
  const reached = keychainReachedFailure(tokenStoreObservation(logLines(launch.logFile)))
  rmSync(launch.logFile, { force: true })
  if (reached !== undefined) throw reached
  if (listed === undefined) throw failure
  return { kind: "rows", rows: extractEngineFamilies(listed) }
}

/**
 * The provider's catalog: the Gemini families that the engine offers the login, which are its whole lineup
 * (`first-party`), one row per family. models.dev `google` rows only describe those models, such as their price and
 * output limit, and never add one. Families join models.dev, and the Google API Key provider, on the Flywheel model
 * they serve (`antigravityWireIdentity`). Each family's window is the smaller of the joined one and the qualified
 * cap below agy's own compaction (`antigravityContextLimits`).
 */
export function antigravityDynamicCatalog(seams: AntigravityCatalogSeams = {}): NonNullable<AccessProviderDefinition["dynamicCatalog"]> {
  return {
    limits: DEFAULT_DYNAMIC_CATALOG_LIMITS,
    extractRows: extractEngineFamilies,
    canonicalize: canonicalizeEngineFamily,
    canonicalizeWireId: antigravityWireIdentity,
    modelsDevCatalogIds: ["google"],
    membership: "first-party",
    contextCap: (wireModelId) => antigravityContextLimits(wireModelId)?.contextLimit,
    fetch: async (input) => ({ discovery: await discoverEngineModels(input, seams), credential: input.credential }),
  }
}
