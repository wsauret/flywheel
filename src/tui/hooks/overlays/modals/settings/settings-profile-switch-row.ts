import type { Accessor } from "solid-js"
import type { SettingsStore } from "../../../state/create-settings-store.js"
import type { SettingCatalogRow } from "../../../../../protocol/settings/setting-catalog.js"
import type { ProfileBooleanSettingId } from "../../../../../orchestration/config/schema/setting-definitions.js"
import { cycleRowActions, type SettingsRow } from "../../../../modals/settings/settings-modal-types.js"

interface ProfileSwitchRowInput {
  /** The catalog row this row presents. */
  readonly row: Pick<SettingCatalogRow, "id" | "label" | "description">
  readonly setting: ProfileBooleanSettingId
  readonly profileId: Accessor<string | undefined>
  readonly profileName: Accessor<string | undefined>
  readonly profilePendingReason: string
  readonly settings: Pick<SettingsStore, "profileBoolean" | "publication" | "updateProfileBoolean">
  readonly save: (input: {
    readonly save: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>
    readonly label: string
    readonly success: string
  }) => Promise<void>
  /** What the toast says after the switch changed for `profile`. */
  readonly success: (on: boolean, profile: string) => string
  /** A switch that turns on only after the person confirms `message`. Turning it off asks nothing, and a cancel
   *  writes nothing. */
  readonly confirmTurnOn?: {
    readonly message: string
    readonly confirm: (label: string, message: string, actionLabel: string, onConfirm: () => void) => void
  }
}

/** Builds an active-profile consent switch, such as training routes or Google Antigravity. */
export function createProfileSwitchRow(input: ProfileSwitchRowInput): SettingsRow {
  const enabled = (): boolean | undefined => {
    const profileId = input.profileId()
    return profileId === undefined ? undefined : input.settings.profileBoolean(profileId, input.setting)
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
      const apply = () => {
        void input.save({
          save: async () => {
            const result = await input.settings.updateProfileBoolean(profileId, input.setting, next)
            return result.ok ? { ok: true } : { ok: false, error: { message: result.error.message } }
          },
          label: input.row.label,
          success: input.success(next, input.profileName() ?? profileId),
        })
      }
      if (next && input.confirmTurnOn !== undefined) input.confirmTurnOn.confirm(input.row.label, input.confirmTurnOn.message, "Turn on", apply)
      else apply()
    }),
  }
}
