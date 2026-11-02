import { openExistingAuthProfileDirectory } from "../../infra/auth/auth-profile-store.js"
import { deselectAllProviderModels, setProviderAutoEnableNewModels, setProviderFreeRoutePreference, setProviderModelPreference } from "../../infra/auth/provider-model-preference-store.js"
import type { ProviderModelPreferenceServiceDeps } from "./provider-model-preference-service.js"

type Persistence = Pick<ProviderModelPreferenceServiceDeps, "persist" | "persistAllDeselected" | "persistAutoEnableNewModels" | "persistFreeRoutes">

/** Binds exact-account preference writes to the selected profile directory. */
export function providerModelPreferencePersistence(profileDirectory: (profileId: string) => string): Persistence {
  return {
    persist: async ({ profileId, account, currentAccounts, expectedAuthRevision, expectedPreferenceRevision, modelId, state }) => {
      const access = openExistingAuthProfileDirectory(profileDirectory(profileId))
      try {
        return await setProviderModelPreference(access, account, modelId, state, currentAccounts, expectedAuthRevision, expectedPreferenceRevision)
      } finally {
        access.close()
      }
    },
    persistAllDeselected: async ({ profileId, account, currentAccounts, expectedAuthRevision, expectedPreferenceRevision, modelIds }) => {
      const access = openExistingAuthProfileDirectory(profileDirectory(profileId))
      try {
        return await deselectAllProviderModels(access, account, modelIds, currentAccounts, expectedAuthRevision, expectedPreferenceRevision)
      } finally {
        access.close()
      }
    },
    persistAutoEnableNewModels: async ({ profileId, currentAccounts, expectedAuthRevision, expectedPreferenceRevision, enabled, accountCatalogs }) => {
      const access = openExistingAuthProfileDirectory(profileDirectory(profileId))
      try {
        return await setProviderAutoEnableNewModels(access, enabled, accountCatalogs, currentAccounts, expectedAuthRevision, expectedPreferenceRevision)
      } finally {
        access.close()
      }
    },
    persistFreeRoutes: async ({ profileId, account, currentAccounts, expectedAuthRevision, expectedPreferenceRevision, enabled }) => {
      const access = openExistingAuthProfileDirectory(profileDirectory(profileId))
      try {
        return await setProviderFreeRoutePreference(access, account, enabled, currentAccounts, expectedAuthRevision, expectedPreferenceRevision)
      } finally {
        access.close()
      }
    },
  }
}
