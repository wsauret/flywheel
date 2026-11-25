/** The identity of a client bundle: a hex SHA-256 the build writes beside the
 *  bundle and into every page that loads it. It is its own module because the
 *  relay Worker and the phone's hosted page decode it too, and neither may
 *  pull the runtime protocol's schemas into its bundle to do so. */
export const CLIENT_IDENTITY_PATTERN = /^[0-9a-f]{64}$/
