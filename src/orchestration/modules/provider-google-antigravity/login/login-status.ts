import { holdsPinnedAntigravityBytes, QUALIFIED_ANTIGRAVITY_VERSION, type AntigravityPinnedBytes } from "../../../../infra/distribution/antigravity-engine-pin.js"
import { errorMessage } from "../../../../infra/error-message.js"
import type { ExternalLoginProblem, ExternalLoginQuestion, LoginWaitAnswer } from "../../../../infra/llm/access/access-provider.js"
import { Log } from "../../../../infra/diagnostics/log.js"
import { RouteUnavailableError } from "../../../agent-runtime/llm/errors.js"
import { classifyProviderFailure } from "../../../agent-runtime/llm/stream/provider-failure.js"
import type { ModuleHealthReport } from "../../../module-health.js"
import { GOOGLE_ANTIGRAVITY_LABEL, LOGIN_PROGRAM_LABEL } from "../names.js"
import { reachedKeyringKinds, type TokenStoreKind, type TokenStoreObservation } from "../engine/token-store.js"
import type { ExternalAccount } from "../../../../infra/auth/provider-account.js"

const log = Log.create({ service: "provider-google-antigravity" })

/** How the last request of a login ended, as far as the login and its engine are concerned. */
type RequestOutcome = "served" | "login-rejected" | "program-exited" | "program-cannot-start"

/** The failure of a login's last request that the person must know about. */
export type LoginFailure = Exclude<RequestOutcome, "served">

/** The bundled engine could not start for a login, a logout, or a request: it is missing, unverified, or of a
 *  version that did not pass qualification. Another start fails the same way, so a request goes to the next route
 *  at once, as for a route that is down. */
export class EngineCannotStartError extends RouteUnavailableError {
  constructor(message: string, cause: unknown) {
    super(message)
    this.name = "EngineCannotStartError"
    this.cause = cause
  }
}

/** The login failure that one ended request states: an engine that could not start, a refused login when the error
 *  is the provider's refusal of the login (agy's JSON-RPC `Authentication required`, -32000, or a 401 or 403), else
 *  an exit of the engine while the request was open. */
export function loginFailure(error: Error | undefined, exitedDuringRequest: boolean): LoginFailure | undefined {
  if (error instanceof EngineCannotStartError) return "program-cannot-start"
  if (error !== undefined && classifyProviderFailure(error)._tag === "AuthFailure") return "login-rejected"
  return exitedDuringRequest ? "program-exited" : undefined
}

/** What this process last learned about a login's token store: the kind that the last preparation made, and what
 *  the last engine log of the login said about it. Neither holds a token. */
interface TokenStoreState {
  readonly kind?: TokenStoreKind
  readonly observation?: TokenStoreObservation
}

/**
 * What this process observed about the Google Antigravity logins that no file shows, each keyed by its login
 * directory: how its last request ended, its token store, and its open login question. The auth view reads it with
 * no launch, and `observe` tells it when an answer changed. It holds no token and no content.
 */
export interface LoginObservations {
  recordRequest(loginDir: string, outcome: RequestOutcome): void
  /** A new login of the account: its last request no longer states anything about it. */
  clearRequest(loginDir: string): void
  recordTokenStoreKind(loginDir: string, kind: TokenStoreKind): void
  recordTokenStoreObservation(loginDir: string, observation: TokenStoreObservation): void
  /** The login ended: its waiting requests end declined, and its question, last request, and token store are gone. */
  forget(loginDir: string): void
  outcome(loginDir: string): RequestOutcome | undefined
  failure(loginDir: string): LoginFailure | undefined
  tokenStore(loginDir: string): TokenStoreState
  /** Calls `listener` after an answer changed. Returns the unsubscribe. */
  observe(listener: () => void): () => void
  awaitLogin(authDir: string, account: ExternalAccount, signal: AbortSignal): Promise<LoginWaitAnswer>
  loginQuestions(): readonly ExternalLoginQuestion[]
  answerLogin(questionId: string, answer: LoginWaitAnswer): ExternalLoginQuestion | undefined
  settleLogin(questionId: string, answer: LoginWaitAnswer): void
}

