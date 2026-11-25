/** The serving backend a client shows: what the account service's identity
 *  record names at attach, and what each snapshot states after it. */
export interface RuntimeIdentity {
  readonly version: string
  /** The runtime's build identifier, or null when the runtime cannot name one. */
  readonly buildId: string | null
}

const BUILD_PREFIX_LENGTH = 8

/** The identity text of the welcome card: `v0.0.10`, or with the project's
 *  Show build setting on `v0.0.10 build 3029f1ab`, or `v0.0.10 build
 *  unavailable` when the runtime names no build. Undefined before the first
 *  identity read: the client's own version says nothing about the backend. */
export function formatRuntimeIdentity(identity: RuntimeIdentity | undefined, showBuild: boolean): string | undefined {
  if (identity === undefined) return undefined
  const version = `v${identity.version}`
  if (!showBuild) return version
  return `${version} build ${identity.buildId === null ? "unavailable" : identity.buildId.slice(0, BUILD_PREFIX_LENGTH)}`
}
