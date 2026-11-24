import { Schema } from "effect"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import { antigravityEnginePath, separatedAntigravityEnvironment, type AntigravityEngineHost } from "../../../../infra/antigravity-engine.js"
import { readAppVersion } from "../../../../infra/app-version.js"
import { writeFileAtomic } from "../../../../infra/atomic-write.js"
import { errorMessage } from "../../../../infra/error-message.js"
import type { ExternalLoginDefinition, ExternalLoginPorts } from "../../../../infra/llm/access/access-provider.js"
import { Log } from "../../../../infra/log.js"
import { ownedCommandRunner } from "../../../../infra/owned-command.js"
import type { OwnedProcess } from "../../../../infra/owned-subprocess.js"
import type { LauncherScope } from "../../../../infra/process-supervisor.js"
import { AcpRequestError, openAcpConnection, type AcpConnection } from "../acp/connection.js"
import { withLoginOwnership } from "../engine/engine-process.js"
import type { GateHookHandler } from "../engine/hook-command.js"
import { EngineCannotStartError, loginProblems, type LoginObservations, type ProfileLogin } from "./login-status.js"
import { accountRecordPath, GOOGLE_ANTIGRAVITY_LABEL, LOGIN_PROGRAM_LABEL, loginsDirectory } from "../names.js"
import { acpLaunch, prepareLoginHome } from "../engine/private-home.js"
import { keychainReachedFailure, prepareTokenStore, tokenStoreObservation } from "../engine/token-store.js"
import type { ExternalAccount } from "../../../../infra/auth/provider-account.js"

// agy runs every sign-in itself (plan M7a, design feature 2): its browser
// loopback flow through ACP `authenticate`, or `agy acp --login`, which prints
// a Google sign-in URL and reads the pasted code on its standard input (agy
// 1.5.14, observed in a container with no network). Flywheel never reads, logs,
// or copies the token: agy keeps it in its own store in the login's private
// home, which `prepareTokenStore` makes unable to show a keychain dialog before
// every launch. Flywheel learns which account signed in only from agy's own log
// line `OAuth: authenticated successfully as <email>`, observed in a live sign-in
// of agy 1.5.14. Whether that line is the qualified token-free identity source
// is plan question Q2, and whether ACP `logout` purges the token from agy's
// store is Q3: both stay blocked on the live qualification (M15).

const log = Log.create({ service: "provider-google-antigravity" })

/** A logout ends well inside this bound; an engine that does not is ended. */
const LOGOUT_TIMEOUT_MS = 30_000
/** How long an engine may take to exit after its standard input ended, before it is ended. */
const EXIT_GRACE_MS = 5_000
/** The longest engine failure text that an error carries. */
const MAX_REASON_CHARS = 300

/** The sign-in URL line of `agy acp --login`: the URL alone, indented, after "Open this link in a browser". */
const LOGIN_URL = /^\s+(https:\/\/accounts\.google\.com\/\S+)\s*$/u
/** agy's log line when a sign-in completed or a stored login loaded. */
const SIGNED_IN = /OAuth: authenticated successfully as (\S+)\s*$/u
/** agy's ACP method of the browser sign-in for a personal Google account. */
const BROWSER_SIGN_IN = "oauth-personal"
/** agy's refusal of the browser sign-in on a host with no display, such as a container or an SSH session (agy
 *  1.5.14: `-32603`, "No browser is available here (no graphical display is available to open a browser). Run `agy
 *  acp --login` in a terminal on this machine, ..."), observed in a Linux container. */
const NO_BROWSER = /No browser is available/u

function isNoBrowserRefusal(error: unknown): boolean {
  return error instanceof AcpRequestError && error.method === "authenticate" && NO_BROWSER.test(error.message)
}

/** Flywheel's token-free record of a login directory's account (`account.json`), version 1. */
const AccountRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  accountId: Schema.String,
  identity: Schema.String,
  createdAt: Schema.String,
  refreshedAt: Schema.String,
})
type AccountRecord = typeof AccountRecordSchema.Type

