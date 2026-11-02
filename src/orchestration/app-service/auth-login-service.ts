import { randomUUID } from "node:crypto"
import { Redacted } from "effect"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import { errorMessage } from "../../infra/error-message.js"
import type { ExternalUrlOpener } from "../../infra/open-external-url.js"
import type { OperationLogger } from "../../infra/operation-log.js"
import { disconnectProviderInstance, LoginRefusedError, loginWithApiKey, logoutProvider, reconnectWithApiKey, renameProviderInstance, type AuthCatalogSettlement, type ProviderOAuthLogin } from "../auth/auth-actions.js"

import type { AuthOperationNotice, AuthOperationSettlement, AuthProviderStatus } from "../../protocol/auth-status-protocol-types.js"
import type { RuntimeAuthLoginMutation, RuntimeAuthLoginResult } from "../../protocol/auth-login-protocol-types.js"
import type { CapabilityGrant, ModulePolicy } from "../config/module-policy.js"
import { installedModules } from "../module-catalog.js"
import { canonicalModuleIds } from "../../protocol/module-ids.js"
import { isExternalLoginDefinition, type ExternalLoginDefinition, type ExternalLoginQuestion, type OAuthLoginPrompt } from "../../infra/llm/access-provider.js"
import { installedAccessProviderDefinitions } from "../credential-provider-modules.js"

type LoginRecovery = Pick<ExternalLoginDefinition["auth"], "loginQuestions" | "answerLogin" | "settleLogin">

/** The owned profile a request writes: its id keys publication, and its
 *  directory holds the credentials. */
interface LoginProfile {
  readonly id: string
  readonly directory: string
}

interface LoginOperation {
  readonly operationId: string
  readonly providerId: string
  readonly profile: LoginProfile
  readonly controller: AbortController
  readonly recovery?: { readonly owner: LoginRecovery; readonly question: ExternalLoginQuestion }
  browserInput?: { readonly promise: Promise<string>; readonly resolve: (value: string) => void }
  /** The flow's pre-flight question, waiting for `auth.login.answer`. */
  prompt?: (answer: string) => void
  /** The request that waits for this operation's next step. Each step answers
   *  it once; a later step goes to the request that answered the prompt. */
  answer?: (result: RuntimeAuthLoginResult) => boolean
}

/** Runs every provider login, disconnect, and rename for every client.
 *
 *  The login operations already take their prompts, their browser, and their
 *  cancellation as ports, so this supplies a different set rather than a second
 *  authentication path. Nothing here reimplements a flow: each OAuth provider
 *  declares its flow on its definition, and this service dispatches through
 *  that declaration, so adding a provider never edits this file.
 *
 *  The ports carry a browser only when the client says the person is at this
 *  machine. The client can be a phone on another network, so a page that
 *  opened on this machine would open where the person is not; such a client
 *  opens each reported page in its own host instead.
 *
 *  The two long flows do not block the answer. A device code is worthless to a
 *  user who cannot see it yet, and a browser flow's URL is worthless after the
 *  window closed, so both are reported the moment they exist and the flow
 *  carries on behind them. The flow's progress messages and its one end are
 *  published on the `auth` cursor, which already carries the whole provider
 *  view, so no client has to poll and no second notion of done exists. */

export interface AuthLoginServiceOptions {
  /** The owned profile a request names, or the active profile when it names
   *  none. Undefined for a profile this runtime does not own. */
  readonly resolveProfile: (profileId?: string) => LoginProfile | undefined
  readonly resolveKey: KeyResolver
  /** Runs the program that owns an external login. */
  readonly launcher: LauncherScope
  /** Opens a sign-in page in a browser on this machine. */
  readonly openBrowser: ExternalUrlOpener
  /** Republishes one profile's auth view after a disconnect or rename. */
  readonly refresh: (profileId: string) => Promise<void>
  /** Publishes the progress, a question, or the end of a long login on its profile's
   *  scopes, or on every scope for a login that answered a project-wide
   *  account question. */
  readonly publishNotice: (notice: AuthOperationNotice, target: { readonly profileId: string; readonly question: boolean }) => Promise<void>
  /** Resolves only a provider-captured directory owned by this project runtime. */
  readonly resolveLoginProfile?: (directory: string) => LoginProfile | undefined
  /** Tests can supply an isolated provider owner; production reads the installed catalog. */
  readonly recovery?: (providerId: string) => LoginRecovery | undefined
  /** Confirms a stored credential can serve a model catalog before success
   *  is reported, the same settlement the headless CLI login runs. */
  readonly settleCatalog: (grant: CapabilityGrant) => AuthCatalogSettlement
  /** Admission rereads the durable module selection before any flow or write. */
  readonly admit: ModulePolicy["admit"]
  /** Reads credentials and provider metadata of one profile directory from the
   *  admitted selection, not the display projection. */
  readonly providers: (grant: CapabilityGrant, authDirectory: string) => Promise<readonly AuthProviderStatus[]>
  /** The OAuth login one provider's definition declares. Undefined for
   *  API-key providers and unknown ids. */
  readonly loginFlows: (providerId: string) => ProviderOAuthLogin | undefined
  readonly log: OperationLogger
}

