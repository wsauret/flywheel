import { currentCredentialLineage } from "../../src/infra/auth/auth-context.js";
import type { AuthProfileAccess } from "../../src/infra/auth/auth-profile-store.js";
import type { CredentialSlotClassifier } from "../../src/infra/auth/auth-store-types.js";
import type { CatalogProfile } from "../../src/infra/auth/provider-model-catalog-store.js";
import type { AccessProviderDefinition } from "../../src/infra/llm/access-provider.js";

/** The profile view that the saved-catalog store writes through, with the production lineage reader over
 *  `definitions`, as the model listing client builds it. */
export function catalogProfile(access: AuthProfileAccess, definitions: readonly AccessProviderDefinition[], classifySlot: CredentialSlotClassifier = () => "metered"): CatalogProfile {
  return { access, currentLineage: (account) => currentCredentialLineage(definitions, access.authDirectory, classifySlot, account) };
}
