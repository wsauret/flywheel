import type { RuntimeAuthLoginPrompt, RuntimeAuthLoginResult } from "../auth-login-protocol-types.js"
import type { AuthProviderStatus, RuntimeAuthView } from "../auth-status-protocol-types.js"

/** Connecting a provider from a client, step by step.
 *
 *  The runtime runs the flow and reports what the client has to show, because
 *  which shape a provider needs is a fact the runtime owns and not one a
 *  client should infer from a provider id: a key provider asks for a secret, a
 *  flow with a pre-flight question asks it, a device-code provider hands over
 *  a code and a page, a browser provider hands over a page. A flow that
 *  continues after the answer settles on the `auth` cursor, which already
 *  publishes the whole provider view, so every client watches that view for
 *  the settlement rather than polling. The terminal and the web client both
 *  read the runtime's answers through this module. */

/** What a login step shows of its provider. Only choosing an account reads the provider's accounts, so every other
 *  step needs no more than the provider's id and name, which an account question also carries. A login that answers
 *  an account question names that account and profile in `lead`. */
export type LoginTarget = Pick<AuthProviderStatus, "providerId" | "displayName"> & { readonly lead?: string }

export type LoginStep =
  /** An account is connected, and signing in again as one of them is a
   *  different operation from adding another. */
  | { readonly kind: "choose-account"; readonly provider: AuthProviderStatus }
  /** `message` says what the runtime does while the client waits, when it is more than starting the login. */
  | { readonly kind: "working"; readonly provider: LoginTarget; readonly instanceId?: string; readonly message?: string }
  | { readonly kind: "needs-key"; readonly provider: LoginTarget; readonly hint?: string; readonly instanceId?: string }
  /** The flow asks this before it starts; `auth.login.answer` answers it. */
  | { readonly kind: "prompt"; readonly provider: LoginTarget; readonly operationId: string; readonly prompt: RuntimeAuthLoginPrompt }
  | { readonly kind: "device-code"; readonly provider: LoginTarget; readonly operationId: string; readonly userCode?: string; readonly verificationUri: string }
  | { readonly kind: "browser"; readonly provider: LoginTarget; readonly operationId: string; readonly authorizeUri: string }
  /** The person signed in, and the runtime asks before it stores the account: `auth.login.answer` confirms and
   *  `auth.login.cancel` declines. */
  | { readonly kind: "confirm"; readonly provider: LoginTarget; readonly operationId: string; readonly message: string }

export type LoginOutcome =
  | { readonly kind: "ignored" }
  | { readonly kind: "step"; readonly step: LoginStep }
  | { readonly kind: "connected"; readonly provider: LoginTarget }
  | { readonly kind: "failed"; readonly provider: LoginTarget; readonly message: string }

/** Where connecting `provider` starts. With no account, the login adds one.
 *  A lapsed subscription is the common case and takes no question: its one
 *  signed-out account logs in again. Any other provider with an account asks
 *  which account this login is for, because only that question offers adding
 *  another one. */
export function initialLoginStep(provider: AuthProviderStatus): Extract<LoginStep, { kind: "choose-account" | "working" }> {
  const [only, ...others] = provider.accounts
  if (only === undefined) return { kind: "working", provider }
  if (others.length === 0 && only.expired) return { kind: "working", provider, instanceId: only.instanceId }
  return { kind: "choose-account", provider }
}

/** What the runtime's answer to a login, or to its prompt, means for the client. */
export function loginOutcome(result: RuntimeAuthLoginResult, provider: LoginTarget, instanceId: string | undefined): LoginOutcome {
  const instance = instanceId === undefined ? {} : { instanceId }
  switch (result.kind) {
    case "ignored": return { kind: "ignored" }
    case "completed":
      return { kind: "connected", provider }
    case "needs_key":
      return { kind: "step", step: { kind: "needs-key", provider, ...(result.hint === undefined ? {} : { hint: result.hint }), ...instance } }
    case "prompt":
      return { kind: "step", step: { kind: "prompt", provider, operationId: result.operationId, prompt: result.prompt } }
    case "device_code":
      return { kind: "step", step: { kind: "device-code", provider, operationId: result.operationId, ...(result.userCode === undefined ? {} : { userCode: result.userCode }), verificationUri: result.verificationUri } }
    case "browser":
      return { kind: "step", step: { kind: "browser", provider, operationId: result.operationId, authorizeUri: result.authorizeUri } }
    case "unsupported":
      return { kind: "failed", provider, message: result.detail }
    case "failed":
      return { kind: "failed", provider, message: result.message }
  }
}

/** Returns the exact ordered patch that ends a login operation. */
export function loginSettlement(auth: RuntimeAuthView | undefined, operationId: string): RuntimeAuthView["settlement"] {
  return auth?.settlement?.operationId === operationId ? auth.settlement : undefined
}

/** The question that a login operation asks on the `auth` cursor after the person signed in, as the step that shows
 *  it, or undefined when the view asks none for `operationId`. */
export function loginConfirmation(auth: RuntimeAuthView | undefined, provider: LoginTarget, operationId: string): Extract<LoginStep, { kind: "confirm" }> | undefined {
  const asked = auth?.confirmation
  return asked?.operationId === operationId ? { kind: "confirm", provider, operationId, message: asked.message } : undefined
}

/** What every client says when the person keeps the free-plan account instead of the paid account that would replace
 *  it (PI-MODEL-069). It is an outcome the person chose, not a failure. */
export function keptFreePlanMessage(displayName: string): string {
  return `${displayName} was not connected, and the free-plan account stays. Nothing was stored.`
}

/** What every client shows after the person chose to replace the free-plan account, until the login ends. */
export const REPLACING_FREE_PLAN = "Replacing the free-plan account…"

/** A step of a login operation that lives in the runtime: its settlement on
 *  the `auth` cursor ends it, and cancelling it tells the runtime to stop the
 *  flow. */
export function awaitsSettlement(step: LoginStep | undefined): step is Extract<LoginStep, { kind: "prompt" | "device-code" | "browser" | "confirm" }> {
  return step?.kind === "prompt" || step?.kind === "device-code" || step?.kind === "browser" || step?.kind === "confirm"
}
