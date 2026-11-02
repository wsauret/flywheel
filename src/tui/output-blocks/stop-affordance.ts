import { bg as stBg, fg as stFg, type TextChunk } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve.js"
import type { Accessor } from "solid-js"
import type { FrontendToolEntry } from "../../protocol/app-service-types.js"
import { PROCESSOR_WAIT_NOTE, toolActivity, waitsForProcessor } from "../../protocol/client/transcript-model.js"

/** Inline process control appended to a transcript row. The owning component
 * hit-tests mouse-up coordinates against the visible label before disclosure.
 * The padding is non-breaking (U+00A0) so the word-wrapper in tool-row-wrap
 * treats the whole label as one atomic word: it must wrap to the next line as
 * a unit, never split mid-button (which also broke the lastIndexOf hit test). */
const STOP_TEXT = "\u00a0stop\u00a0"
const DETACH_TEXT = "\u00a0detach\u00a0"

/** Process actions available to every transcript row for one selected session. */
export interface RowProcessControls {
  activeHeldToolCallIds: Accessor<ReadonlySet<string>>
  activeManagedProcessToolCallIds: Accessor<ReadonlySet<string>>
  /** The calls whose commands processor admission holds. */
  processorHeldToolCallIds: Accessor<ReadonlySet<string>>
  onDetach: (toolUseId: string) => void
  onStop: (toolUseId: string) => void
  /** Stops a linked child (a durable subagent or a workflow) by ending the
   *  parent's tool call it answers, the same Stop every surface offers. */
  onStopChild?: (toolUseId: string) => void
}

export interface RowProcessControl {
  label: typeof STOP_TEXT | typeof DETACH_TEXT
  dispatch: () => void
}

export function rowProcessControl(
  controls: RowProcessControls | undefined,
  toolUseId: string | undefined,
): RowProcessControl | undefined {
  if (controls === undefined || toolUseId === undefined) return undefined
  // Only a shell command is ever held, so a held call offers Detach whatever its name.
  if (controls.activeHeldToolCallIds().has(toolUseId)) {
    return { label: DETACH_TEXT, dispatch: () => controls.onDetach(toolUseId) }
  }
  if (controls.activeManagedProcessToolCallIds().has(toolUseId)) {
    return { label: STOP_TEXT, dispatch: () => controls.onStop(toolUseId) }
  }
  return undefined
}

/** The Stop of a running linked child's card: its parent's tool call. */
export function childProcessControl(
  controls: RowProcessControls | undefined,
  toolUseId: string,
  linked: boolean,
  active: boolean,
): RowProcessControl | undefined {
  const onStopChild = controls?.onStopChild
  if (!active || !linked || onStopChild === undefined) return undefined
  return { label: STOP_TEXT, dispatch: () => onStopChild(toolUseId) }
}

export function processControlChunks(theme: TuiTheme, label: RowProcessControl["label"]): TextChunk[] {
  return [stFg(theme.warning)("  "), stBg(theme.warning)(stFg(theme.background)(label))]
}

/** Whether the row of one call shows that its command waits for processor time. */
export function rowWaitsForProcessor(
  controls: RowProcessControls | undefined,
  entry: Pick<FrontendToolEntry, "id" | "status">,
): boolean {
  if (controls === undefined) return false
  const activity = toolActivity(entry, {
    held: controls.activeHeldToolCallIds().has(entry.id),
    managed: controls.activeManagedProcessToolCallIds().has(entry.id),
  })
  return waitsForProcessor(activity, controls.processorHeldToolCallIds().has(entry.id))
}

/** The processor wait note is information, not a fault, so it takes the info
 *  color and never the muted color: a held command is still running work. */
export function processorWaitChunks(theme: TuiTheme): TextChunk[] {
  return [stFg(theme.text)(" "), stFg(theme.info)(PROCESSOR_WAIT_NOTE)]
}
