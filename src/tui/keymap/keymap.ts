/**
 * User-remappable keybinding layer resolved by semantic command id.
 *
 * Default bindings are data; user overrides arrive from the `[keybindings]`
 * table in flywheel.toml (external input: rejected entries surface as
 * actionable issues, valid entries replace defaults). The keyboard handler
 * consults `resolve()` before its own dispatch; display surfaces (palette,
 * help, hints) read `chordFor()` so they always show the effective binding.
 */

import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

/** App-level default bindings. Adding a binding means adding a row here. The
 *  label is what the help modal and the generated key reference show; adjacent
 *  rows with one label share one help row. */
export const DEFAULT_BINDINGS = [
  { commandId: "help", chord: "ctrl+p", label: KERNEL_COMMAND_NAMES.help },
  { commandId: "new", chord: "ctrl+n", label: KERNEL_COMMAND_NAMES.new },
  { commandId: "sessions", chord: "ctrl+s", label: KERNEL_COMMAND_NAMES.sessions },
  { commandId: "tab.close", chord: "ctrl+w", label: "Close tab" },
  { commandId: "resume", chord: "ctrl+r", label: "Resume an interrupted session" },
  { commandId: "tab.next", chord: "tab", label: "Cycle sessions" },
  { commandId: "tab.previous", chord: "shift+tab", label: "Cycle sessions" },
  { commandId: "tab.1", chord: "ctrl+1", label: "Activate tab" },
  { commandId: "tab.2", chord: "ctrl+2", label: "Activate tab" },
  { commandId: "tab.3", chord: "ctrl+3", label: "Activate tab" },
  { commandId: "tab.4", chord: "ctrl+4", label: "Activate tab" },
  { commandId: "tab.5", chord: "ctrl+5", label: "Activate tab" },
  { commandId: "tab.6", chord: "ctrl+6", label: "Activate tab" },
  { commandId: "tab.7", chord: "ctrl+7", label: "Activate tab" },
  { commandId: "tab.8", chord: "ctrl+8", label: "Activate tab" },
  { commandId: "tab.9", chord: "ctrl+9", label: "Activate tab" },
  { commandId: "output.page-up", chord: "pageup", label: "Scroll output" },
  { commandId: "output.page-down", chord: "pagedown", label: "Scroll output" },
  { commandId: "output.half-page-up", chord: "ctrl+pageup", label: "Scroll half page" },
  { commandId: "output.half-page-down", chord: "ctrl+pagedown", label: "Scroll half page" },
  { commandId: "output.top", chord: "home", label: "Jump to top / bottom" },
  { commandId: "output.bottom", chord: "end", label: "Jump to top / bottom" },
] as const

type KeymapCommandId = (typeof DEFAULT_BINDINGS)[number]["commandId"]