interface LoginEpisode {
  readonly id: string
  readonly authDir: string
  readonly account: ExternalAccount
  phase: "asking" | "logging-in" | "declined"
  readonly waiters: Set<(answer: LoginWaitAnswer) => void>
}

function failureOf(outcome: RequestOutcome | undefined): LoginFailure | undefined {
  return outcome === "served" ? undefined : outcome
}

/** A new, empty set of observations. The module keeps one per process, which every login, request, and auth view of
 *  the process shares. */
export function createLoginObservations(): LoginObservations {
  const outcomes = new Map<string, RequestOutcome>()
  const tokenStores = new Map<string, TokenStoreState>()
  const listeners = new Set<() => void>()
  const episodes = new Map<string, LoginEpisode>()
  const changed = (): void => {
    for (const listener of listeners) listener()
  }
  const record = (episode: LoginEpisode, decision: "asking" | "logging-in" | "forgotten" | LoginWaitAnswer): void => {
    log.info("Google Antigravity login question", { questionId: episode.id, decision, waiters: episode.waiters.size })
  }
  const settle = (episode: LoginEpisode, answer: LoginWaitAnswer, outcome?: RequestOutcome): void => {
    record(episode, answer)
    if (answer === "renewed") {
      episodes.delete(episode.account.configDir)
      if (outcome === undefined) outcomes.delete(episode.account.configDir)
      else outcomes.set(episode.account.configDir, outcome)
    } else episode.phase = "declined"
    for (const waiter of episode.waiters) waiter(answer)
    changed()
  }
  const descriptor = (episode: LoginEpisode): ExternalLoginQuestion | undefined => episode.phase === "declined" ? undefined
    : { id: episode.id, authDir: episode.authDir, account: episode.account, phase: episode.phase }
  const find = (id: string): LoginEpisode | undefined => [...episodes.values()].find((episode) => episode.id === id)
  // Only a change of the failure changes what the auth view shows, so a served request after another tells no one.
  const setOutcome = (key: string, outcome: RequestOutcome | undefined): void => {
    const episode = episodes.get(key)
    if (episode !== undefined && (outcome === "served" || outcome === undefined)) {
      settle(episode, "renewed", outcome)
      return
    }
    const before = failureOf(outcomes.get(key))
    if (outcome === undefined) outcomes.delete(key)
    else outcomes.set(key, outcome)
    if (episode === undefined && failureOf(outcome) !== before) changed()
  }
  const setTokenStore = (key: string, next: TokenStoreState): void => {
    tokenStores.set(key, { ...tokenStores.get(key), ...next })
    changed()
  }
  return {
    recordRequest: (loginDir, outcome) => { setOutcome(loginDir, outcome) },
    clearRequest: (loginDir) => { setOutcome(loginDir, undefined) },
    recordTokenStoreKind: (loginDir, kind) => { setTokenStore(loginDir, { kind }) },
    recordTokenStoreObservation: (loginDir, observation) => { setTokenStore(loginDir, { observation }) },
    forget: (loginDir) => {
      const episode = episodes.get(loginDir)
      const held = [episodes.delete(loginDir), outcomes.delete(loginDir), tokenStores.delete(loginDir)].includes(true)
      if (episode !== undefined) {
        record(episode, "forgotten")
        for (const waiter of episode.waiters) waiter("declined")
      }
      if (held) changed()
    },
    outcome: (loginDir) => outcomes.get(loginDir),
    failure: (loginDir) => episodes.has(loginDir) ? "login-rejected" : failureOf(outcomes.get(loginDir)),
    tokenStore: (loginDir) => tokenStores.get(loginDir) ?? {},
    observe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    awaitLogin: async (authDir, account, signal) => {
      signal.throwIfAborted()
      const key = account.configDir
      let episode = episodes.get(key)
      const created = episode === undefined
      if (episode === undefined) {
        if (outcomes.get(key) !== "login-rejected") return "renewed"
        episode = { id: crypto.randomUUID(), authDir, account, phase: "asking", waiters: new Set() }
        episodes.set(key, episode)
        record(episode, "asking")
      }
      if (episode.phase === "declined") return "declined"
      const current = episode
      const pending = new Promise<LoginWaitAnswer>((resolve, reject) => {
        const clean = (): void => {
          signal.removeEventListener("abort", abort)
          current.waiters.delete(finish)
        }
        const finish = (answer: LoginWaitAnswer): void => { clean(); resolve(answer) }
        const abort = (): void => { clean(); reject(signal.reason) }
        current.waiters.add(finish)
        signal.addEventListener("abort", abort, { once: true })
      })
      if (created) changed()
      return await pending
    },
    loginQuestions: () => [...episodes.values()].flatMap((episode) => {
      const question = descriptor(episode)
      return question === undefined ? [] : [question]
    }),
    answerLogin: (id, answer) => {
      const episode = find(id)
      if (episode?.phase !== "asking") return undefined
      if (answer === "declined") {
        const question = descriptor(episode)
        settle(episode, answer)
        return question
      }
      episode.phase = "logging-in"
      record(episode, "logging-in")
      changed()
      return descriptor(episode)
    },
    settleLogin: (id, answer) => {
      const episode = find(id)
      if (episode?.phase === "logging-in") settle(episode, answer)
    },
  }
}