const warnedRecords = new Set<string>()

/** A login again of an account whose sign-in named another Google account. The login's record and observations stay
 *  as they were; its account must log in again with the account it names. */
class AccountMismatchError extends Error {
  constructor(readonly expected: string, readonly found: string) {
    super(`The sign-in used a different Google account: ${found}. This login belongs to ${expected}. Log in again with ${expected}.`)
    this.name = "AccountMismatchError"
  }
}

/** What the logins of one auth profile run on, and what a change of them tells. */
export interface AntigravityProfile {
  readonly authDir: string
  readonly host: AntigravityEngineHost
  /** The engine that ships with Flywheel (`antigravityEnginePath`); tests name a fake. */
  readonly enginePath?: () => string
  /** The PreInvocation hook of the login directory's step gate, which the login's private home names. */
  readonly gateHook: (loginDir: string) => GateHookHandler
  /** Runs `work` once no engine of the module's process registry runs on the login directory, and lets no engine
   *  start on it until `work` settled: the bracket of a logout and the removal of the directory. */
  readonly withLoginReleased: <T>(loginDir: string, signal: AbortSignal | undefined, work: () => Promise<T>) => Promise<T>
  readonly observations: LoginObservations
}

interface LogoutPorts {
  readonly launcher: LauncherScope
  readonly signal?: AbortSignal
}

/** The engine path, or the typed failure of an engine that cannot run here. */
function enginePath(profile: AntigravityProfile): string {
  try {
    return (profile.enginePath ?? antigravityEnginePath)()
  } catch (error) {
    throw new EngineCannotStartError(errorMessage(error), error)
  }
}

/** The account record of the login directory `loginDir`: none when the directory holds no record yet (a sign-in
 *  that has not completed), and none, with one warning per file and process, when the record has a shape that this
 *  release does not know. The file stays as it is. */
function readAccountRecord(loginDir: string): AccountRecord | undefined {
  const path = accountRecordPath(loginDir)
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    raw = undefined
  }
  const decoded = Schema.decodeUnknownOption(AccountRecordSchema)(raw)
  if (decoded._tag === "Some") return decoded.value
  if (!warnedRecords.has(path)) {
    warnedRecords.add(path)
    log.warn("a Google Antigravity account record has a shape that this release does not read; its login is not listed and the file is kept", { path, bytes: text.length })
  }
  return undefined
}

/** Every login directory of the auth profile in `authDir`, in name order. */
function loginDirectories(authDir: string): readonly string[] {
  const root = loginsDirectory(authDir)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)).sort()
}

/** Every login directory of the auth profile in `authDir`, with the account whose record it holds, if any. A read of
 *  Flywheel's own records with no launch, so it is safe at startup. */
export function antigravityLogins(authDir: string): readonly ProfileLogin[] {
  return loginDirectories(authDir).map((loginDir) => {
    const record = readAccountRecord(loginDir)
    return record === undefined ? { loginDir } : { loginDir, account: { accountId: record.accountId, identity: record.identity, configDir: loginDir } }
  })
}

/** The accounts of the auth profile in `authDir`, one per login directory whose account record this release reads. */
export function antigravityAccounts(authDir: string): readonly ExternalAccount[] {
  return antigravityLogins(authDir).flatMap((login) => login.account === undefined ? [] : [login.account])
}

function logLines(logFile: string): readonly string[] {
  try {
    return readFileSync(logFile, "utf8").split("\n")
  } catch {
    return []
  }
}

/** Reads the token-store lines and the signed-in account of the engine log at `logFile`, records the token-store
 *  observation for the login, and removes the log, which can name the account. Rejects when the log shows a keyring
 *  call that the prepared token store makes impossible (`keychain-reached`). Returns the account that the log names
 *  as signed in, if any. */