/** What a client asks of one login: the `auth.login` mutation without its type. */
type AuthLoginRequest = Omit<RuntimeAuthLoginMutation, "type">

export interface AuthLoginService {
  /** `instanceId` names an existing account to reconnect. Absent, this adds a
   *  new one, which the credential store refuses if that identity is already
   *  stored. With `loginQuestionId`, the provider owner admits one answer and supplies the account and profile;
   *  a stale answer returns ignored without starting or replacing a flow. */
  login(request: AuthLoginRequest): Promise<RuntimeAuthLoginResult>
  /** Answers the pre-flight question of the active operation and returns the
   *  flow's next step. A stale operation returns ignored. */
  answerPrompt(providerId: string, operationId: string, answer: string): Promise<RuntimeAuthLoginResult>
  /** Declines only an unanswered episode. A stale answer has no effect. */
  decline(providerId: string, loginQuestionId: string): Promise<void>
  /** Supplies the callback URL or code for the active browser flow. Returns
   *  false when the operation is stale or is not waiting for browser input. */
  completeBrowserLogin(operationId: string, input: Redacted.Redacted<string>): boolean
  /** Abandons the matching flow. Omitted scope retains manual replacement; automatic clients send their episode. */
  cancel(reason?: string, scope?: { readonly loginQuestionId?: string; readonly operationId?: string }): Promise<void>
  /** Removes one account's credential, or the provider's only credential when
   *  no account is named, from the named or active profile. */
  disconnect(request: { readonly providerId: string; readonly instanceId?: string; readonly profileId?: string }): Promise<void>
  /** Sets the label a person gave an account; an empty label clears it. */
  rename(request: { readonly providerId: string; readonly instanceId: string; readonly label?: string; readonly profileId?: string }): Promise<void>
  dispose(): void
}

const PROFILE_UNAVAILABLE = "The auth profile is no longer available."
const CREDENTIAL_CHANGED = "credentials changed before reconnect completed"

