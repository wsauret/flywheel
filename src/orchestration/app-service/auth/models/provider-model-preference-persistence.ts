import { openExistingAuthProfileDirectory } from "../../../../infra/providers/auth/store/auth-profile-store.js"
import { deselectAllProviderModels, setProviderAutoEnableNewModels, setProviderFreeRoutePreference, setProviderModelPreference } from "../../../../infra/providers/auth/provider-models/provider-model-preference-store.js"
import type { ProviderModelPreferenceServiceDeps } from "./provider-model-preference-service.js"

type Persistence = Pick<ProviderModelPreferenceServiceDeps, "persist" | "persistAllDeselected" | "persistAutoEnableNewModels" | "persistFreeRoutes">

/** Binds exact-account preference writes to the selected profile directory. */
export function providerModelPreferencePersistence(profileDirectory: (profileId: string) => string): Persistence {
  return {
    persist: async ({ profileId, account, currentAccounts, expected, modelId, state }) => {
      const access = openExistingAuthProfileDirectory(profileDirectory(profileId))
      try {
        return await setProviderModelPreference(access, account, modelId, state, currentAccounts, expected)
      } finally {
        access.close()
      }
    },
    persistAllDeselected: async ({ profileId, account, currentAccounts, expected, modelIds }) => {
      const access = openExistingAuthProfileDirectory(profileDirectory(profileId))
      try {
        return await deselectAllProviderModels(access, account, modelIds, currentAccounts, expected)
      } finally {
        access.close()
      }
    },
    persistAutoEnableNewModels: async ({ profileId, currentAccounts, expected, enabled, accountCatalogs }) => {
      const access = openExistingAuthProfileDirectory(profileDirectory(profileId))
      try {
        return await setProviderAutoEnableNewModels(access, enabled, accountCatalogs, currentAccounts, expected)
      } finally {
        access.close()
      }
    },
    persistFreeRoutes: async ({ profileId, account, currentAccounts, expected, enabled }) => {
      const access = openExistingAuthProfileDirectory(profileDirectory(profileId))
      try {
        return await setProviderFreeRoutePreference(access, account, enabled, currentAccounts, expected)
      } finally {
        access.close()
      }
    },
  }
}
