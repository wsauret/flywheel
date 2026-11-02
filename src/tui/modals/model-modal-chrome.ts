import { detectModelFamily } from "../../infra/llm/model-family.js"
import { slotDescription, slotLabel } from "../../orchestration/config/role-selection.js"
import type { ModelAssignmentItem, ModelModalState } from "./model-modal-types.js"
import { MODAL_BACK_HINT } from "../components/modal-copy.js"
import { modalDisclosureAction, modalDisclosureHelp } from "../components/modal-disclosure.js"
import { scopeBreadcrumbRoot, scopeContextLine, scopeHelpHint } from "../hooks/use-model-modal-scope.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

/** The screen heads with the name of the command that opens it, then whose
 *  models these are; a nested picker names its target after that. */
export function modalTitle(state: ModelModalState): string {
  if (state.view.kind === "models" && state.view.direct) return `${KERNEL_COMMAND_NAMES["model-and-effort"]}: ${state.view.displayLabel ?? "Chat"}`
  const scope = state.profileOwned ? "Auth profile" : state.subagent ? "This subagent" : scopeBreadcrumbRoot(state.scope)
  const root = `${KERNEL_COMMAND_NAMES.model} › ${scope}`
  if (state.view.kind === "assignments") return root
  const slot = state.modelOptions[0]?.slot
  const label = state.view.displayLabel ?? (slot ? slotLabel(slot) : "Role")
  return `${root} › ${label} › Model`
}

export function contextLine(state: ModelModalState): string {
  if (state.profileOwned) return `Changes apply to this auth profile.${state.savedModel ? ` Saved: ${state.savedModel}` : ""}`
  if (state.view.kind === "models" && state.savedModel) return `Saved: ${state.savedModel}`
  if (state.subagent) return "Changes apply to this subagent only."
  if (state.view.kind === "assignments") return scopeContextLine(state.scope, state.scopeToggleAvailable)
  return ""
}

/** The muted line under the list: what the selected role does, or the cache
 *  warning for an adjusted Anthropic model. Empty elsewhere, so the picker keeps its
 *  compact layout. */
export function descriptionLine(state: ModelModalState): string {
  if (state.view.kind === "models") {
    const row = state.modelOptions[state.cursor]
    if (!row || row.inherit || row.model === null || !state.pendingEfforts.has(row.model)) return ""
    return effortCacheWarning(row.model)
  }
  const items = state.assignmentItems
  const item = items[state.cursor]
  if (!item) return ""
  if (item.kind === "assignment") return slotDescription(item.row.slot)
  return ""
}

/** Anthropic renders the thinking configuration into the prompt, so an effort
 *  change starts the prompt cache over and the next request re-pays the full
 *  prompt. Other providers key the cache on input bytes only. */
function effortCacheWarning(model: string | null): string {
  if (!model || detectModelFamily(model) !== "anthropic") return ""
  return "An effort change invalidates the Anthropic prompt cache."
}

export function modalHelpRows(state: ModelModalState, modalWidth: number): readonly string[] {
  const compactForWidth = modalWidth <= 64
  const resetLabel = compactForWidth ? "ctrl+r reset" : "ctrl+r reset defaults"
  const confirmResetLabel = compactForWidth ? "ctrl+r again reset" : "ctrl+r again reset defaults"
  if (state.view.kind === "assignments") {
    const selected = state.assignmentItems[state.cursor]
    return actionHelpRows(state, "edit", resetLabel, confirmResetLabel, reviewerExpansionHelp(selected))
  }
  if (state.view.kind === "models") return [
    compactForWidth ? "↑↓ move  ←→ effort  enter confirm" : "↑↓ select · ←→ effort · enter confirm",
    compactForWidth ? "home/end ends  pgup/pgdn page" : "home/end first/last · pgup/pgdn page",
    [state.query ? "bksp edit" : "bksp back", state.scopeToggleAvailable ? "ctrl+g scope" : "", "esc close"].filter(Boolean).join(compactForWidth ? "  " : " · "),
  ]
  return ["", ""]
}

function actionHelpRows(state: ModelModalState, action: string, resetLabel: string, confirmResetLabel: string, expansionHelp = ""): readonly [string, string] {
  const primary = state.confirmReset
    ? `${confirmResetLabel} · enter ${action}`
    : [`enter ${action}`, expansionHelp, resetLabel].filter(Boolean).join(" · ")
  return [primary, [MODAL_BACK_HINT, scopeHelp(state), "esc close"].filter(Boolean).join(" · ")]
}

function reviewerExpansionHelp(item: ModelAssignmentItem | undefined): string {
  if (item?.disclosure === undefined || modalDisclosureAction(item.disclosure, "enter") !== "primary") return ""
  return modalDisclosureHelp(item.disclosure)
}

function scopeHelp(state: ModelModalState): string {
  return state.scopeToggleAvailable ? scopeHelpHint(state.scope) : ""
}