/** The step that repairs one failed login, as a person reads it beside the account. It names no account: the
 *  problem also becomes a project notification, whose text must hold no account subject data (ARCH-BOUNDARIES-015). */
function failureMessage(failure: LoginFailure): string {
  switch (failure) {
    case "login-rejected": return `${GOOGLE_ANTIGRAVITY_LABEL} refused this account's login in this profile. Log in again.`
    case "program-exited": return `The ${LOGIN_PROGRAM_LABEL} exited while it served a request of this account. Flywheel starts it again for the next request.`
    case "program-cannot-start": return `The ${LOGIN_PROGRAM_LABEL} that ships with Flywheel cannot start on this machine. Reinstall Flywheel, or run bun run engine:antigravity:prepare in a source checkout.`
  }
}

/** The problems of the logins of one auth profile, with no launch: each account whose last request in this process
 *  failed for its login, because its engine exited, or because its engine could not start. */
export function loginProblems(accounts: readonly ExternalAccount[], observations: LoginObservations): readonly ExternalLoginProblem[] {
  return accounts.flatMap((account) => {
    const failure = observations.failure(account.configDir)
    return failure === undefined ? [] : [{ kind: failure, accountId: account.accountId, message: failureMessage(failure) }]
  })
}

/** How a login's last request in this process ended, as a person reads it. */
function outcomeText(outcome: RequestOutcome | undefined): string {
  switch (outcome) {
    case undefined: return "none yet"
    case "served": return "served"
    case "login-rejected": return "login refused"
    case "program-exited": return "engine exited"
    case "program-cannot-start": return "engine could not start"
  }
}

function tokenStoreKindText(kind: TokenStoreKind | undefined): string {
  switch (kind) {
    case undefined: return "not prepared in this process yet"
    case "private-keychain": return "the login's private keychain in its login folder"
    case "engine-file": return "a file in the login's private home"
    case "credential-manager": return "the Windows Credential Manager"
  }
}

/** What the login's last engine log said about its token store, and whether that needs attention: any keyring call
 *  that failed or waited, which the prepared store makes impossible. */
interface ObservationLine {
  readonly text: string
  readonly attention: boolean
}