/** The normalized key-event shape the resolver consumes. */
interface KeymapKeyEvent {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

export interface Keymap {
  /** Effective binding lookup: key event -> semantic command id. */
  resolve(evt: KeymapKeyEvent): KeymapCommandId | null
  /** Effective chord for display. Total: overrides replace, never remove. */
  chordFor(commandId: KeymapCommandId): string
}

export type ChordParseResult =
  | { readonly ok: true; readonly chord: string }
  | { readonly ok: false; readonly reason: string }

const MODIFIER_ORDER = ["ctrl", "meta", "shift"] as const
const MODIFIERS: ReadonlySet<string> = new Set(MODIFIER_ORDER)
const NAMED_KEYS = new Set([
  "escape", "tab", "enter", "space", "backspace", "delete", "insert",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
])

const COMMAND_IDS: ReadonlySet<string> = new Set(DEFAULT_BINDINGS.map((b) => b.commandId))

function isKeymapCommandId(id: string): id is KeymapCommandId {
  return COMMAND_IDS.has(id)
}

/** The effective chord of the keymap command that shares a slash command's
 *  id, so a command menu shows the shortcut of any command that has one. */
export function chordForCommand(chordFor: Keymap["chordFor"], commandId: string): string | undefined {
  return isKeymapCommandId(commandId) ? chordFor(commandId) : undefined
}

function canonical(modifiers: ReadonlySet<string>, key: string): string {
  return [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key].join("+")
}

/** Parse a chord spec like "ctrl+shift+p" into its canonical form. */
export function parseChord(spec: string): ChordParseResult {
  const parts = spec.trim().toLowerCase().split("+").map((part) => part.trim())
  const modifiers = new Set<string>()
  const keys: string[] = []
  for (const part of parts) {
    if (part === "") return { ok: false, reason: "empty key segment" }
    if (MODIFIERS.has(part)) {
      if (modifiers.has(part)) return { ok: false, reason: `duplicate modifier "${part}"` }
      modifiers.add(part)
    } else {
      keys.push(part)
    }
  }
  if (keys.length === 0) return { ok: false, reason: "missing a key (modifiers only)" }
  if (keys.length > 1) return { ok: false, reason: `more than one key: ${keys.join(", ")}` }
  // SAFETY: keys.length === 1 checked above.
  const key = keys[0]!
  if (key.length !== 1 && !NAMED_KEYS.has(key)) {
    return { ok: false, reason: `unknown key "${key}"` }
  }
  return { ok: true, chord: canonical(modifiers, key) }
}

/** Canonical chord of a key event, or null when the event carries no bindable key. */
function chordOfKeyEvent(evt: KeymapKeyEvent): string | null {
  let name = evt.name.toLowerCase()
  let shift = evt.shift === true
  // Some terminals report Shift+Tab as its own key name.
  if (name === "shift-tab") {
    name = "tab"
    shift = true
  }
  if (name.length !== 1 && !NAMED_KEYS.has(name)) return null
  const modifiers = new Set<string>()
  if (evt.ctrl) modifiers.add("ctrl")
  if (evt.meta) modifiers.add("meta")
  if (shift) modifiers.add("shift")
  return canonical(modifiers, name)
}

interface KeybindingOverrides {
  [commandId: string]: string
}

/**
 * Build the effective keymap from defaults merged with user overrides.
 * Invalid overrides (unknown command id, unparseable chord, chord collision)
 * are rejected individually with actionable issues; the rest still apply.
 */
export function createKeymap(overrides: KeybindingOverrides = {}) {
  const issues: string[] = []
  const defaults = new Map<KeymapCommandId, string>()
  for (const binding of DEFAULT_BINDINGS) {
    const parsed = parseChord(binding.chord)
    if (!parsed.ok) throw new Error(`Invalid default chord "${binding.chord}" for "${binding.commandId}": ${parsed.reason}`)
    defaults.set(binding.commandId, parsed.chord)
  }

  const accepted = new Map<KeymapCommandId, string>()
  for (const [commandId, spec] of Object.entries(overrides)) {
    if (!isKeymapCommandId(commandId)) {
      issues.push(
        `Ignoring [keybindings] entry for unknown command "${commandId}". ` +
          `Known commands: ${[...defaults.keys()].join(", ")}.`,
      )
      continue
    }
    const parsed = parseChord(spec)
    if (!parsed.ok) {
      issues.push(
        `Ignoring [keybindings] entry ${commandId} = "${spec}": ${parsed.reason}. ` +
          `Use forms like "ctrl+p", "ctrl+shift+p", "pageup", or "home".`,
      )
      continue
    }
    accepted.set(commandId, parsed.chord)
  }

  // Reject overrides whose chord collides with another command's effective
  // chord. Dropping an override reverts it to its default, which can create a
  // new collision, so iterate to a fixpoint (terminates: each pass removes at
  // least one accepted override).
  let effective: Map<KeymapCommandId, string>
  for (;;) {
    effective = new Map(defaults)
    for (const [commandId, chord] of accepted) effective.set(commandId, chord)
    const byChord = new Map<string, KeymapCommandId[]>()
    for (const [commandId, chord] of effective) {
      byChord.set(chord, [...(byChord.get(chord) ?? []), commandId])
    }
    const conflicted = [...byChord.entries()].filter(([, ids]) => ids.length > 1)
    if (conflicted.length === 0) break
    for (const [chord, commandIds] of conflicted) {
      const overridden = commandIds.filter((id) => accepted.has(id))
      for (const commandId of overridden) accepted.delete(commandId)
      issues.push(
        `Ignoring [keybindings] override(s) for ${overridden.join(", ")}: "${chord}" is already bound ` +
          `to ${commandIds.filter((id) => !overridden.includes(id)).join(", ") || "another override"}. ` +
          `Remap that command too to free the chord.`,
      )
    }
  }

  const commandByChord = new Map<string, KeymapCommandId>()
  for (const [commandId, chord] of effective) commandByChord.set(chord, commandId)

  const keymap: Keymap = {
    resolve(evt) {
      const chord = chordOfKeyEvent(evt)
      return chord ? (commandByChord.get(chord) ?? null) : null
    },
    chordFor(commandId) {
      const chord = effective.get(commandId)
      if (!chord) throw new Error(`No chord for keymap command "${commandId}"`)
      return chord
    },
  }
  return { keymap, issues }
}
