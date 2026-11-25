import { loadAuthStoreWithDiagnostics, type AuthStoreLoadResult } from "../../src/infra/auth/store/auth-store.js"
import { credentialSlotClassifier, type FirstPartyModuleSnapshot } from "../../src/orchestration/module-contract/module-catalog.js"
import { installedCredentialProviderIds } from "../../src/orchestration/module-contract/module-composition.js"

/** The auth observation an eligibility preparation reads: the profile's auth
 *  store as it is on disk, with no auth-condition owner to tell. A test that
 *  asserts on the observation passes its own. */
export function diskAuthObservation(moduleSelection: FirstPartyModuleSnapshot): (profile: { readonly directory: string }) => AuthStoreLoadResult {
  return (profile) => loadAuthStoreWithDiagnostics(profile.directory, installedCredentialProviderIds(), credentialSlotClassifier(moduleSelection()), false)
}