function observationText(observation: TokenStoreObservation | undefined): ObservationLine {
  if (observation === undefined) return { text: "no engine log of this login read in this process yet", attention: false }
  const reached = reachedKeyringKinds(observation)
  if (reached.length > 0) return { text: `the engine reached a keyring that it must not use (${reached.join(", ")})`, attention: true }
  if (observation.fileStorageReason !== undefined) return { text: `file storage, because ${observation.fileStorageReason}`, attention: false }
  if (observation.keyringFailures.includes("credential-manager-unavailable")) return { text: "file storage, because the OS credential manager is unavailable", attention: false }
  return { text: "no keyring call failed or waited", attention: false }
}

/** One login directory of a profile, with the account whose record it holds, if any. */
export interface ProfileLogin {
  readonly loginDir: string
  readonly account?: ExternalAccount
}

/**
 * The provider's section of `/doctor`: the engine that ships with Flywheel and its version against the qualified one,
 * and each login directory of the auth profile. A directory that serves an account shows the account, its status,
 * its token store kind and the last thing an engine log said about it, and how its last request in this process
 * ended. Any other directory shows that it holds no login that this release reads. The version is the pinned one
 * when the engine file holds exactly the bytes that the pin states for this platform (`pinned`,
 * `pinnedAntigravityBytes`), so the doctor starts no engine: an engine launch outside a prepared private home could
 * reach the person's keychain. Nothing here reads a token, a secret, or a credential file: whether agy still holds a
 * token is not checked.
 */
export async function antigravityLoginHealth(logins: readonly ProfileLogin[], observations: LoginObservations, options: { readonly enginePath: () => string; readonly pinned: AntigravityPinnedBytes | undefined }): Promise<ModuleHealthReport> {
  const lines: string[] = []
  let attention = false
  let engine: string | undefined
  try {
    engine = options.enginePath()
  } catch (error) {
    attention = true
    lines.push(`The ${LOGIN_PROGRAM_LABEL} cannot start: ${errorMessage(error)}`)
  }
  if (engine !== undefined && options.pinned === undefined) {
    attention = true
    lines.push(`The ${LOGIN_PROGRAM_LABEL} cannot serve: Flywheel pins no ${LOGIN_PROGRAM_LABEL} for this platform.`)
  } else if (engine !== undefined && options.pinned !== undefined) {
    if (await holdsPinnedAntigravityBytes(engine, options.pinned)) {
      lines.push(`${LOGIN_PROGRAM_LABEL}: version ${QUALIFIED_ANTIGRAVITY_VERSION} (the qualified version, its bytes verified against the pin), at ${engine}.`)
    } else {
      attention = true
      lines.push(`The ${LOGIN_PROGRAM_LABEL} at ${engine} cannot serve: it does not hold the bytes of the qualified version ${QUALIFIED_ANTIGRAVITY_VERSION}. Reinstall Flywheel, or run bun run engine:antigravity:prepare in a source checkout.`)
    }
  }
  if (!logins.some((login) => login.account !== undefined)) lines.push(`No ${GOOGLE_ANTIGRAVITY_LABEL} account is logged in to this profile. Log in from Authentication.`)
  for (const { loginDir, account } of logins) {
    if (account === undefined) {
      lines.push(`Login folder ${loginDir} holds no ${GOOGLE_ANTIGRAVITY_LABEL} login that this release reads.`)
      continue
    }
    const failure = observations.failure(loginDir)
    const store = observations.tokenStore(loginDir)
    const observation = observationText(store.observation)
    if (failure !== undefined || observation.attention) attention = true
    lines.push(
      `${account.identity}: ${failure === undefined ? "logged in, as far as this process observed" : failureMessage(failure)}`,
      `${account.identity} login folder: ${loginDir}. Token store: ${tokenStoreKindText(store.kind)}; last observation: ${observation.text}. Token presence: not checked (Flywheel reads no Antigravity credential). Last request in this process: ${outcomeText(observations.outcome(loginDir))}.`,
    )
  }
  return { attention, lines }
}
