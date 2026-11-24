const RELEASE_HARNESS_ID = "account-service-isolation-v1"

type Environment = { readonly [name: string]: string | undefined }

/** The release harness's isolated hub, as the environment states it. A
 *  normal launch states none, and its hub binds the lane's fixed port. Under
 *  the harness the hub binds an ephemeral port, so it never collides with the
 *  person's own service, and writes its origin to `record` when one is named.
 *  A port override without the exact harness identity, or with any port but
 *  0, throws instead of changing a production launch. */
export function releaseHarnessHub(env: Environment): { readonly record: string | undefined } | undefined {
  const port = env.FLYWHEEL_INTERNAL_RELEASE_HUB_PORT
  const record = env.FLYWHEEL_INTERNAL_RELEASE_HUB_RECORD
  if (port === undefined && record === undefined) return undefined
  if (env.FLYWHEEL_INTERNAL_RELEASE_HARNESS !== RELEASE_HARNESS_ID) {
    throw new Error("isolated hub binding is reserved for the release performance harness")
  }
  if (port !== "0") throw new Error("the release performance harness hub must use an ephemeral port")
  return { record }
}
