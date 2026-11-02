/**
 * Parser for the FLYWHEEL_BOOT_TRACE stderr stream: `[boot +NNNms] <label>`
 * lines written by src/infra/startup-trace.ts. The elapsed value is measured
 * by the binary itself from its own module load, so it is immune to launch
 * and tmux overhead on the driver side.
 */
import { readFileSync } from "node:fs"

export interface BootPhase {
  elapsedMs: number
  label: string
}

const BOOT_LINE = /^\[boot \+(\d+)ms\] (.+)$/

export function parseBootTrace(stderrText: string): BootPhase[] {
  const phases: BootPhase[] = []
  for (const line of stderrText.split("\n")) {
    const match = BOOT_LINE.exec(line.trim())
    if (match) phases.push({ elapsedMs: Number(match[1]), label: match[2] ?? "" })
  }
  return phases
}

/** The phases a launch has written to its stderr file so far; none before the file exists. */
export function readBootPhases(stderrFile: string): BootPhase[] {
  try {
    return parseBootTrace(readFileSync(stderrFile, "utf8"))
  } catch {
    return []
  }
}

/** First occurrence wins: boot labels are emitted once per launch. */
export function phaseElapsedMs(phases: readonly BootPhase[], label: string): number | undefined {
  return phases.find((phase) => phase.label === label)?.elapsedMs
}

/** Emitted by src/tui/shell.tsx on the first frame the renderer presents after
 *  the shell mounted, so the frame shows the shell and not an empty tree. */
const CONTENT_FRAME_PHASE = "content frame"
/** The renderer's first frame. On OpenTUI 0.6.8 a terminal capability reply
 *  can present the empty tree before the shell mounts, so it times a blank
 *  frame; it stands in only for a baseline that predates the content frame. */
const OPENTUI_FIRST_FRAME_PHASE = "opentui first frame"
export const CHAT_INPUT_READY_PHASE = "chat input mode ready"
/** Emitted by src/tui/welcome-notice.tsx when the first welcome card shows its full title. */
export const SESSION_INTRO_VISIBLE_PHASE = "session intro visible"
export const SESSION_LIST_READY_PHASE = "session list ready"

export type PhaseReading =
  | { readonly kind: "ready"; readonly elapsedMs: number }
  | { readonly kind: "missing"; readonly phase: string }

/** When the first frame with content reached the screen. The candidate must
 *  report the content frame. A published baseline that predates it reports
 *  the renderer's first frame, which v0.1.1 presented after the shell mounted
 *  in 24 of 24 measured runs; the reading can only come earlier than the
 *  content frame, so it makes the relative comparison stricter for the
 *  candidate, never looser.
 *  Remove the baseline fallback after 2027-04-30, once every published
 *  baseline that the gate fetches emits the content frame. */
export function firstFrameMs(phases: readonly BootPhase[], role: "candidate" | "baseline"): PhaseReading {
  const contentFrame = phaseElapsedMs(phases, CONTENT_FRAME_PHASE)
  if (contentFrame !== undefined) return { kind: "ready", elapsedMs: contentFrame }
  const rendererFrame = role === "baseline" ? phaseElapsedMs(phases, OPENTUI_FIRST_FRAME_PHASE) : undefined
  return rendererFrame === undefined ? { kind: "missing", phase: CONTENT_FRAME_PHASE } : { kind: "ready", elapsedMs: rendererFrame }
}

/** When a new chat looks ready to the user: the prompt accepts input AND the
 *  welcome card is on screen, so the later of the two phases. Both phases are
 *  required of the candidate. A published baseline that predates the intro
 *  phase reports only chat input readiness; that is the one place the gate
 *  accepts a partial reading, and it can only understate the baseline, which
 *  makes the relative comparison stricter for the candidate, never looser. */
export function newChatReadyMs(phases: readonly BootPhase[], role: "candidate" | "baseline"): PhaseReading {
  const inputReady = phaseElapsedMs(phases, CHAT_INPUT_READY_PHASE)
  if (inputReady === undefined) return { kind: "missing", phase: CHAT_INPUT_READY_PHASE }
  const introVisible = phaseElapsedMs(phases, SESSION_INTRO_VISIBLE_PHASE)
  if (introVisible !== undefined) return { kind: "ready", elapsedMs: Math.max(inputReady, introVisible) }
  return role === "baseline" ? { kind: "ready", elapsedMs: inputReady } : { kind: "missing", phase: SESSION_INTRO_VISIBLE_PHASE }
}

export type SessionListReady =
  | { readonly kind: "ready"; readonly elapsedMs: number }
  | { readonly kind: "missing"; readonly phase: string }
  | { readonly kind: "unavailable" }

/** Complete eager catalog hydration. Older baselines can predate this phase,
 *  but every candidate must emit it. */
export function sessionListReadyMs(phases: readonly BootPhase[], role: "candidate" | "baseline"): SessionListReady {
  const elapsedMs = phaseElapsedMs(phases, SESSION_LIST_READY_PHASE)
  if (elapsedMs !== undefined) return { kind: "ready", elapsedMs }
  return role === "baseline" ? { kind: "unavailable" } : { kind: "missing", phase: SESSION_LIST_READY_PHASE }
}

/** Emitted by src/cli/remote-terminal.ts around each question of the remote
 *  project picker, which a launch with `--remote` asks before it attaches. */
export const REMOTE_QUESTION_SHOWN_PHASE = "remote project question shown"
export const REMOTE_QUESTION_ANSWERED_PHASE = "remote project question answered"

export type RemoteQuestions =
  | { readonly kind: "answered"; readonly firstShownMs: number; readonly answerWaitMs: number }
  | { readonly kind: "missing"; readonly phase: string }

/** When the remote picker first asked, and how long the person took to
 *  answer all its questions. The terminal does no startup work while a
 *  question waits, so a phase after the picker less the answer wait is the
 *  terminal's own time to it. Each question is one shown and answered pair,
 *  in that order. */
export function remoteQuestions(phases: readonly BootPhase[]): RemoteQuestions {
  let firstShownMs: number | undefined
  let shownMs: number | undefined
  let answerWaitMs = 0
  for (const phase of phases) {
    if (phase.label === REMOTE_QUESTION_SHOWN_PHASE) {
      firstShownMs ??= phase.elapsedMs
      shownMs = phase.elapsedMs
    } else if (phase.label === REMOTE_QUESTION_ANSWERED_PHASE && shownMs !== undefined) {
      answerWaitMs += phase.elapsedMs - shownMs
      shownMs = undefined
    }
  }
  if (firstShownMs === undefined) return { kind: "missing", phase: REMOTE_QUESTION_SHOWN_PHASE }
  if (shownMs !== undefined) return { kind: "missing", phase: REMOTE_QUESTION_ANSWERED_PHASE }
  return { kind: "answered", firstShownMs, answerWaitMs }
}
