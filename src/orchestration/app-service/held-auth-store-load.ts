import { Redacted } from "effect"
import { AUTH_STORE_FILE, loadAuthStoreWithDiagnostics, type AuthStoreLoadResult } from "../../infra/auth/auth-store.js"
import { deepFreeze } from "../../infra/deep-freeze.js"
import { customProviderGeneration } from "../../infra/llm/custom-provider-registry.js"
import { heldDirectoryDerivation } from "../../infra/watched-directory-values.js"
import { installedCredentialProviderIds, installedCredentialSlotClassifier } from "../credential-provider-modules.js"

// A refusal can heal with no change to auth.json or the profile directory, such as a parent restored in place, so it is never held.
const HELD_AUTH_STORE_LOAD = heldDirectoryDerivation<Redacted.Redacted<AuthStoreLoadResult>>([AUTH_STORE_FILE], {
  holds: (load) => !Redacted.value(load).conditions.some((condition) => condition.kind === "refused"),
})

/** What `loadAuthStoreWithDiagnostics` observes in the profile `directory` with the live credential vocabulary.
 *  Every request capture resolves the profile's auth, so the load is held while the profile's watch confirms it.
 *  The held load carries credentials, so it is held redacted, and every request shares it, so it is frozen.
 *  A [custom_providers] edit changes the vocabulary that decodes the file, so the custom-provider generation is an input. */
export function heldAuthStoreLoad(directory: string): AuthStoreLoadResult {
  return Redacted.value(HELD_AUTH_STORE_LOAD.read(
    directory,
    () => Redacted.make(deepFreeze(loadAuthStoreWithDiagnostics(directory, installedCredentialProviderIds(), installedCredentialSlotClassifier(), false))),
    String(customProviderGeneration()),
  ))
}