function settleEngineLog(profile: AntigravityProfile, loginDir: string, logFile: string): string | undefined {
  const lines = logLines(logFile)
  rmSync(logFile, { force: true })
  const observation = tokenStoreObservation(lines)
  profile.observations.recordTokenStoreObservation(loginDir, observation)
  const reached = keychainReachedFailure(observation)
  if (reached !== undefined) throw reached
  let identity: string | undefined
  for (const line of lines) identity = SIGNED_IN.exec(line)?.[1] ?? identity
  return identity
}

/** Makes the login directory ready for an engine launch: its private home and its token store, which on macOS is the
 *  login's private keychain, so that no launch can show the person a keychain dialog or reach their own keychains. The
 *  caller owns the login (`withLoginOwnership`), so no other process's engines read the hook that this writes. */
async function prepareLaunch(profile: AntigravityProfile, loginDir: string, launcher: LauncherScope): Promise<void> {
  const run = ownedCommandRunner(launcher)
  await prepareLoginHome(loginDir, { gateHook: profile.gateHook(loginDir), run })
  profile.observations.recordTokenStoreKind(loginDir, await prepareTokenStore(loginDir, { platform: profile.host.platform, run }))
}

/** The launch of one engine on the login directory (`acpLaunch`): Flywheel's agent, its own log in the login's
 *  `logs` folder, which `settleEngineLog` reads and removes, the login's private workspace, and the separated
 *  environment. */
function engineLaunch(profile: AntigravityProfile, loginDir: string, kind: "login" | "logout") {
  const launch = acpLaunch(loginDir, `${kind}-${crypto.randomUUID()}`)
  return { ...launch, options: { env: separatedAntigravityEnvironment(profile.host, loginDir), cwd: launch.cwd } }
}

/** Ends the engine when `signal` aborts, also when it aborted while the engine was starting. Returns the removal of
 *  that listener. */
function endOnAbort(owned: OwnedProcess, signal: AbortSignal | undefined): () => void {
  const end = (): void => { void owned.terminate() }
  // Attached before the aborted state is read, so an abort during the launch is never missed.
  signal?.addEventListener("abort", end, { once: true })
  if (signal?.aborted === true) end()
  return () => signal?.removeEventListener("abort", end)
}

/** Waits for the engine to exit after its standard input ended, and ends it when it does not. */
async function awaitExit(owned: OwnedProcess): Promise<void> {
  const timer = setTimeout(() => { void owned.terminate() }, EXIT_GRACE_MS)
  try {
    await owned.exited
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Starts `agy acp` for one login step, initializes the ACP connection with Flywheel's own client identity, runs
 * `work` on it, and then ends the engine through its standard input. The signal ends the engine. Settles after the
 * engine exited, so its log is complete.
 */
async function withAcpEngine(profile: AntigravityProfile, launcher: LauncherScope, launch: ReturnType<typeof engineLaunch>, signal: AbortSignal | undefined, work: (connection: AcpConnection) => Promise<void>): Promise<void> {
  signal?.throwIfAborted()
  const owned = await launcher.spawnOwned([enginePath(profile), ...launch.args], launch.options)
  const stopListening = endOnAbort(owned, signal)
  try {
    if (owned.stdin === undefined || owned.stdout === undefined) throw new EngineCannotStartError(`The ${LOGIN_PROGRAM_LABEL} started with no ACP pipes`, undefined)
    void readLines(owned.stderr, () => {})
    const connection = openAcpConnection({ stdin: owned.stdin, stdout: owned.stdout, onNotification: () => {}, onAgentRequestRefused: () => {} })
    try {
      await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "flywheel", version: await readAppVersion() },
      }, signal)
      await work(connection)
    } finally {
      await connection.close()
    }
  } finally {
    stopListening()
    await awaitExit(owned)
  }
}

async function readLines(stream: ReadableStream<Uint8Array> | undefined, onLine: (line: string) => void): Promise<void> {
  if (stream === undefined) return
  const decoder = new TextDecoder()
  let buffered = ""
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  }
  if (buffered.length > 0) onLine(buffered)
}

/** The person's own sign-in through `agy acp --login`: the URL that agy prints goes to `onAuthorizeUrl`, and the
 *  code that the person pastes goes only to agy's standard input, never to a file or a record. Rejects when agy
 *  exits without a login, with agy's last line as the reason, and when the signal ends it. */
