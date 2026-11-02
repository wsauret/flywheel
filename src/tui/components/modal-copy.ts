const MODAL_FRAME_CHROME_WIDTH = 6

export const MODAL_FRAME_WIDTHS = {
  auth: 66,
  background: 96,
  commands: 96,
  help: 72,
  model: 66,
  profile: 44,
  session: 140,
  settings: 72,
  status: 88,
  theme: 44,
  usage: 36,
} as const

export const modalCopyLimit = (frameWidth: number): number => frameWidth - MODAL_FRAME_CHROME_WIDTH



export const SUBSCRIPTION_SPEND_CONSENT_COPY = {
  prepaidWarning: "Prepaid credits can run out. Auto-reload may buy more.",
  questionTitle: "ALLOW PAID USE IN FLYWHEEL",
  questionRule: "Flywheel keeps paid use off until you allow it here. Modes you leave unticked stay off.",
  questionControls: "↑↓ choose · space toggle · enter continue",
  questionClose: "esc continue",
  answerFailed: "Flywheel could not record your answer for the modes you left unticked. They stay off, and Flywheel will ask again.",
  mutationFeedback: {
    stale: "Subscription capacity changed. Review the current modes.",
    staleUnavailable: "Subscription capacity changed. Reopen this account.",
    contention: "Another update is in progress. Try again.",
    invalidEnvelope: "Subscription modes changed. Reopen this account.",
    storageFailure: "Could not save subscription consent. Check storage.",
    dispatchFailure: "Could not save subscription consent. Check connection.",
  },
} as const

/** The hint for the left arrow that returns to the previous view. Every
 *  modal names it in these words, so one action has one glyph. */
export const MODAL_BACK_HINT = "← back"

export const MODAL_CONTROL_COPY = {
  background: ["space output · enter open · x stop · a all · ↑↓ navigate · esc close", "a all · esc close"],
  commands: ["enter select · ↑↓ navigate · type to filter · esc close", "Type to filter · esc close"],
  help: ["↑↓ scroll · pageup/pagedown page · enter/esc close"],
  profile: ["enter switch · ↑↓ navigate · esc close"],
  settings: {
    list: "enter select · ←→ change · ↑↓ navigate · esc close",
    group: "enter select · ←→ change · backspace back · esc close",
    multiselect: `space/enter toggle · ↑↓ navigate · ${MODAL_BACK_HINT} · esc close`,
    singleSelect: `enter select · ↑↓ navigate · ${MODAL_BACK_HINT} · esc close`,
    edit: "enter/esc done · tab back",
    action: "enter continue · esc back",
    confirmation: "←→ choose · enter select · esc close",
  },
  status: ["↑↓ highlight · c or Enter copies · Esc closes."],
  theme: ["↑↓ change · enter/esc close"],
} as const

export const AUTH_CONTROL_COPY = {
  navigation: `${MODAL_BACK_HINT}  esc close`,
  environmentProfile: "FLYWHEEL_AUTH_PROFILE locks profile changes",
  modelSelection: "type search · ctrl+d deselect all · space/enter toggle",
  modelSelectionNavigation: `↑↓ navigate · ${MODAL_BACK_HINT} · esc close`,
  save: "enter save  esc cancel",
  done: "enter/esc done · tab back",
  continue: "enter continue  esc cancel",
  confirmation: "←→ choose · enter select · esc back",
  deviceCode: `c copy code  ${MODAL_BACK_HINT}  esc cancel`,
  browser: `${MODAL_BACK_HINT}  esc cancel`,
  browserCode: `enter finish login  ${MODAL_BACK_HINT}  esc cancel`,
  providerSettingsActions: `r reconnect · d disconnect · ${MODAL_BACK_HINT}`,
} as const

export const AUTH_LIST_ACTION_COPY = [
  "a auto models  → cycle  g scope  n new  r rename  d delete",
  "a auto models  → cycle  g scope  n new  r rename",
  "enter provider settings  r rename  d disconnect  a add",
  "enter provider settings  r rename  d disconnect  a add",
  "r rename  d disconnect  a add",
  "enter connect",
  "enter show error",
  "enter provider settings  d disconnect  a add",
  "enter provider settings  d disconnect  a add",
  "d disconnect  a add",
  "enter provider settings  a add",
  "enter connect  a add",
  "enter provider settings  d disconnect",
  "d disconnect",
  "enter provider settings",
] as const

export const SESSION_CONTROL_COPY = [
  "tab switch field · enter rename · esc cancel",
  "d delete · esc close",
  "Type to filter · esc close",
  "enter open · ↑↓ navigate · esc close",
] as const

export function settingsGroupDescription(group: string): string {
  return `Configure ${group.toLowerCase()} capabilities.`
}
