import { defaultTextareaKeyBindings, type InputKeyBinding } from "@opentui/core"
import { createSignal } from "solid-js"
import { isPrintableText, stripControlCharacters } from "../../infra/control-characters.js"
import {
  displayWidth,
  graphemeBoundaryAtOrBefore,
  graphemes,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
} from "../utils/text.js"

export type TextEntryAction =
  | "move-left" | "move-right" | "move-up" | "move-down"
  | "select-left" | "select-right" | "select-up" | "select-down"
  | "line-home" | "line-end" | "select-line-home" | "select-line-end"
  | "visual-line-home" | "visual-line-end" | "select-visual-line-home" | "select-visual-line-end"
  | "buffer-home" | "buffer-end" | "select-buffer-home" | "select-buffer-end"
  | "delete-line" | "delete-to-line-end" | "delete-to-line-start"
  | "backspace" | "delete" | "newline" | "undo" | "redo"
  | "word-forward" | "word-backward" | "select-word-forward" | "select-word-backward"
  | "delete-word-forward" | "delete-word-backward" | "select-all" | "submit" | "cancel"

export interface TextEntryKeyBinding {
  name: string
  action: TextEntryAction
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
}

const NATIVE_ACTIONS: ReadonlySet<TextEntryAction> = new Set([
  "move-left", "move-right", "move-up", "move-down", "select-left", "select-right", "select-up", "select-down",
  "line-home", "line-end", "select-line-home", "select-line-end", "visual-line-home", "visual-line-end",
  "select-visual-line-home", "select-visual-line-end", "buffer-home", "buffer-end", "select-buffer-home",
  "select-buffer-end", "delete-line", "delete-to-line-end", "delete-to-line-start", "backspace", "delete",
  "newline", "undo", "redo", "word-forward", "word-backward", "select-word-forward", "select-word-backward",
  "delete-word-forward", "delete-word-backward", "select-all", "submit",
])

function isSharedBinding(binding: InputKeyBinding): binding is InputKeyBinding & { action: TextEntryAction } {
  return (!(binding.name === "return" || binding.name === "linefeed" || binding.name === "kpenter") || binding.meta === true)
    && !(binding.name === "w" && binding.ctrl === true)
    && !(binding.name === "a" && binding.ctrl === true && binding.shift === true)
    && !(binding.name === "a" && binding.super === true)
    && NATIVE_ACTIONS.has(binding.action)
}

const inheritedBindings = defaultTextareaKeyBindings.filter(isSharedBinding)
const requiredHistoryBindings = [
  { name: "z", ctrl: true, action: "undo" },
  { name: "y", ctrl: true, action: "redo" },
  { name: "z", ctrl: true, shift: true, action: "redo" },
] satisfies readonly TextEntryKeyBinding[]
const sharedHistoryBindings = requiredHistoryBindings.filter((required) =>
  !inheritedBindings.some((binding) => bindingMatches(required, binding)))