async function pastedCodeSignIn(profile: AntigravityProfile, ports: ExternalLoginPorts, launch: ReturnType<typeof engineLaunch>): Promise<void> {
  ports.signal?.throwIfAborted()
  const owned = await ports.launcher.spawnOwned([enginePath(profile), "acp", "--login", "--disable-telemetry", "--log-file", launch.logFile], launch.options)
  const stopListening = endOnAbort(owned, ports.signal)
  let reported = false
  let lastLine = ""
  const onLine = (line: string): void => {
    if (line.trim().length > 0) lastLine = line.trim()
    const url = LOGIN_URL.exec(line)?.[1]
    if (url === undefined || reported || ports.signal?.aborted === true) return
    reported = true
    ports.onAuthorizeUrl?.({ url })
    void ports.onManualCodeInput?.().then((pasted) => {
      if (ports.signal?.aborted === true) return
      owned.stdin?.write(`${pasted.trim()}\n`)
      void owned.stdin?.flush()
    }, () => {})
  }
  try {
    const [exit] = await Promise.all([owned.exited, readLines(owned.stdout, onLine), readLines(owned.stderr, () => {})])
    if (ports.signal?.aborted) throw new Error("Login cancelled")
    if (exit.code !== 0) throw new Error(`The ${LOGIN_PROGRAM_LABEL} sign-in did not complete${lastLine.length > 0 ? `: ${lastLine.slice(0, MAX_REASON_CHARS)}` : ""}`)
  } finally {
    stopListening()
    void owned.stdin?.end()
  }
}

/** The person's own sign-in through agy's browser loopback flow (ACP `authenticate` with `oauth-personal`): agy
 *  opens the browser on this machine and receives the callback itself. */
async function browserSignIn(profile: AntigravityProfile, ports: ExternalLoginPorts, launch: ReturnType<typeof engineLaunch>): Promise<void> {
  await withAcpEngine(profile, ports.launcher, launch, ports.signal, async (connection) => {
    await connection.request("authenticate", { methodId: BROWSER_SIGN_IN }, ports.signal)
  })
  if (ports.signal?.aborted) throw new Error("Login cancelled")
}

/** Runs one sign-in step on a new launch of the login directory and returns the account that agy's log names. */
async function signInStep(profile: AntigravityProfile, loginDir: string, ports: ExternalLoginPorts, step: typeof pastedCodeSignIn): Promise<string | undefined> {
  const launch = engineLaunch(profile, loginDir, "login")
  try {
    await step(profile, ports, launch)
  } catch (error) {
    // A keychain that the engine reached is the failure that matters most, whatever ended the sign-in.
    settleEngineLog(profile, loginDir, launch.logFile)
    throw error
  }
  return settleEngineLog(profile, loginDir, launch.logFile)
}

/** Runs agy's own sign-in on the prepared login directory and returns the account that agy's log names. A client
 *  that can open a browser gets agy's browser flow; on a host where agy finds no display, the same login goes on with
 *  the pasted-code flow, which is agy's own remedy for that host. */
async function signIn(profile: AntigravityProfile, loginDir: string, ports: ExternalLoginPorts): Promise<string | undefined> {
  await withLoginOwnership(loginDir, () => prepareLaunch(profile, loginDir, ports.launcher))
  if (ports.openBrowser === undefined) return await signInStep(profile, loginDir, ports, pastedCodeSignIn)
  try {
    return await signInStep(profile, loginDir, ports, browserSignIn)
  } catch (error) {
    if (!isNoBrowserRefusal(error)) throw error
    log.info("Google Antigravity browser sign-in has no display here; using the pasted-code sign-in", { login: basename(loginDir) })
    return await signInStep(profile, loginDir, ports, pastedCodeSignIn)
  }
}

/** Runs agy's documented logout of the login directory (ACP `logout`, which `initialize` advertises as
 *  `agentCapabilities.auth.logout`) on a prepared token store, within `LOGOUT_TIMEOUT_MS`. The caller owns the login
 *  (`withLoginOwnership`). */
