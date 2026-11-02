import { createComputed, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { useClient } from "../client-context.js"

/** The in-place controls a settings row edits with.
 *
 *  A setting is edited where it is read. A switch flips a boolean, a segment
 *  picks one of a few named values, and a field opens on the row for a number
 *  or a short list, validates as the person types, and commits on Enter. None
 *  of them opens a dialog, because a dialog moves the value away from the row
 *  that explains it. While its write is in flight a control shows that it
 *  works and stays enabled: the actions layer joins a second tap on the same
 *  value to the running write and runs another value after it, so writes
 *  never race. `working` says a write of the row's setting is in flight.
 *  The value the control shows is then the one before that write, so a
 *  choice equal to it is the person's latest choice, not a tap on the value
 *  in force, and the control passes it on. */

export function SheetSwitch(props: { readonly on: boolean; readonly label: string; readonly disabled?: boolean; readonly working?: boolean; readonly onChange: (on: boolean) => void }) {
  return (
    <button
      class="sheet-switch"
      classList={{ on: props.on }}
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      aria-busy={props.working || undefined}
      onClick={() => props.onChange(!props.on)}
    >
      <span class="sheet-switch-thumb" />
    </button>
  )
}

export interface SegmentOption<T extends string> {
  readonly value: T
  readonly label: string
}

/** `writing` answers whether a write of one option is in flight, so only the
 *  option being written shows that it works. */
export function SheetSegment<T extends string>(props: { readonly value: T; readonly options: readonly SegmentOption<T>[]; readonly label: string; readonly disabled?: boolean; readonly working?: boolean; readonly writing?: (value: T) => boolean; readonly onChange: (value: T) => void }) {
  return (
    <div class="sheet-segment" role="radiogroup" aria-label={props.label}>
      <Key each={props.options} by="value">
        {(option) => (
          <button
            class="sheet-segment-option"
            classList={{ selected: option().value === props.value }}
            role="radio"
            aria-checked={option().value === props.value}
            disabled={props.disabled}
            aria-busy={props.writing?.(option().value) || undefined}
            onClick={() => { if (option().value !== props.value || props.working) props.onChange(option().value) }}
          >
            {option().label}
          </button>
        )}
      </Key>
    </div>
  )
}

/** Edits a value on its row and commits once on Enter, Escape, blur, or disposal.
 * Invalid Enter keeps the draft for correction; leaving restores the saved value
 * and retains the reason. The action
 * owner reports write failures; its promise keeps the input mounted until settlement. */
export function SheetField(props: {
  readonly value: string
  readonly label: string
  readonly placeholder?: string
  readonly inputMode?: "numeric" | "text"
  readonly disabled?: boolean
  readonly working?: boolean
  readonly fullWidth?: boolean
  readonly validate?: (draft: string) => string | undefined
  readonly onCommit: (draft: string) => void | Promise<void | boolean>
}) {
  const client = useClient()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [refusal, setRefusal] = createSignal<string>()
  // Only a draft the person typed is a choice. Opening the field and leaving
  // it writes nothing, even while a write runs.
  const [typed, setTyped] = createSignal(false)
  let resident = true
  const problem = () => editing() ? props.validate?.(draft()) : refusal()
  const begin = () => {
    if (props.disabled || props.working) return
    setDraft(props.value)
    setRefusal(undefined)
    setTyped(false)
    setEditing(true)
  }
  const commit = (end: "enter" | "leave" = "leave") => {
    if (!resident || !editing()) return
    const invalid = props.validate?.(draft())
    if (invalid !== undefined) {
      if (end === "enter") return
      setTyped(false)
      setRefusal(invalid)
      setEditing(false)
      return
    }
    if (!typed()) {
      if (!props.working) setEditing(false)
      return
    }
    setTyped(false)
    const pending = draft() !== props.value || props.working ? props.onCommit(draft()) : undefined
    if (pending === undefined) setEditing(false)
    else void pending.then(() => { if (resident) setEditing(false) })
  }
  // Disposal settles the draft inside a teardown, where reading a prop can run
  // the parent's stale memos, and one of them can be the owner disposing this
  // field. So while the person edits, this resolves what disposal would do into
  // a plain closure, and the cleanup runs only that closure.
  const closingSettlement = (value: string): (() => void) | undefined => {
    const invalid = props.validate?.(value)
    if (invalid !== undefined) {
      const label = props.label
      return () => { client.report("warning", `${label}: ${invalid}`) }
    }
    if (!typed() || (value === props.value && !props.working)) return undefined
    const save = props.onCommit
    return () => { void save(value) }
  }
  let settleOnClose: (() => void) | undefined
  createComputed(() => {
    settleOnClose = editing() ? closingSettlement(draft()) : undefined
  })
  onCleanup(() => { resident = false; settleOnClose?.() })
  return (
    <span class="sheet-field" classList={{ "sheet-field-full": props.fullWidth }}>
      <button class="sheet-field-value" classList={{ "sheet-field-placeholder": !props.value }} hidden={editing()} aria-disabled={props.disabled || props.working || undefined} aria-busy={props.working || undefined} aria-label={`${props.label}: ${props.value}. Tap to change.`} onClick={begin}>{props.value || props.placeholder}</button>
      <Show when={editing()}>
        <input
          class="sheet-input sheet-field-input"
          type="text"
          inputmode={props.inputMode ?? "text"}
          autocomplete="off"
          aria-label={props.label}
          aria-invalid={problem() !== undefined}
          aria-disabled={props.working || undefined}
          aria-busy={props.working || undefined}
          readOnly={props.working}
          placeholder={props.placeholder}
          value={draft()}
          ref={(element) => queueMicrotask(() => { element.focus(); element.select() })}
          onInput={(event) => { setTyped(true); setDraft(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); event.stopPropagation(); commit(event.key === "Enter" ? "enter" : "leave") }
          }}
          onBlur={() => commit()}
        />
      </Show>
      <Show when={props.working}><span class="sheet-field-status" role="status">Saving…</span></Show>
      <Show when={problem()}>{(message) => <span class="sheet-field-problem" role="alert">{message()}</span>}</Show>
    </span>
  )
}

/** A row that carries an in-place control on the right and, under the label,
 *  the detail and any diagnostic the runtime reported for the value. */
export function SettingRow(props: { readonly label: string; readonly detail?: string; readonly problem?: string; readonly children: JSX.Element }) {
  return (
    <div class="sheet-row setting-row" classList={{ "has-problem": props.problem !== undefined }}>
      <span class="sheet-row-main">
        <span class="sheet-row-label">{props.label}</span>
        <Show when={props.detail}><span class="sheet-row-detail">{props.detail}</span></Show>
        <Show when={props.problem}>{(problem) => <span class="sheet-row-problem">{problem()}</span>}</Show>
      </span>
      <span class="setting-control">{props.children}</span>
    </div>
  )
}
