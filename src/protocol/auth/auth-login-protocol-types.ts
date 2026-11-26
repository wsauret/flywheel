import type { Redacted } from "effect"

/** Connecting a provider, over the protocol.
 *
 *  Every client connects, disconnects, and renames accounts through these
 *  mutations, and the runtime that serves the session owns every credential
 *  write. A client therefore changes only the auth of the runtime it is
 *  attached to, never that of the machine it runs on.
 *
 *  The login operations take their prompts and their browser as ports, so
 *  each client drives the same flows. What a client must supply differs by
 *  provider, and the runtime says so explicitly rather than leaving the client
 *  to infer it from a provider id:
 *
 *  - an API key provider answers `needs_key`, and the client asks for a secret
 *    and dispatches again with it;
 *  - a device-code provider answers `device_code` with what to display, and
 *    keeps working in the background;
 *  - a browser provider answers `browser` with the page to sign in on;
 *  - a flow that asks a question before it starts, such as the GitHub
 *    Enterprise domain, answers `prompt`, and the client's
 *    `auth.login.answer` gets the flow's next step.
 *
 *  A flow that continues after the answer completes on the `auth` cursor, which
 *  already publishes the full provider view. No client polls, and no second
 *  notion of "is it done yet" is invented. */

/** Starts or restarts one provider login. */
export interface RuntimeAuthLoginMutation {
  readonly type: "auth.login"
  readonly providerId: string
  /** The key is Redacted from the moment the wire codec decodes the frame: no
   *  plain-string secret exists in a decoded mutation, so a logged or traced
   *  payload can only ever show the redacted placeholder. */
  readonly apiKey?: Redacted.Redacted<string>
  /** An existing account to log in again. Absent, the login adds an account. */
  readonly instanceId?: string
  /** Answers one account question; the question names the profile and account. */
  readonly loginQuestionId?: string
  /** The profile the client shows, which receives the credential. Absent, the
   *  runtime's active profile receives it. */
  readonly profileId?: string
  /** The person is at the runtime's machine, so the runtime opens each sign-in
   *  page in a browser there, and a flow whose program takes its own callback
   *  completes without a pasted code. Absent, the client opens each reported
   *  page in its own host, and nothing opens on the runtime's machine. */
  readonly openBrowser?: true
}

/** A question a login flow asks before it starts. */
export interface RuntimeAuthLoginPrompt {
  readonly message: string
  readonly placeholder?: string
  /** An empty answer takes the flow's default, such as github.com. */
  readonly allowEmpty?: boolean
}

export type RuntimeAuthLoginResult =
  /** Another client answered this episode, or the condition has cleared. */
  | { readonly kind: "ignored"; readonly providerId: string }
  /** Stored. The `auth` cursor carries the new status. */
  | { readonly kind: "completed"; readonly providerId: string; readonly identity?: string }
  /** This provider authenticates with a secret the client must collect. */
  | { readonly kind: "needs_key"; readonly providerId: string; readonly displayName: string; readonly hint?: string }
  /** Show this code, send them to this URL. The flow runs on until they finish
   *  or it times out. */
  | { readonly kind: "device_code"; readonly operationId: string; readonly providerId: string; readonly userCode?: string; readonly verificationUri: string }
  /** The flow waits for the person's answer to this question. */
  | { readonly kind: "prompt"; readonly operationId: string; readonly providerId: string; readonly prompt: RuntimeAuthLoginPrompt }
  /** The page to sign in on. The flow runs on until the callback lands or the
   *  client supplies the page's code. */
  | { readonly kind: "browser"; readonly operationId: string; readonly providerId: string; readonly authorizeUri: string }
  | { readonly kind: "unsupported"; readonly providerId: string; readonly detail: string }
  | { readonly kind: "failed"; readonly providerId: string; readonly operationId?: string; readonly message: string }