async function engineLogout(profile: AntigravityProfile, loginDir: string, ports: LogoutPorts): Promise<void> {
  await prepareLaunch(profile, loginDir, ports.launcher)
  const launch = engineLaunch(profile, loginDir, "logout")
  const deadline = AbortSignal.timeout(LOGOUT_TIMEOUT_MS)
  const signal = ports.signal === undefined ? deadline : AbortSignal.any([ports.signal, deadline])
  try {
    await withAcpEngine(profile, ports.launcher, launch, signal, async (connection) => {
      await connection.request("logout", {}, signal)
    })
  } finally {
    settleEngineLog(profile, loginDir, launch.logFile)
  }
}

function writeAccountRecord(loginDir: string, record: AccountRecord): void {
  writeFileAtomic(accountRecordPath(loginDir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Runs agy's own sign-in and returns the account that the login directory then holds. With `previous`, the account
 * signs in again in its own login directory, and nothing new is made; a sign-in that names another account rejects
 * with `AccountMismatchError` and leaves the login's record and observations as they were. Whether agy then still
 * holds the previous account's token in that directory is plan question Q3, blocked on the live qualification (M15).
 * Without it, a new login directory (a
 * random id, 0700) is made in the profile: a sign-in that does not complete removes it, and one that completed but
 * named no account logs out first, so agy keeps no token that no surface can show or end. With `ports.openBrowser`,
 * agy runs its browser flow; without it, the person can be on another machine, such as the phone, and pastes the code
 * of the URL that `onAuthorizeUrl` reports. Every launch runs on a prepared token store (`prepareTokenStore`).
 */
export async function loginAntigravityAccount(profile: AntigravityProfile, ports: ExternalLoginPorts, previous?: ExternalAccount): Promise<ExternalAccount> {
  enginePath(profile)
  const accountId = previous?.accountId ?? crypto.randomUUID()
  const loginDir = previous?.configDir ?? join(loginsDirectory(profile.authDir), accountId)
  if (previous === undefined) mkdirSync(loginDir, { recursive: true, mode: 0o700 })
  let identity: string | undefined
  try {
    identity = await signIn(profile, loginDir, ports)
  } catch (error) {
    if (previous === undefined) rmSync(loginDir, { recursive: true, force: true })
    throw error
  }
  if (identity === undefined) {
    const error = new Error(`The ${LOGIN_PROGRAM_LABEL} completed its sign-in but named no account`)
    if (previous !== undefined) throw error
    await endLogin(profile, loginDir, ports).catch((cause: unknown) => { throw new AggregateError([error, cause], errorMessage(error)) })
    throw error
  }
  if (previous !== undefined && identity !== previous.identity) throw new AccountMismatchError(previous.identity, identity)
  const now = new Date().toISOString()
  writeAccountRecord(loginDir, { version: 1, accountId, identity, createdAt: readAccountRecord(loginDir)?.createdAt ?? now, refreshedAt: now })
  log.info("Google Antigravity login completed", { login: accountId, reconnect: previous !== undefined })
  return { accountId, identity, configDir: loginDir }
}

/** Ends one login directory while no engine runs or starts on it: this process's engines of the login close first
 *  (`withLoginReleased`), and then the login's ownership (`withLoginOwnership`) holds every other process off. agy's
 *  logout runs there, and only after it succeeded the directory goes; then this process forgets what it observed
 *  about the login. A login that another process serves cannot be ended from here: it rejects with
 *  `EngineUnavailableError` (`login-in-use`) and runs no logout. A failed or refused logout keeps every file, so a
 *  later attempt can end the token that agy still holds. */
async function endLogin(profile: AntigravityProfile, loginDir: string, ports: LogoutPorts): Promise<void> {
  await profile.withLoginReleased(loginDir, ports.signal, () => withLoginOwnership(loginDir, async () => {
    await engineLogout(profile, loginDir, ports)
    rmSync(loginDir, { recursive: true, force: true })
  }))
  profile.observations.forget(loginDir)
  log.info("Google Antigravity login ended", { login: basename(loginDir) })
}

/** The failure of one login's end, naming its account. */
function endFailure(loginDir: string, error: unknown): Error {
  const name = readAccountRecord(loginDir)?.identity ?? loginDir
  return new Error(`The ${GOOGLE_ANTIGRAVITY_LABEL} logout of ${name} did not complete: ${errorMessage(error)}`, { cause: error })
}

/** Disconnects one account from the profile (`endLogin`). An account that no login directory holds is already gone. */
export async function logoutAntigravityAccount(profile: AntigravityProfile, accountId: string, ports: LogoutPorts): Promise<void> {
  const account = antigravityAccounts(profile.authDir).find((candidate) => candidate.accountId === accountId)
  if (account === undefined) return
  await endLogin(profile, account.configDir, ports).catch((error: unknown) => { throw endFailure(account.configDir, error) })
}

/** Ends every login directory of the profile (`endLogin`), also one whose record this release cannot read, before
 *  the profile's directory goes: agy can keep a token outside the directory, such as in the Windows Credential
 *  Manager. Rejects after it tried every login when one of them did not end. */
export async function logoutProfileAntigravityAccounts(profile: AntigravityProfile, ports: { readonly launcher: LauncherScope }): Promise<void> {
  const failures: Error[] = []
  for (const loginDir of loginDirectories(profile.authDir)) {
    await endLogin(profile, loginDir, ports).catch((error: unknown) => { failures.push(endFailure(loginDir, error)) })
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} ${GOOGLE_ANTIGRAVITY_LABEL} logins of the profile did not end`)
}

/** The provider's external login strategy (`AccessProviderExternalLogin`), without the rank that its definition
 *  sets. `profileOf` gives the logins of one auth profile with this process's engine host; `observations` are this
 *  process's, which every login, request, and auth view shares. */
export function googleAntigravityLogin(observations: LoginObservations, profileOf: (authDir: string) => Omit<AntigravityProfile, "observations">): AntigravityExternalLogin {
  const profile = (authDir: string): AntigravityProfile => ({ ...profileOf(authDir), observations })
  return {
    kind: "external" as const,
    program: LOGIN_PROGRAM_LABEL,
    accounts: antigravityAccounts,
    problems: (authDir) => loginProblems(antigravityAccounts(authDir), observations),
    observe: (listener) => observations.observe(listener),
    awaitLogin: async (authDir, accountId, signal) => {
      signal.throwIfAborted()
      const account = antigravityAccounts(authDir).find((candidate) => candidate.accountId === accountId)
      return account === undefined ? "declined" : await observations.awaitLogin(authDir, account, signal)
    },
    loginQuestions: () => observations.loginQuestions(),
    answerLogin: (id, answer) => observations.answerLogin(id, answer),
    settleLogin: (id, answer) => { observations.settleLogin(id, answer) },
    login: async (authDir, ports, previous) => {
      const account = await loginAntigravityAccount(profile(authDir), ports, previous)
      // A login that answers a refusal question leaves its renewal to the runtime's `settleLogin`, and renews only
      // the refused account's waits.
      if (ports.loginQuestionId === undefined) observations.clearRequest(account.configDir)
      else if (previous?.accountId !== account.accountId) {
        observations.clearRequest(account.configDir)
        throw new Error(`The login used a different account: ${account.identity}. Waiting runs for ${previous?.identity ?? "the refused account"} ended with the original login error.`)
      }
      return account
    },
    logout: (authDir, accountId, ports) => logoutAntigravityAccount(profile(authDir), accountId, ports),
    logoutProfile: (authDir, ports) => logoutProfileAntigravityAccounts(profile(authDir), ports),
  }
}

/** The provider's external login strategy, as its definition (M7b) spreads it beside its rank. */
type AntigravityExternalLogin = Omit<Extract<ExternalLoginDefinition["auth"], { readonly kind: "external" }>, "statusRank">
