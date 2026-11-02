import type { Accessor } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import type { ModuleProviderSetting } from "../../protocol/module-protocol-types.js"
import { groupDigits, parseDigits, sanitizeDigitInput, sanitizeDigitPaste } from "./settings-digit-input.js"
import type { SettingsEditResult, SettingsRow } from "./settings-modal-types.js"

interface SettingsMutationResult {
  readonly ok: boolean
  readonly notice?: string
  readonly error?: { readonly message: string }
}

interface ProviderSettingRowInput {
  readonly setting: ModuleProviderSetting
  readonly profileId: Accessor<string | undefined>
  readonly value: Accessor<number | undefined>
  readonly profilePendingReason: string
  readonly update: (profileId: string, setting: ModuleProviderSetting, value: number) => Promise<SettingsMutationResult>
  readonly showNotice: (message: string) => void
}

/** The row's surface id: one per declared provider setting. */
function providerSettingRowId(setting: Pick<ModuleProviderSetting, "providerId" | "key">): string {
  return `provider-setting:${setting.providerId}:${setting.key}`
}

/** One edit row for a provider module's numeric setting, rendered from its
 *  declaration: the declared `off` value reads as None, and a draft outside
 *  the declared bounds is refused before it is sent. */
export function createProviderSettingRow(input: ProviderSettingRowInput): SettingsRow {
  const { setting } = input
  const value = (): string => {
    const current = input.value()
    return current === undefined || current === setting.off ? "None" : groupDigits(String(current))
  }
  const submit = (text: string): SettingsEditResult | Promise<SettingsEditResult> => {
    const parsed = parseDigits(text)
    if (parsed === undefined || parsed < setting.min || parsed > setting.max) return { ok: false, error: `Enter a whole number from ${groupDigits(String(setting.min))} to ${groupDigits(String(setting.max))}, or ${setting.off} to turn it off` }
    const profileId = input.profileId()
    if (profileId === undefined) return { ok: false, error: input.profilePendingReason }
    if (parsed === input.value()) return { ok: true }
    return input.update(profileId, setting, parsed).then((result): SettingsEditResult => {
      if (!result.ok) return { ok: false, error: `${setting.label} update failed: ${result.error?.message ?? "unknown error"}` }
      if (result.notice !== undefined) input.showNotice(result.notice)
      return { ok: true }
    }).catch((error: unknown): SettingsEditResult => ({ ok: false, error: `${setting.label} update failed: ${errorMessage(error)}` }))
  }
  return {
    kind: "edit",
    id: providerSettingRowId(setting),
    label: setting.label,
    description: setting.description,
    value,
    edit: {
      hint: `${setting.description} Enter ${setting.off} to turn it off.`,
      current: value,
      initialDraft: () => groupDigits(String(input.value() ?? setting.defaultValue)),
      formatDraft: groupDigits,
      sanitizeInput: sanitizeDigitInput,
      sanitizePaste: sanitizeDigitPaste,
      submit,
    },
  }
}