/** OpenTUI's public textarea defaults, less application-owned chords, plus Flywheel actions. */
export const TEXT_ENTRY_KEY_BINDINGS: readonly TextEntryKeyBinding[] = [
  ...inheritedBindings,
  ...sharedHistoryBindings,
  { name: "a", ctrl: true, shift: true, action: "select-all" },
  { name: "a", super: true, action: "select-all" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", action: "submit" },
  { name: "enter", shift: true, action: "newline" },
  { name: "enter", ctrl: true, action: "newline" },
  { name: "enter", action: "submit" },
  { name: "linefeed", shift: true, action: "newline" },
  { name: "linefeed", ctrl: true, action: "newline" },
  { name: "linefeed", action: "submit" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "kpenter", ctrl: true, action: "newline" },
  { name: "kpenter", action: "submit" },
  { name: "escape", action: "cancel" },
]

/** Mutable OpenTUI-safe bindings for Composer's native textarea. */
export const NATIVE_TEXT_ENTRY_KEY_BINDINGS: InputKeyBinding[] = TEXT_ENTRY_KEY_BINDINGS.flatMap((binding) =>
  binding.action === "cancel" ? [] : [{ ...binding, action: binding.action }])

/** The key-event fields that can carry printable terminal text. */
export interface PrintableTextKeyEvent {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  sequence?: string
  raw?: string
}

/** Returns the printable text represented by a key event, or null for control and structural keys. */
export function normalizedPrintableText(event: PrintableTextKeyEvent): string | null {
  if (event.ctrl || event.meta) return null
  if (event.name === "space") return " "
  const sequence = event.sequence ?? ""
  if (isPrintableText(sequence)) return sequence
  const raw = event.raw ?? ""
  if (isPrintableText(raw)) return raw
  if (event.name.length !== 1) return null
  return event.shift ? event.name.toUpperCase() : event.name
}

export interface TextEntryKeyEvent extends PrintableTextKeyEvent {
  super?: boolean
  baseCode?: number
  preventDefault?: () => void
}

/** Resolves a terminal key without consuming application-owned control chords. */
export function resolveTextEntryAction(event: TextEntryKeyEvent): TextEntryAction | undefined {
  return TEXT_ENTRY_KEY_BINDINGS.find((binding) => bindingMatches(binding, event))?.action
}

function bindingMatches(binding: TextEntryKeyBinding, event: TextEntryKeyEvent): boolean {
  return binding.name === event.name
    && Boolean(binding.ctrl) === Boolean(event.ctrl)
    && Boolean(binding.shift) === Boolean(event.shift)
    && Boolean(binding.meta) === Boolean(event.meta)
    && Boolean(binding.super) === Boolean(event.super)
}

export interface TextEntryPolicy {
  kind: "single-line" | "multiline"
  actions: ReadonlySet<TextEntryAction>
}

const MULTILINE_ACTIONS = new Set<TextEntryAction>([...NATIVE_ACTIONS, "cancel"])
const SINGLE_LINE_ACTIONS = new Set<TextEntryAction>([...MULTILINE_ACTIONS].filter((action) =>
  !["move-up", "move-down", "select-up", "select-down", "newline"].includes(action),
))

export const SINGLE_LINE_TEXT_ENTRY_POLICY: TextEntryPolicy = { kind: "single-line", actions: SINGLE_LINE_ACTIONS }
export const MULTILINE_TEXT_ENTRY_POLICY: TextEntryPolicy = { kind: "multiline", actions: MULTILINE_ACTIONS }

export interface TextEntryVisualLine { start: number; end: number }
export interface TextEntrySelection { start: number; end: number }
export interface TextEditorPresentation {
  value: string
  cursor: number
  selection: TextEntrySelection | null
  preferredVisualColumn: number | null
}
type TextEditorResult = "handled" | "submit" | "cancel" | "unhandled"

export interface ControlledTextEditorOptions {
  value: () => string
  setValue: (value: string) => void
  policy: TextEntryPolicy
  initialCursor?: number
  visualLines?: () => readonly TextEntryVisualLine[]
  history?: "enabled" | "disabled"
}

export interface ControlledTextEditor {
  handleKey(event: TextEntryKeyEvent): TextEditorResult
  handlePaste(text: string): TextEditorResult
  presentation(): TextEditorPresentation
  setCursor(offset: number): void
  setSelection(anchor: number, cursor: number): void
  resetEphemeralState(options?: { cursor?: number }): void
}

interface Snapshot { value: string; cursor: number; anchor: number | null; bytes: number; group?: "insert" | "backspace" | "delete" }
const HISTORY_LIMIT = 100
const HISTORY_BYTE_LIMIT = 1024 * 1024
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" })

/** Edits caller-owned text. Cursor, selection, preferred column, and history belong to this editor instance. */
export function createControlledTextEditor(options: ControlledTextEditorOptions): ControlledTextEditor {
  let cursor = boundary(options.value(), options.initialCursor ?? options.value().length)
  let anchor: number | null = null
  let preferredVisualColumn: number | null = null
  const [revision, setRevision] = createSignal(0)
  const undo: Snapshot[] = []
  const redo: Snapshot[] = []

  const changed = () => setRevision((value) => value + 1)
  const selection = (): TextEntrySelection | null => anchor === null || anchor === cursor
    ? null
    : { start: Math.min(anchor, cursor), end: Math.max(anchor, cursor) }
  const snapshot = (group?: Snapshot["group"]): Snapshot => {
    const value = options.value()
    return { value, cursor, anchor, bytes: new TextEncoder().encode(value).byteLength, group }
  }
  const trimHistory = (history: Snapshot[]) => {
    let bytes = history.reduce((total, item) => total + item.bytes, 0)
    while (history.length > HISTORY_LIMIT || bytes > HISTORY_BYTE_LIMIT) bytes -= history.shift()?.bytes ?? 0
  }
  const remember = (group?: Snapshot["group"]) => {
    if (options.history === "disabled") return
    const prior = undo.at(-1)
    if (group === undefined || prior?.group !== group) undo.push(snapshot(group))
    trimHistory(undo)
    redo.length = 0
  }
  const publish = (value: string, nextCursor: number, nextAnchor: number | null = null) => {
    const boundedCursor = boundary(value, nextCursor)
    const boundedAnchor = nextAnchor === null ? null : boundary(value, nextAnchor)
    const stateChanged = value !== options.value() || boundedCursor !== cursor || boundedAnchor !== anchor || preferredVisualColumn !== null
    if (!stateChanged) return false
    if (value !== options.value()) options.setValue(value)
    cursor = boundedCursor
    anchor = boundedAnchor
    preferredVisualColumn = null
    changed()
    return true
  }
  const replace = (start: number, end: number, text: string, group?: Snapshot["group"]) => {
    const value = options.value()
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`
    if (next === value && start + text.length === cursor && anchor === null) return false
    remember(group)
    return publish(next, start + text.length)
  }
  const replaceSelection = (text: string): boolean => {
    const selected = selection()
    if (!selected) return false
    replace(selected.start, selected.end, text)
    return true
  }
  const restore = (from: Snapshot[], to: Snapshot[]) => {
    const next = from.pop()
    if (!next) return false
    to.push(snapshot())
    trimHistory(to)
    publish(next.value, next.cursor, next.anchor)
    return true
  }
  const move = (target: number, selecting: boolean, preserveColumn = false) => {
    const value = options.value()
    const next = boundary(value, target)
    const nextAnchor = selecting ? (anchor ?? cursor) : null
    if (cursor === next && anchor === nextAnchor && (preserveColumn || preferredVisualColumn === null)) return
    const latest = undo.at(-1)
    if (latest) latest.group = undefined
    anchor = nextAnchor
    cursor = next
    if (!preserveColumn) preferredVisualColumn = null
    changed()
  }
  const lines = () => normalizeLines(options.value(), options.visualLines?.())
  const verticalTarget = (delta: -1 | 1): number => {
    const value = options.value()
    const visual = lines()
    const index = Math.max(0, visual.findIndex((line) => cursor >= line.start && cursor <= line.end))
    const current = visual[index] ?? { start: 0, end: value.length }
    preferredVisualColumn ??= displayWidth(value.slice(current.start, cursor))
    const target = visual[Math.max(0, Math.min(visual.length - 1, index + delta))] ?? current
    return offsetAtColumn(value, target, preferredVisualColumn)
  }
  const logicalLine = () => logicalLineAt(options.value(), cursor)
  const visualLine = () => lines().find((line) => cursor >= line.start && cursor <= line.end) ?? logicalLine()

  const execute = (action: TextEntryAction): TextEditorResult => {
    const value = options.value()
    const selected = selection()
    const selecting = action.startsWith("select-") && action !== "select-all"
    switch (action) {
      case "submit": return "submit"
      case "cancel": return "cancel"
      case "newline": replace(selected?.start ?? cursor, selected?.end ?? cursor, "\n"); return "handled"
      case "undo": restore(undo, redo); return "handled"
      case "redo": restore(redo, undo); return "handled"
      case "select-all": if (anchor !== 0 || cursor !== value.length || preferredVisualColumn !== null) { anchor = 0; cursor = value.length; preferredVisualColumn = null; changed() }; return "handled"
      case "move-left": move(selected?.start ?? previousGraphemeBoundary(value, cursor), false); return "handled"
      case "move-right": move(selected?.end ?? nextGraphemeBoundary(value, cursor), false); return "handled"
      case "select-left": move(previousGraphemeBoundary(value, cursor), true); return "handled"
      case "select-right": move(nextGraphemeBoundary(value, cursor), true); return "handled"
      case "move-up": case "select-up": move(verticalTarget(-1), selecting, true); return "handled"
      case "move-down": case "select-down": move(verticalTarget(1), selecting, true); return "handled"
      case "line-home": case "select-line-home": move(logicalLine().start, selecting); return "handled"
      case "line-end": case "select-line-end": move(logicalLine().end, selecting); return "handled"
      case "visual-line-home": case "select-visual-line-home": move(visualLine().start, selecting); return "handled"
      case "visual-line-end": case "select-visual-line-end": move(visualLine().end, selecting); return "handled"
      case "buffer-home": case "select-buffer-home": move(0, selecting); return "handled"
      case "buffer-end": case "select-buffer-end": move(value.length, selecting); return "handled"
      case "word-backward": move(previousWordBoundary(value, cursor), false); return "handled"
      case "word-forward": move(nextWordBoundary(value, cursor), false); return "handled"
      case "select-word-backward": move(previousWordBoundary(value, cursor), true); return "handled"
      case "select-word-forward": move(nextWordBoundary(value, cursor), true); return "handled"
      case "backspace": if (!replaceSelection("")) replace(previousGraphemeBoundary(value, cursor), cursor, "", "backspace"); return "handled"
      case "delete": if (!replaceSelection("")) replace(cursor, nextGraphemeBoundary(value, cursor), "", "delete"); return "handled"
      case "delete-word-backward": if (!replaceSelection("")) replace(previousWordBoundary(value, cursor), cursor, ""); return "handled"
      case "delete-word-forward": if (!replaceSelection("")) replace(cursor, nextWordBoundary(value, cursor), ""); return "handled"
      case "delete-to-line-start": if (!replaceSelection("")) replace(logicalLine().start, cursor, ""); return "handled"
      case "delete-to-line-end": if (!replaceSelection("")) replace(cursor, logicalLine().end, ""); return "handled"
      case "delete-line": { const line = logicalLine(); replace(line.start, line.end < value.length ? line.end + 1 : line.end, ""); return "handled" }
    }
  }

  return {
    handleKey(event) {
      const action = resolveTextEntryAction(event)
      if (action !== undefined) {
        if (!options.policy.actions.has(action)) return "unhandled"
        event.preventDefault?.()
        return execute(action)
      }
      const text = normalizedPrintableText(event)
      if (!text) return "unhandled"
      const normalized = normalizePaste(text, options.policy.kind)
      if (!normalized) return "unhandled"
      event.preventDefault?.()
      const selected = selection()
      replace(selected?.start ?? cursor, selected?.end ?? cursor, normalized, selected ? undefined : "insert")
      return "handled"
    },
    handlePaste(text) {
      const normalized = normalizePaste(text, options.policy.kind)
      if (!normalized) return "unhandled"
      const selected = selection()
      replace(selected?.start ?? cursor, selected?.end ?? cursor, normalized)
      return "handled"
    },
    presentation: () => { revision(); return { value: options.value(), cursor: boundary(options.value(), cursor), selection: selection(), preferredVisualColumn } },
    setCursor(offset) { move(offset, false) },
    setSelection(start, end) { const nextAnchor = boundary(options.value(), start); const nextCursor = boundary(options.value(), end); if (anchor !== nextAnchor || cursor !== nextCursor || preferredVisualColumn !== null) { anchor = nextAnchor; cursor = nextCursor; preferredVisualColumn = null; changed() } },
    resetEphemeralState(reset = {}) { const nextCursor = boundary(options.value(), reset.cursor ?? options.value().length); const stateChanged = cursor !== nextCursor || anchor !== null || preferredVisualColumn !== null || undo.length > 0 || redo.length > 0; cursor = nextCursor; anchor = null; preferredVisualColumn = null; undo.length = 0; redo.length = 0; if (stateChanged) changed() },
  }
}

function boundary(value: string, offset: number): number { return graphemeBoundaryAtOrBefore(value, offset) }
function normalizePaste(text: string, kind: TextEntryPolicy["kind"]): string {
  const normalized = text.replace(/\r\n?/g, "\n")
  return normalized.split("\n").map(stripControlCharacters).join(kind === "multiline" ? "\n" : "")
}
function logicalLineAt(value: string, offset: number): TextEntryVisualLine {
  const start = value.lastIndexOf("\n", Math.max(0, offset - 1)) + 1
  const newline = value.indexOf("\n", offset)
  return { start, end: newline < 0 ? value.length : newline }
}
function normalizeLines(value: string, supplied?: readonly TextEntryVisualLine[]): readonly TextEntryVisualLine[] {
  if (supplied?.length) return supplied.map((line) => ({ start: boundary(value, line.start), end: boundary(value, line.end) }))
  const result: TextEntryVisualLine[] = []
  let start = 0
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", start)) { result.push({ start, end: index }); start = index + 1 }
  result.push({ start, end: value.length })
  return result
}
function offsetAtColumn(value: string, line: TextEntryVisualLine, column: number): number {
  let width = 0
  for (const item of graphemes(value.slice(line.start, line.end))) {
    const next = width + displayWidth(item.segment)
    if (next > column) break
    width = next
    if (width === column) return line.start + item.index + item.segment.length
  }
  let offset = line.start
  for (const item of graphemes(value.slice(line.start, line.end))) {
    if (displayWidth(value.slice(line.start, line.start + item.index + item.segment.length)) > column) break
    offset = line.start + item.index + item.segment.length
  }
  return Math.min(offset, line.end)
}
function previousWordBoundary(value: string, offset: number): number {
  let result = 0
  for (const segment of wordSegmenter.segment(value)) { if (segment.index >= offset) break; if (segment.isWordLike) result = segment.index }
  return result
}
function nextWordBoundary(value: string, offset: number): number {
  for (const segment of wordSegmenter.segment(value)) {
    if (segment.index > offset && segment.isWordLike) return segment.index
    if (segment.index <= offset && segment.index + segment.segment.length > offset && segment.isWordLike) return segment.index + segment.segment.length
  }
  return value.length
}