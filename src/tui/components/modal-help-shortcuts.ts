import { DEFAULT_BINDINGS, type Keymap } from "../keymap/keymap.js"
import { TEXT_ENTRY_KEY_BINDINGS, type TextEntryAction } from "../keymap/text-entry.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

export const HELP_SHORTCUT_SECTIONS = ["Prompt", "Text editing", "Selection", "App navigation"] as const
type HelpShortcutSection = (typeof HELP_SHORTCUT_SECTIONS)[number]
export type HelpShortcut = readonly [keys: string, description: string, section: HelpShortcutSection]

type ActionHelp = { [Action in TextEntryAction]: readonly [HelpShortcutSection, string] }

const ACTION_HELP = {
  "move-left": ["Text editing", "Move one character left"],
  "move-right": ["Text editing", "Move one character right"],
  "move-up": ["Text editing", "Move one visual line up"],
  "move-down": ["Text editing", "Move one visual line down"],
  "select-left": ["Selection", "Select one character left"],
  "select-right": ["Selection", "Select one character right"],
  "select-up": ["Selection", "Select one visual line up"],
  "select-down": ["Selection", "Select one visual line down"],
  "line-home": ["Text editing", "Jump to line start"],
  "line-end": ["Text editing", "Jump to line end"],
  "select-line-home": ["Selection", "Select to line start"],
  "select-line-end": ["Selection", "Select to line end"],
  "visual-line-home": ["Text editing", "Jump to wrapped-line start"],
  "visual-line-end": ["Text editing", "Jump to wrapped-line end"],
  "select-visual-line-home": ["Selection", "Select to wrapped-line start"],
  "select-visual-line-end": ["Selection", "Select to wrapped-line end"],
  "buffer-home": ["Text editing", "Jump to entry start"],
  "buffer-end": ["Text editing", "Jump to entry end"],
  "select-buffer-home": ["Selection", "Select to entry start"],
  "select-buffer-end": ["Selection", "Select to entry end"],
  "delete-line": ["Text editing", "Delete current line"],
  "delete-to-line-end": ["Text editing", "Delete to line end"],
  "delete-to-line-start": ["Text editing", "Delete to line start"],
  backspace: ["Text editing", "Delete previous character"],
  delete: ["Text editing", "Delete next character"],
  newline: ["Prompt", "Insert new line"],
  undo: ["Text editing", "Undo text edit"],
  redo: ["Text editing", "Redo text edit"],
  "word-forward": ["Text editing", "Move one word forward"],
  "word-backward": ["Text editing", "Move one word backward"],
  "select-word-forward": ["Selection", "Select one word forward"],
  "select-word-backward": ["Selection", "Select one word backward"],
  "delete-word-forward": ["Text editing", "Delete next word"],
  "delete-word-backward": ["Text editing", "Delete previous word"],
  "select-all": ["Selection", "Select all"],
  submit: ["Prompt", "Send prompt"],
  cancel: ["Prompt", "Close/cancel/interrupt"],
} satisfies ActionHelp

function displayKey(name: string): string {
  if (["return", "enter", "linefeed", "kpenter"].includes(name)) return "enter"
  if (name === "escape") return "esc"
  if (["left", "right", "up", "down"].includes(name)) return `${name} arrow`
  return name
}

interface DisplayBinding {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
}

function displayBinding(binding: DisplayBinding): string {
  return [
    binding.ctrl ? "ctrl" : undefined,
    binding.meta ? "alt" : undefined,
    binding.shift ? "shift" : undefined,
    binding.super ? "super" : undefined,
    displayKey(binding.name),
  ].filter((part) => part !== undefined).join("+")
}

function actionShortcuts(): HelpShortcut[] {
  const grouped = new Map<string, { section: HelpShortcutSection; description: string; keys: Set<string> }>()
  for (const binding of TEXT_ENTRY_KEY_BINDINGS) {
    const [section, description] = ACTION_HELP[binding.action]
    const id = binding.action
    const group = grouped.get(id) ?? { section, description, keys: new Set<string>() }
    group.keys.add(displayBinding(binding))
    grouped.set(id, group)
  }
  return [...grouped.values()].map(({ section, description, keys }) => [[...keys].join(" / "), description, section])
}

/** Keys that are neither text-entry actions nor remappable bindings. */
const FIXED_SHORTCUTS: readonly HelpShortcut[] = [
  ["up arrow (empty prompt)", "Open prompt history", "Prompt"],
  ["up/down arrows · enter · esc", "Navigate prompt lists", "Prompt"],
  ["tab", "Complete slash command", "Prompt"],
  ["right arrow", "Accept ghost text", "Prompt"],
  ["ctrl+v / super+v", "Paste clipboard image", "Prompt"],
  ["/help", KERNEL_COMMAND_NAMES.help, "Prompt"],
  ["ctrl+shift+a / super+a, then backspace", "Clear entry after Select all", "Selection"],
]

/** One row per run of adjacent bindings that share a label. A pair reads
 *  "a / b"; a longer run, such as the numbered tabs, reads "first .. last". */
function bindingShortcuts(chordFor: Keymap["chordFor"]): HelpShortcut[] {
  const runs: { readonly label: string; readonly chords: string[] }[] = []
  for (const { commandId, label } of DEFAULT_BINDINGS) {
    const run = runs.at(-1)
    if (run?.label === label) run.chords.push(chordFor(commandId))
    else runs.push({ label, chords: [chordFor(commandId)] })
  }
  return runs.map(({ label, chords }) => [chords.length > 2 ? `${chords[0]} .. ${chords.at(-1)}` : chords.join(" / "), label, "App navigation"])
}

/** Returns the effective keyboard reference, including user-remapped app commands. */
export function helpShortcuts(chordFor: Keymap["chordFor"]): readonly HelpShortcut[] {
  return [...actionShortcuts(), ...FIXED_SHORTCUTS, ...bindingShortcuts(chordFor)]
}
