import { openExistingAuthProfileDirectory } from "./auth-profile-store.js";
import { AuthStoreMutationError, ensureCredentialLineages } from "./auth-store-mutations.js";
import type { CredentialSlotClassifier } from "./auth-store-types.js";
import { adoptPreviousProviderModelCatalogs } from "./provider-model-catalog-store.js";
import type { AccessProviderDefinition, AuthProfileConversion, AuthProfileConversionInput } from "../llm/access-provider.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS } from "../llm/model-catalog-resolution.js";
import { Log } from "../log.js";
import type { NotificationOccurrence } from "../notification-episode.js";

const log = Log.create({ service: "auth-profile-normalization" });

/** Normalizes known credentials and saved catalogs under their existing locks.
 * A strict credential refusal preserves all bytes and returns read-only; other
 * failures propagate. Each provider's own profile conversions run in their
 * phase, by provider id, and state what the person must act on through
 * `notify` when a person reads notifications. Pass the complete installed
 * vocabulary and definitions, never the enabled ones. */
export async function normalizeAuthProfile(directory: string, classifySlot: CredentialSlotClassifier, installedIds: readonly string[], definitions: readonly AccessProviderDefinition[], notify?: (occurrence: NotificationOccurrence) => void): Promise<"normalized" | "read-only"> {
  const access = openExistingAuthProfileDirectory(directory);
  try {
    const profile: AuthProfileConversionInput = { access, classifySlot, installedIds, ...(notify === undefined ? {} : { notify }) };
    await runProfileConversions(definitions, "before-decode", profile);
    try {
      await ensureCredentialLineages(access, classifySlot, installedIds);
    } catch (error) {
      if (!(error instanceof AuthStoreMutationError)) throw error;
      return "read-only";
    }
    await runProfileConversions(definitions, "after-decode", profile);
    if (await adoptPreviousProviderModelCatalogs(access, DEFAULT_DYNAMIC_CATALOG_LIMITS)) {
      log.info("adopted saved provider catalogs from a previous version", { directory });
    }
    return "normalized";
  } finally {
    access.close();
  }
}

async function runProfileConversions(definitions: readonly AccessProviderDefinition[], phase: AuthProfileConversion["phase"], profile: AuthProfileConversionInput): Promise<void> {
  for (const definition of definitions.toSorted((left, right) => left.id.localeCompare(right.id))) {
    for (const conversion of definition.profileConversions ?? []) {
      if (conversion.phase === phase) await conversion.convert(profile);
    }
  }
}
