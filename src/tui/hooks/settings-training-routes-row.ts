import type { Accessor } from "solid-js"
import type { SettingsStore } from "./create-settings-store.js"
import type { SettingCatalogRow } from "../../protocol/setting-catalog.js"
import { cycleRowActions, type SettingsRow } from "./settings-modal-types.js"

interface TrainingRoutesRowInput {
  /** The catalog row this row presents. */
  readonly row: Pick<SettingCatalogRow, "id" | "label" | "description">
  readonly profileId: Accessor<string | undefined>
  readonly profileName: Accessor<string | undefined>
  readonly profilePendingReason: string
  readonly settings: Pick<SettingsStore, "profileBoolean" | "publication" | "updateProfileBoolean">
  readonly save: (input: {
    readonly save: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>
    readonly label: string
    readonly success: string
  }) => Promise<void>
}

/** Builds the active-profile consent row for provider training routes. */
export function createTrainingRoutesRow(input: TrainingRoutesRowInput): SettingsRow {
  const enabled = (): boolean | undefined => {
    const profileId = input.profileId()
    return profileId === undefined ? undefined : input.settings.profileBoolean(profileId, "allowTrainingRoutes")
  }
  return {
    kind: "cycle",
    id: input.row.id,
    label: input.row.label,
    description: input.row.description,
    value: () => {
      const current = enabled()
      const profile = input.profileName()
      return current === undefined || profile === undefined ? "N/A" : `${current ? "On" : "Off"} · ${profile}`
    },
    unavailableReason: () => {
      if (input.profileId() === undefined) return input.profilePendingReason
      if (enabled() !== undefined) return undefined
      const publication = input.settings.publication()
      return publication.kind === "error" ? publication.message : "Active profile configuration is still loading"
    },
    ...cycleRowActions(() => {
      const profileId = input.profileId()
      const current = enabled()
      if (profileId === undefined || current === undefined) return
      const next = !current
      void input.save({
        save: async () => {
          const result = await input.settings.updateProfileBoolean(profileId, "allowTrainingRoutes", next)
          return result.ok ? { ok: true } : { ok: false, error: { message: result.error.message } }
        },
        label: input.row.label,
        success: `Training routes ${next ? "enabled" : "disabled"} for ${input.profileName() ?? profileId}`,
      })
    }),
  }
}
