import { bg as stBg, fg as stFg, type TextChunk } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve.js"
import type { FrontendToolEntry } from "../../protocol/app-service-types.js"
import { PROCESSOR_WAIT_NOTE, toolActivity, toolProcess, waitsForProcessor, type ProcessStatus } from "../../protocol/client/transcript-model.js"

/** Inline process control appended to a transcript row. The owning component
 * hit-tests mouse-up coordinates against the visible label before disclosure.
 * The padding is non-breaking (U+00A0) so the word-wrapper in tool-row-wrap
 * treats the whole label as one atomic word: it must wrap to the next line as
 * a unit, never split mid-button (which also broke the lastIndexOf hit test). */
const STOP_TEXT = "\u00a0stop\u00a0"
const DETACH_TEXT = "\u00a0detach\u00a0"

/** Process actions available to every transcript row for one selected session. */
export interface RowProcessControls {
  /** The session's live process status. It is a plain read of the status the
   *  client holds and creates no computation, so a row may ask from a pointer
   *  handler, which has no reactive owner, as often as the pointer moves. */
  status: () => ProcessStatus | undefined
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
  const process = toolProcess(controls.status(), toolUseId)
  // Only a shell command is ever held, so a held call offers Detach whatever its name.
  if (process.held) return { label: DETACH_TEXT, dispatch: () => controls.onDetach(toolUseId) }
  if (process.managed) return { label: STOP_TEXT, dispatch: () => controls.onStop(toolUseId) }
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
  const status = controls.status()
  return waitsForProcessor(toolActivity(entry, toolProcess(status, entry.id)), status?.processorHeldToolCallIds.includes(entry.id) ?? false)
}

/** The processor wait note is information, not a fault, so it takes the info
 *  color and never the muted color: a held command is still running work. */
export function processorWaitChunks(theme: TuiTheme): TextChunk[] {
  return [stFg(theme.text)(" "), stFg(theme.info)(PROCESSOR_WAIT_NOTE)]
}