export function createAuthLoginService(options: AuthLoginServiceOptions): AuthLoginService {
  // One at a time. Two concurrent flows would race to append a credential for
  // the same provider, and the second would appear to succeed while overwriting
  // the first.
  let outstanding: LoginOperation | undefined
  const recoveryFor = options.recovery ?? ((providerId: string) =>
    installedAccessProviderDefinitions().filter(isExternalLoginDefinition).find(({ id }) => id === providerId)?.auth)
  const isCurrent = (operation: LoginOperation): boolean => outstanding === operation
    && !operation.controller.signal.aborted
    && (operation.recovery === undefined || operation.recovery.owner.loginQuestions().some((question) =>
      question.id === operation.recovery?.question.id && question.phase === "logging-in"))
  const publish = (operation: LoginOperation, notice: AuthOperationNotice): Promise<void> =>
    options.publishNotice(notice, { profileId: operation.profile.id, question: operation.recovery !== undefined })
  /** Publishes the end of a long login, which its client waits for on the
   *  auth cursor. A completion that cannot be published is published as a
   *  failure that says why, so no client waits for an end that never comes. */
  const settle = async (operation: LoginOperation, settlement: AuthOperationSettlement): Promise<void> => {
    try {
      await publish(operation, settlement)
    } catch (cause) {
      options.log.info("provider login settlement not published", { providerId: operation.providerId, settlement: settlement.kind })
      if (settlement.kind === "completed") {
        await settle(operation, { kind: "failed", operationId: operation.operationId, providerId: operation.providerId, message: `The account is saved, but Flywheel could not show it: ${errorMessage(cause)}` })
      }
    }
  }
  const requireProfile = (profileId: string | undefined): LoginProfile => {
    const profile = options.resolveProfile(profileId)
    if (profile === undefined) throw new Error(PROFILE_UNAVAILABLE)
    return profile
  }

  /** The operation's next step, as the request that waits for it receives it. */
  const nextStep = (operation: LoginOperation): Promise<RuntimeAuthLoginResult> => new Promise((resolve) => {
    const answer = (result: RuntimeAuthLoginResult): boolean => {
      if (operation.answer !== answer) return false
      delete operation.answer
      resolve(result)
      return true
    }
    operation.answer = answer
  })
  const answerStep = (operation: LoginOperation, result: RuntimeAuthLoginResult): boolean => operation.answer?.(result) ?? false

  const abandon = () => {
    const current = outstanding
    if (current === undefined) return undefined
    outstanding = undefined
    current.controller.abort()
    current.recovery?.owner.settleLogin(current.recovery.question.id, "declined")
    answerStep(current, { kind: "failed", operationId: current.operationId, providerId: current.providerId, message: "Sign-in cancelled." })
    return current
  }

  const cancel = async (reason?: string, scope?: { readonly loginQuestionId?: string; readonly operationId?: string }): Promise<void> => {
    if (scope?.loginQuestionId !== undefined && outstanding?.recovery?.question.id !== scope.loginQuestionId) return
    if (scope?.operationId !== undefined && outstanding?.operationId !== scope.operationId) return
    const current = abandon()
    if (current === undefined) return
    if (reason !== undefined || current.recovery !== undefined) {
      await settle(current, { kind: "failed", operationId: current.operationId, providerId: current.providerId, message: reason ?? "Sign-in cancelled." })
    }
  }

  const begin = (providerId: string, profile: LoginProfile, recovery?: LoginOperation["recovery"]): LoginOperation => {
    void cancel("Another sign-in replaced this one.")
    const operation: LoginOperation = { operationId: randomUUID(), providerId, profile, controller: new AbortController(), ...(recovery === undefined ? {} : { recovery }) }
    outstanding = operation
    return operation
  }

  /** Answers the flow's pre-flight question through the request that waits,
   *  and waits for the person's answer from `auth.login.answer`. */
  const askPrompt = (operation: LoginOperation, prompt: OAuthLoginPrompt): Promise<string> => {
    if (!isCurrent(operation)) return Promise.reject(new Error("Login cancelled"))
    const reply = Promise.withResolvers<string>()
    operation.prompt = reply.resolve
    operation.controller.signal.addEventListener("abort", () => { delete operation.prompt; reply.reject(new Error("Login cancelled")) }, { once: true })
    answerStep(operation, {
      kind: "prompt", operationId: operation.operationId, providerId: operation.providerId,
      prompt: { message: prompt.message, ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }), ...(prompt.allowEmpty === undefined ? {} : { allowEmpty: prompt.allowEmpty }) },
    })
    return reply.promise
  }

  /** Asks the person on the auth cursor whether a paid account replaces the free-plan accounts of its provider. The
   *  first step of the flow has already gone out, so the question is a notice, and `auth.login.answer` confirms it.
   *  `auth.login.cancel` declines: it stops the flow, and nothing is stored. */
  const askConfirmation = (operation: LoginOperation, message: string): Promise<boolean> => {
    if (!isCurrent(operation)) return Promise.reject(new Error("Login cancelled"))
    const reply = Promise.withResolvers<string>()
    operation.prompt = reply.resolve
    operation.controller.signal.addEventListener("abort", () => { delete operation.prompt; reply.reject(new Error("Login cancelled")) }, { once: true })
    void publish(operation, { kind: "confirmation", operationId: operation.operationId, providerId: operation.providerId, message })
      .catch(() => {
        options.log.info("provider login question not published", { providerId: operation.providerId })
        delete operation.prompt
        reply.reject(new Error("Flywheel could not ask whether the new account replaces the free-plan account. Nothing was stored."))
      })
    return reply.promise.then(() => true)
  }

  /** Drives a long flow to its end after its first step has already gone out.
   *
   *  Flat on purpose: the failure path has to be able to answer, because a flow
   *  that fails before it ever produced a code or a URL has produced nothing for
   *  the client to wait on. */
  const drive = async (operation: LoginOperation, flow: Promise<unknown>): Promise<void> => {
    const { providerId, operationId, recovery } = operation
    try {
      // A reconnect reports whether the account still held the credential it started from.
      if (await flow === false) throw new Error(CREDENTIAL_CHANGED)
      if (outstanding !== operation || operation.controller.signal.aborted) return
      options.log.info("provider login completed", { providerId })
      outstanding = undefined
      recovery?.owner.settleLogin(recovery.question.id, "renewed")
      // The end also republishes the provider view.
      await settle(operation, { kind: "completed", operationId, providerId })
      answerStep(operation, { kind: "completed", providerId })
    } catch (cause) {
      if (outstanding !== operation || operation.controller.signal.aborted) return
      const message = errorMessage(cause)
      options.log.info("provider login did not complete", { providerId })
      outstanding = undefined
      recovery?.owner.settleLogin(recovery.question.id, "declined")
      if (!answerStep(operation, { kind: "failed", operationId, providerId, message })) await settle(operation, { kind: "failed", operationId, providerId, message, ...(cause instanceof LoginRefusedError ? { refused: true } : {}) })
    } finally {
      if (outstanding?.operationId === operationId) outstanding = undefined
    }
  }

  async function login(request: AuthLoginRequest): Promise<RuntimeAuthLoginResult> {
    const { providerId, apiKey, loginQuestionId } = request
    let instanceId = request.instanceId
    let operation: LoginOperation | undefined
    let profile: LoginProfile
    if (loginQuestionId !== undefined) {
      const owner = recoveryFor(providerId)
      const question = owner?.answerLogin(loginQuestionId, "renewed")
      if (question === undefined || owner === undefined) return { kind: "ignored", providerId }
      const captured = options.resolveLoginProfile?.(question.authDir)
      if (captured === undefined) {
        owner.settleLogin(question.id, "declined")
        return { kind: "failed", providerId, message: "The account's auth profile is no longer available." }
      }
      instanceId = question.account.accountId
      profile = { id: captured.id, directory: question.authDir }
      operation = begin(providerId, profile, { owner, question })
    } else {
      const requested = options.resolveProfile(request.profileId)
      if (requested === undefined) return { kind: "failed", providerId, message: PROFILE_UNAVAILABLE }
      profile = requested
    }
    const fail = (result: RuntimeAuthLoginResult): RuntimeAuthLoginResult => {
      if (operation !== undefined && outstanding === operation) {
        operation.recovery?.owner.settleLogin(operation.recovery.question.id, "declined")
        outstanding = undefined
      }
      return result
    }
    try {
      // Custom providers have no selectable module: their config entry is their enablement.
      const required = canonicalModuleIds(installedModules().flatMap((module) => module.contributions.some(
        (entry) => (entry.domain === "providers" || entry.domain === "webAuthProviders") && entry.id === providerId,
      ) ? [module.id] : []))
      const admission = await options.admit({ operation: `Connect provider ${providerId}`, required })
      if (operation !== undefined && !isCurrent(operation)) return fail({ kind: "ignored", providerId })
      if (!admission.ok) {
        options.log.info("provider login refused", { providerId, missingModuleIds: admission.missing })
        return fail({ kind: "unsupported", providerId, detail: admission.reason })
      }
      const provider = (await options.providers(admission.grant, profile.directory)).find((candidate) => candidate.providerId === providerId)
      if (operation !== undefined && !isCurrent(operation)) return fail({ kind: "ignored", providerId })
      if (!provider) {
        return fail({ kind: "unsupported", providerId, detail: "This runtime has no such provider installed." })
      }

      const settleCatalog = options.settleCatalog(admission.grant)

      // Reconnecting an account and adding one are different operations, and
      // the credential store enforces it: appending a credential whose identity
      // already exists throws. A lapsed subscription is the common case - the
      // user is signing in as themselves again, not adding a second account -
      // and without this the flow completes against the provider and is then
      // refused on the way to disk, which reads as the login hanging forever.
      const reconnecting = instanceId !== undefined
        && provider.accounts.some((account) => account.instanceId === instanceId)
      if (operation !== undefined && !reconnecting) return fail({ kind: "failed", providerId, message: "This account is no longer available." })

      if (provider.loginMethod === "api-key") {
        // The one unwrap on this path: the key was wrapped by the wire codec
        // and stays Redacted until this crossing into the credential store.
        const key = apiKey === undefined ? undefined : Redacted.value(apiKey)
        if (key === undefined || key.trim().length === 0) {
          // Said rather than assumed: the client should not be deriving which
          // providers take a secret from the provider id.
          return { kind: "needs_key", providerId, displayName: provider.displayName }
        }
        try {
          if (reconnecting && instanceId !== undefined) {
            if (!await reconnectWithApiKey(providerId, instanceId, key, profile.directory, options.resolveKey, settleCatalog)) throw new Error(CREDENTIAL_CHANGED)
          } else {
            await loginWithApiKey(providerId, key, profile.directory, options.resolveKey, undefined, settleCatalog)
          }
          return { kind: "completed", providerId }
        } catch (cause) {
          return { kind: "failed", providerId, message: errorMessage(cause) }
        }
      }

      const registered = options.loginFlows(providerId)
      if (registered === undefined) {
        return fail({ kind: "unsupported", providerId, detail: `Provider ${providerId} registers no protocol login flow.` })
      }

      const active = operation ?? begin(providerId, profile)
      const first = nextStep(active)
      const ports = {
        authDir: profile.directory, profileId: profile.id, resolveKey: options.resolveKey, launcher: options.launcher, signal: active.controller.signal, settle: settleCatalog,
        confirmReplace: (question: string) => askConfirmation(active, question),
        ...(loginQuestionId === undefined ? {} : { loginQuestionId }),
        ...(request.openBrowser === true ? { openBrowser: options.openBrowser } : {}),
        // Best effort: a message that does not reach the client changes nothing the login does.
        onProgress: (message: string) => {
          if (isCurrent(active)) void publish(active, { kind: "progress", operationId: active.operationId, providerId, message }).catch(() => options.log.info("provider login progress not published", { providerId }))
        },
      }
      const reconnectId = reconnecting ? instanceId : undefined
      if (registered.flow === "device-code") {
        const deviceCodePorts = {
          ...ports,
          onPrompt: (prompt: OAuthLoginPrompt) => askPrompt(active, prompt),
          onUserCode: (instructions: { userCode?: string; url: string }) => {
            if (isCurrent(active)) answerStep(active, { kind: "device_code", operationId: active.operationId, providerId, ...(instructions.userCode === undefined ? {} : { userCode: instructions.userCode }), verificationUri: instructions.url })
          },
        }
        const flow = reconnectId === undefined ? registered.login(deviceCodePorts) : registered.reconnect(reconnectId, deviceCodePorts)
        void drive(active, flow)
        return await first
      }

      const browserInput = Promise.withResolvers<string>()
      active.browserInput = browserInput
      const browserPorts = {
        ...ports,
        onAuthorizeUrl: (instructions: { url: string }) => {
          if (isCurrent(active)) answerStep(active, { kind: "browser", operationId: active.operationId, providerId, authorizeUri: instructions.url })
        },
        onManualCodeInput: () => browserInput.promise,
      }
      const flow = reconnectId === undefined ? registered.login(browserPorts) : registered.reconnect(reconnectId, browserPorts)
      void drive(active, flow)
      return await first
    } catch (cause) {
      return fail({ kind: "failed", providerId, message: errorMessage(cause) })
    }
  }

  return {
    login,
    cancel,
    async answerPrompt(providerId, operationId, answer) {
      const current = outstanding
      const reply = current?.operationId === operationId ? current.prompt : undefined
      if (current === undefined || reply === undefined) return { kind: "ignored", providerId }
      delete current.prompt
      const next = nextStep(current)
      reply(answer)
      return await next
    },

    async decline(providerId, loginQuestionId) {
      recoveryFor(providerId)?.answerLogin(loginQuestionId, "declined")
    },

    dispose() {
      abandon()
    },

    completeBrowserLogin(operationId, input) {
      const current = outstanding
      if (current?.operationId !== operationId || current.browserInput === undefined) return false
      const inputPort = current.browserInput
      delete current.browserInput
      inputPort.resolve(Redacted.value(input))
      return true
    },

    async disconnect({ providerId, instanceId, profileId }) {
      const profile = requireProfile(profileId)
      if (instanceId === undefined) await logoutProvider(providerId, profile.directory, options.resolveKey, { launcher: options.launcher })
      else await disconnectProviderInstance(providerId, instanceId, profile.directory, { launcher: options.launcher })
      await options.refresh(profile.id)
    },

    async rename({ providerId, instanceId, label, profileId }) {
      const profile = requireProfile(profileId)
      const trimmed = label?.trim()
      await renameProviderInstance(providerId, instanceId, trimmed === undefined || trimmed.length === 0 ? undefined : trimmed, profile.directory)
      await options.refresh(profile.id)
    },
  }
}
