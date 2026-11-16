import { loadAuthStoreWithDiagnostics, type AuthStoreLoadResult } from "../../src/infra/auth/auth-store.js"
import { credentialSlotClassifier } from "../../src/orchestration/auth/credential-slot-classifier.js"
import { installedCredentialProviderIds } from "../../src/orchestration/credential-provider-modules.js"
import type { FirstPartyModuleSnapshot } from "../../src/orchestration/modules.js"

/** The auth observation an eligibility preparation reads: the profile's auth
 *  store as it is on disk, with no auth-condition owner to tell. A test that
 *  asserts on the observation passes its own. */
export function diskAuthObservation(moduleSelection: FirstPartyModuleSnapshot): (profile: { readonly directory: string }) => AuthStoreLoadResult {
  return (profile) => loadAuthStoreWithDiagnostics(profile.directory, installedCredentialProviderIds(), credentialSlotClassifier(moduleSelection()), false)
}
