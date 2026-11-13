import type { ModuleComposerStatus } from "../../protocol/protocol-module.js"
import { keyHintPlainText, sessionCountLabel, type KeyHintSpec } from "./key-hint-row-state.js"

/** The border renderer pads a label with one space per side and shows it only
 *  strictly inside the corner-to-corner rule (border-content.ts), so a plain
 *  label fits when its width is at most terminalWidth - 5: two corners, two
 *  padding spaces, and one rule cell. Reserving less selects a hint level the
 *  renderer then suppresses entirely instead of degrading. */
const BORDER_LABEL_MARGIN = 5

/** Complete label width, including separately styled metadata. */
function composerStatusText(label: ModuleComposerStatus): string {
  return label.suffix ? `${label.text} ${label.suffix.text}` : label.text
}

export interface ComposerBorderLayoutInput {
  terminalWidth: number
  modelLabel: string | undefined
  update: ComposerBorderUpdate | undefined
  composerStatus?: readonly ModuleComposerStatus[]
  changesLabel?: string
  /** esc cancel / interrupt / dismiss; dropped only as the last resort. */
  primaryHints: readonly KeyHintSpec[]
  showGlobalHints: boolean
  activeSessionCount: number
  sessionCount: number
  /** ctrl+r resume, present only while the foreground session admits Resume
   *  and no turn runs. */
  resumeHint: KeyHintSpec | undefined
  /** ctrl+n / ctrl+w tab verbs: the persistent tab-is-session teaching surface. */
  newHint: KeyHintSpec | undefined
  closeHint: KeyHintSpec | undefined
  sessionsHint: KeyHintSpec | undefined
}

export interface ComposerBorderLayout {
  modelLabel: string | undefined
  update: ComposerBorderUpdate | undefined
  composerStatus?: readonly ModuleComposerStatus[]
  changesLabel?: string
  hints: readonly KeyHintSpec[]
  /** When present, the trailing hint becomes the clickable sessions target. */
  sessionsClickHint: KeyHintSpec | null
}

export interface ComposerBorderUpdate {
  readonly label: string
  readonly tone: "error" | "success"
}

/** Removal hierarchy on width pressure (first dropped → last dropped):
 *    Tab switch → new/close tab verbs → ctrl+s sessions → ctrl+r resume →
 *    primary hints.
 *  Resume outlives the tab verbs and sessions because it is the one control
 *  that matters while a session is interrupted; those teach navigation that
 *  stays reachable elsewhere.
 *  On the top-right border, labels are admitted in this order while they fit:
 *  the workspace update alert, module labels in the warning tone, the model
 *  label, the other module labels, and Changes. */
export function computeComposerBorderLayout(input: ComposerBorderLayoutInput): ComposerBorderLayout {
  const contentWidth = Math.max(0, input.terminalWidth - BORDER_LABEL_MARGIN)
  let used = 0
  const admit = (width: number): boolean => {
    const next = used + (used > 0 ? 3 : 0) + width
    if (next > contentWidth) return false
    used = next
    return true
  }
  const update = input.update && admit(input.update.label.length) ? input.update : undefined
  // A warning label asks the person to act, so a narrow border keeps it and
  // drops the model label first.
  const statuses = input.composerStatus ?? []
  const warnings = new Set(statuses.filter((label) => label.tone === "warning" && admit(composerStatusText(label).length)))
  // An update alert that does not fit takes the model label with it.
  const modelLabel = input.modelLabel && (!input.update || update) && admit(input.modelLabel.length) ? input.modelLabel : undefined
  // The other module labels and Changes repeat surface information, so neither
  // displaces the update alert or model. Changes also remains reachable through /changes.
  const composerStatus = statuses.filter((label) => warnings.has(label) || (label.tone !== "warning" && admit(composerStatusText(label).length)))
  const changesLabel = input.changesLabel && admit(input.changesLabel.length) ? input.changesLabel : undefined

  const tabHint: KeyHintSpec | undefined =
    input.showGlobalHints && input.activeSessionCount >= 2 ? { key: "tab", label: "switch", separatorStyle: "border" } : undefined
  const sessionsHint: KeyHintSpec | undefined =
    input.sessionsHint
      ? { key: input.sessionsHint.key, label: sessionCountLabel(input.sessionCount) }
      : undefined
  const tabVerbHints: readonly KeyHintSpec[] = input.showGlobalHints
    ? [input.newHint, input.closeHint].filter((hint): hint is KeyHintSpec => hint !== undefined)
    : []

  const resumeHint = input.showGlobalHints ? input.resumeHint : undefined

  const levels: ReadonlyArray<{ tab: boolean; verbs: boolean; sessions: boolean; resume: boolean; primary: boolean }> = [
    { tab: true, verbs: true, sessions: true, resume: true, primary: true },
    { tab: false, verbs: true, sessions: true, resume: true, primary: true },
    { tab: false, verbs: false, sessions: true, resume: true, primary: true },
    { tab: false, verbs: false, sessions: false, resume: true, primary: true },
    { tab: false, verbs: false, sessions: false, resume: false, primary: true },
    { tab: false, verbs: false, sessions: false, resume: false, primary: false },
  ]

  for (const level of levels) {
    const hints: KeyHintSpec[] = level.primary ? [...input.primaryHints] : []
    if (level.resume && resumeHint) hints.push(resumeHint)
    if (level.verbs) hints.push(...tabVerbHints)
    if (level.tab && tabHint) hints.push(tabHint)
    if (level.sessions && sessionsHint) hints.push(sessionsHint)
    if (keyHintPlainText(hints).length <= contentWidth) {
      return {
        modelLabel,
        update,
        composerStatus,
        changesLabel,
        hints,
        sessionsClickHint: level.sessions && sessionsHint ? sessionsHint : null,
      }
    }
  }

  return { modelLabel, update, composerStatus, changesLabel, hints: [], sessionsClickHint: null }
}
