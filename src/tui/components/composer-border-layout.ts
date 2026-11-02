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
 *  On the top-right border, the workspace update alert takes priority over the
 *  model label. */
export function computeComposerBorderLayout(input: ComposerBorderLayoutInput): ComposerBorderLayout {
  const contentWidth = Math.max(0, input.terminalWidth - BORDER_LABEL_MARGIN)
  const update = input.update && input.update.label.length <= contentWidth ? input.update : undefined
  const modelFits = input.modelLabel && (input.update
    ? update !== undefined && input.update.label.length + 3 + input.modelLabel.length <= contentWidth
    : input.modelLabel.length <= contentWidth)
  const modelLabel = modelFits ? input.modelLabel : undefined
  // Module labels and Changes repeat surface information, so neither displaces the
  // update alert or model. Changes also remains reachable through /changes.
  const used = (update?.label.length ?? 0) + (modelLabel?.length ?? 0) + (update && modelLabel ? 3 : 0)
  let usedWithModules = used
  const composerStatus = (input.composerStatus ?? []).filter((label) => {
    const width = (usedWithModules > 0 ? 3 : 0) + composerStatusText(label).length
    if (usedWithModules + width > contentWidth) return false
    usedWithModules += width
    return true
  })
  const changesLabel = input.changesLabel && usedWithModules + (usedWithModules > 0 ? 3 : 0) + input.changesLabel.length <= contentWidth ? input.changesLabel : undefined

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
