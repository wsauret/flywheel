import type { Accessor } from "solid-js"
import type { GitAiAttributionStatus } from "../../protocol/git-ai-attribution-protocol-types.js"
import { gitAiAttributionReading, gitAiAttributionUnavailableReason } from "../../protocol/client/git-ai-attribution-copy.js"
import type { SettingCatalogRow } from "../../protocol/setting-catalog.js"
import { cycleRowActions, type SettingsRow } from "./settings-modal-types.js"

const GIT_AI_ATTRIBUTION_PENDING = "Git AI attribution availability is still loading"

export function createGitAiAttributionRow(input: {
  /** The catalog row this row presents. */
  readonly row: Pick<SettingCatalogRow, "id" | "label" | "description">
  readonly profileId: Accessor<string | undefined>
  readonly profileName: Accessor<string | undefined>
  readonly enabled: Accessor<boolean | undefined>
  readonly status: Accessor<GitAiAttributionStatus | undefined>
  readonly profilePendingReason: string
  readonly configUnavailableReason: Accessor<string | undefined>
  readonly update: (profileId: string, enabled: boolean) => Promise<{ readonly ok: true; readonly notice?: string } | { readonly ok: false; readonly error: Error }>
  readonly save: (input: { readonly save: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>; readonly label: string; readonly success: string }) => Promise<void>
}): SettingsRow {
  return {
    kind: "cycle",
    id: input.row.id,
    label: input.row.label,
    description: input.row.description,
    value: () => {
      const profile = input.profileName()
      const suffix = profile === undefined ? "" : ` · ${profile}`
      if (input.enabled() !== true) return `Off${suffix}`
      const reading = gitAiAttributionReading(input.status())
      return reading === undefined ? `On${suffix}` : `On (${reading})${suffix}`
    },
    unavailableReason: () => {
      if (input.profileId() === undefined) return input.profilePendingReason
      const enabled = input.enabled()
      if (enabled === undefined) return input.configUnavailableReason()
      const status = input.status()
      if (status === undefined) return GIT_AI_ATTRIBUTION_PENDING
      return !enabled && status.kind === "unavailable" ? gitAiAttributionUnavailableReason(status) : undefined
    },
    ...cycleRowActions(() => {
      const profileId = input.profileId()
      const enabled = input.enabled()
      const status = input.status()
      if (profileId === undefined || enabled === undefined || status === undefined || (!enabled && status.kind === "unavailable")) return
      const next = !enabled
      void input.save({
        save: async () => {
          const result = await input.update(profileId, next)
          return result.ok ? { ok: true } : { ok: false, error: { message: result.error.message } }
        },
        label: input.row.label,
        success: `${input.row.label} ${next ? "enabled" : "disabled"}`,
      })
    }),
  }
}
