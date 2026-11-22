import type { FirstPartyModule } from "../../modules.js"

/** The Google Antigravity provider. It contributes nothing until its provider
 *  registration lands; then it claims a credential provider id and moves to
 *  `CREDENTIAL_PROVIDER_MODULES`. The startup catalog loads this file, so it
 *  imports nothing but types. */
export const googleAntigravityModule = {
  id: "provider-google-antigravity",
  dependencies: [],
  contributions: [],
} as const satisfies FirstPartyModule
