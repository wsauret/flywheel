/** Every keyboard chord the client answers, in one table: the listener that
 *  acts on a chord and the sheet that lists it read the same rows, so a key
 *  cannot work without being shown or be shown without working. `Mod` is the
 *  platform's command key: Cmd on Apple keyboards, Ctrl elsewhere. */

export interface Shortcut {
  /** The keys as a person reads them, `Mod` standing for the command key. */
  readonly keys: readonly string[]
  readonly label: string
  /** A chord the shell answers from anywhere, by `key` value. Rows without
   *  one are the composer's own keys, listed so the sheet is complete. */
  readonly chord?: string
  /** Only offered on a pane wide enough to have a session rail. */
  readonly wide?: true
  /** A key that the workflow agent view answers while no text field has
   *  focus: it opens the previous (-1) or next (1) agent of the workflow
   *  that started. */
  readonly agentMove?: 1 | -1
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ["Enter"], label: "Send the message" },
  { keys: ["Shift", "Enter"], label: "Start a new line" },
  { keys: ["Esc"], label: "Skip the question at the prompt" },
  { keys: ["Esc"], label: "Interrupt the running turn while no question waits" },
  { keys: ["↑", "↓"], label: "Recall an earlier message" },
  { keys: ["/"], label: "Open the command menu" },
  { keys: ["Mod", "F"], label: "Find in transcripts", chord: "f" },
  { keys: ["Mod", "K"], label: "Switch session", chord: "k" },
  { keys: ["Mod", "B"], label: "Show or hide the session list", chord: "b", wide: true },
  { keys: ["Mod", "/"], label: "Show keyboard shortcuts", chord: "/" },
  { keys: ["↑", "↓", "Home", "End"], label: "Select a line of a workflow's card" },
  { keys: ["Enter"], label: "Open the selected agent, or expand or fold its phase" },
  { keys: ["→", "←"], label: "Expand or fold the selected phase" },
  { keys: ["Esc"], label: "Interrupt the open agent of a workflow" },
  { keys: ["["], label: "Open the previous agent of a workflow", agentMove: -1 },
  { keys: ["]"], label: "Open the next agent of a workflow", agentMove: 1 },
]

interface ChordEvent {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/** The shortcut this key event is, if it is one: the command key and one
 *  key, nothing else held, so an editor's own chords and typed text stay
 *  untouched. */
export function chordFor(event: ChordEvent): Shortcut | undefined {
  const mod = (event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey)
  if (!mod || event.altKey || event.shiftKey) return undefined
  const key = event.key.toLowerCase()
  return SHORTCUTS.find((shortcut) => shortcut.chord === key)
}

/** The row a workflow agent view moves to for this key event, if it is one
 *  of its keys with no command key held. A layout that types a bracket with
 *  Option or AltGr still reaches it. The caller checks that no text field
 *  has focus. */
export function agentMoveFor(event: ChordEvent): 1 | -1 | undefined {
  if (event.metaKey || event.ctrlKey) return undefined
  return SHORTCUTS.find((shortcut) => shortcut.agentMove !== undefined && shortcut.keys[0] === event.key)?.agentMove
}

/** The command key's name on this keyboard, for the sheet. */
export function modKeyLabel(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl"
}
