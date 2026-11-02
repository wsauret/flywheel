import { createSignal, untrack } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import type { ListModalKeyEvent } from "../components/modal-list-keys.js"
import type { ControlledTextEditor } from "../keymap/text-entry.js"
import type { SettingsEditResult, SettingsEditSpec } from "./settings-modal-types.js"

interface EditTarget {
  readonly id: string
  readonly edit: SettingsEditSpec
  readonly action?: boolean
}

/** Completes terminal settings edits. Synchronous refusals keep Enter in the
 * field; leaving reports the reason and restores the saved row. Promises own
 * the saving indicator until the durable write settles, even after blur. */
export function createTerminalSettingEdit(deps: {
  target: () => EditTarget | undefined
  draft: () => string
  leave: () => void
  setError: (error: string | undefined) => void
  onError: (error: string) => void
}) {
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
  let generation = 0
  let inputAttempted = false
  const saving = (id: string): boolean => pending().has(id)
  function begin(): void {
    generation++
    inputAttempted = false
    deps.setError(undefined)
  }
  function finish(leaving = false): void {
    const target = deps.target()
    if (!target) return
    if (saving(target.id)) {
      if (leaving) deps.leave()
      return
    }
    const text = deps.draft()
    if (!target.action && ((!inputAttempted && text === "" && target.edit.initialDraft() === "") || (target.edit.formatDraft?.(text) ?? text).trim() === target.edit.current().trim())) {
      deps.leave()
      return
    }
    const started = generation
    const isCurrent = (): boolean => generation === started && deps.target()?.id === target.id
    const report = (result: SettingsEditResult, durable: boolean): void => {
      if (!result.ok) {
        if (leaving || (durable && !target.action) || !isCurrent()) deps.onError(result.error)
        else { deps.setError(result.error); return }
      }
      if (isCurrent()) deps.leave()
    }
    const result = target.edit.submit(text)
    if (!(result instanceof Promise)) { report(result, false); return }
    setPending((ids) => new Set([...ids, target.id]))
    if (leaving) deps.leave()
    void result.then(
      (settled) => untrack(() => report(settled, true)),
      (error: unknown) => untrack(() => report({ ok: false, error: errorMessage(error) }, true)),
    ).finally(() => setPending((ids) => {
      const next = new Set(ids)
      next.delete(target.id)
      return next
    }))
  }
  function handleKey(event: ListModalKeyEvent, editor: ControlledTextEditor): "leave" | "edit" {
    const target = deps.target()
    if (!target) return "edit"
    const name = event.name.toLowerCase()
    if (["escape", "tab", "up", "down"].includes(name) && !event.ctrl && !event.meta && !event.shift) {
      event.preventDefault?.()
      if (target.action && name === "escape") deps.leave()
      else finish(true)
      return "leave"
    }
    if (saving(target.id)) return "edit"
    if (editor.handleKey(event) === "submit") finish()
    return "edit"
  }
  return { begin, finish, handleKey, saving, noteInput: () => { inputAttempted = true } }
}
