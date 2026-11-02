import { createSignal, For, Show } from "solid-js"

import { trapFocus } from "./focus-trap.js"
import type { ConfirmRequest, PromptRequest } from "./client-context.js"
import "../styles/dialogs.css"

/** The client's own dialogs and transient messages.
 *
 *  These exist in the client rather than as host capabilities because a phone
 *  has no host dialog to lend, and a confirmation that appears in one host and
 *  not another is a different product in each. One implementation, themed by
 *  the host's tokens, reads as native in both. */

export interface Toast {
  readonly id: number
  readonly severity: "info" | "warning"
  readonly message: string
}

export function Toasts(props: { readonly toasts: readonly Toast[]; readonly onDismiss: (id: number) => void }) {
  return (
    <Show when={props.toasts.length > 0}>
      <div class="toasts" role="status" aria-live="polite">
        <For each={props.toasts}>
          {(toast) => (
            <div class="toast" classList={{ [`toast-${toast.severity}`]: true }}>
              <span class="toast-mark" aria-hidden="true">{toast.severity === "warning" ? "!" : "i"}</span>
              <span class="toast-text">{toast.message}</span>
              <button class="toast-dismiss" aria-label="Dismiss" onClick={() => props.onDismiss(toast.id)}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" /></svg>
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export function ConfirmDialog(props: { readonly request: ConfirmRequest; readonly onSettle: (confirmed: boolean) => void }) {
  let root: HTMLDivElement | undefined
  trapFocus(() => root)
  return (
    <div class="scrim" onClick={(event) => { if (event.target === event.currentTarget) props.onSettle(false) }}>
      <div
        class="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={(el) => (root = el)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onSettle(false) } }}
      >
        <h2 class="dialog-title" id="dialog-title">{props.request.title}</h2>
        <Show when={props.request.detail}><p class="dialog-detail">{props.request.detail}</p></Show>
        <div class="dialog-actions">
          <button class="ghost-text" data-autofocus={props.request.cancelByDefault ? "" : undefined} onClick={() => props.onSettle(false)}>{props.request.cancelLabel ?? "Cancel"}</button>
          <button class={props.request.destructive === true ? "danger" : "primary"} data-autofocus={props.request.cancelByDefault ? undefined : ""} onClick={() => props.onSettle(true)}>{props.request.confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

export function PromptDialog(props: { readonly request: PromptRequest; readonly onSettle: (value: string | undefined) => void }) {
  let root: HTMLDivElement | undefined
  const [value, setValue] = createSignal(props.request.initialValue ?? "")
  const problem = () => props.request.validate?.(value())
  const secondaryProblem = () => props.request.secondaryField?.validate?.()
  const invalid = () => problem() !== undefined || secondaryProblem() !== undefined
  const submit = () => {
    if (invalid()) return
    props.onSettle(value())
  }
  trapFocus(() => root)
  return (
    <div class="scrim" onClick={(event) => { if (event.target === event.currentTarget) props.onSettle(undefined) }}>
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={(el) => (root = el)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onSettle(undefined) } }}
      >
        <h2 class="dialog-title" id="dialog-title">{props.request.title}</h2>
        <Show when={props.request.detail}><p class="dialog-detail">{props.request.detail}</p></Show>
        <Show when={props.request.secondaryField}>{(field) => (
          <div class="dialog-field">
            <label for="dialog-secondary-input">{field().label}</label>
            <input
              id="dialog-secondary-input"
              class="dialog-input"
              type="text"
              data-autofocus
              value={field().initialValue}
              maxLength={field().maxLength}
              aria-invalid={secondaryProblem() !== undefined}
              aria-describedby={secondaryProblem() !== undefined ? "dialog-secondary-problem" : undefined}
              onInput={(event) => field().onChange(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit() } }}
            />
            <Show when={secondaryProblem()}><p id="dialog-secondary-problem" class="dialog-problem" role="alert">{secondaryProblem()}</p></Show>
          </div>
        )}</Show>
        <div class="dialog-field">
          <Show when={props.request.label}><label for="dialog-input">{props.request.label}</label></Show>
          <input
            id="dialog-input"
            class="dialog-input"
            type="text"
            data-autofocus={props.request.secondaryField === undefined ? "" : undefined}
            value={value()}
            placeholder={props.request.placeholder}
            aria-label={props.request.label === undefined ? props.request.title : undefined}
            aria-invalid={problem() !== undefined}
            aria-describedby={problem() !== undefined ? "dialog-problem" : undefined}
            onInput={(event) => setValue(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit() } }}
          />
          <Show when={problem()}><p id="dialog-problem" class="dialog-problem" role="alert">{problem()}</p></Show>
        </div>
        <div class="dialog-actions">
          <button class="ghost-text" onClick={() => props.onSettle(undefined)}>Cancel</button>
          <button class="primary" disabled={invalid()} onClick={submit}>{props.request.confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
