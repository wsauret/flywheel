import type { TuiTheme } from "../context/theme/resolve.js"
import type { ModelModalState } from "../modals/model-modal-types.js"

export type ModelModalScope = ModelModalState["scope"]

export function scopeSaveToast(scope: ModelModalScope, label: string, mirroredToTab = false): string {
  if (scope === "session") return `Updated ${label} for this tab`
  return mirroredToTab
    ? `Updated ${label} default for new sessions and this tab`
    : `Updated ${label} default for new sessions`
}

export function scopeBreadcrumbRoot(scope: ModelModalScope): string {
  return scope === "defaults" ? "New session defaults" : "This tab"
}

export function scopeContextLine(scope: ModelModalScope, tabOpen = false): string {
  if (scope === "session") return "Changes apply to this tab only."
  return tabOpen
    ? "New sessions and this tab; other tabs keep their models."
    : "New sessions only; open tabs keep their models."
}

export function scopeHelpHint(scope: ModelModalScope): string {
  return scope === "defaults" ? "g this tab" : "g defaults"
}

export function scopeChromeColor(scope: ModelModalScope, theme: Pick<TuiTheme, "primary" | "warning">): TuiTheme["primary"] {
  return scope === "defaults" ? theme.warning : theme.primary
}
