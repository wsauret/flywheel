import type { CredentialSlot, CredentialSlotClassifier } from "../../infra/auth/auth-store-types.js"
import type { FirstPartyModuleComposition } from "../modules.js"

/** Classifies retained credentials from the complete installed catalog, independent of provider admission. */
export function credentialSlotClassifier(composition: Pick<FirstPartyModuleComposition, "installedContributions">): CredentialSlotClassifier {
  const slots = new Map<string, CredentialSlot>()
  for (const contribution of composition.installedContributions) {
    const declaration = contribution.domain === "providers"
      ? { id: contribution.id, slot: contribution.value.definition.billing }
      : contribution.domain === "webAuthProviders"
        ? { id: contribution.id, slot: "metered" as const }
        : undefined
    if (declaration === undefined) continue
    const existing = slots.get(declaration.id)
    if (existing !== undefined && existing !== declaration.slot) {
      throw new Error(`Conflicting credential slot declarations for ${declaration.id}: ${existing} and ${declaration.slot}`)
    }
    slots.set(declaration.id, declaration.slot)
  }
  return (providerId) => slots.get(providerId) ?? "metered"
}
