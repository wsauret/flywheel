import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import { readSideQuestionView } from "../../../protocol/modules/side-question.js"
import type { TuiControllerHost } from "../../tui-module.js"
import type { ListModalKeyEvent } from "../../components/modal-list-keys.js"
import { createModalScrollController } from "../../components/modal-scroll-controller.js"

type Host = Pick<TuiControllerHost, "enabled" | "read" | "client" | "showToast" | "navigate" | "clipboard">
type Request = Extract<Parameters<Host["client"]["dispatch"]>[0], { type: `side-question.${string}` }>
const QUESTION_LIMIT = 8000

/** Each opening owns only its draft, selection and operation progress. */
export function createSideQuestionModel(host: Host, sessionId: string, closeModal: () => void) {
  const [draft, setDraft] = createSignal("")
  const [selection, setSelection] = createSignal<string>()
  const [pending, setPending] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [focus, setFocus] = createSignal(0)
  const scroll = createModalScrollController()
  let input: TextareaRenderable | undefined
  const view = () => readSideQuestionView(host.read)
  const rows = createMemo(() => {
    const snapshot = view()
    if (!snapshot) return []
    const current = snapshot.current
    return current ? [...snapshot.exchanges.filter((row) => row.id !== current.id), current] : snapshot.exchanges
  })
  const selected = () => rows().find((row) => row.id === selection()) ?? rows().at(-1)
  const retained = () => view()?.exchanges.some((row) => row.id === selected()?.id) ?? false
  const request = () => { const current = view()?.current; return current?.id === selected()?.id ? current : undefined }
  const running = () => { const current = view()?.current; return current?.state === "running" ? current.id : undefined }
  let active = true
  let cancelOnRetirement = false
  let displayedPending: string | undefined = running()
  createEffect(on(running, (id) => { displayedPending = id }))
  const report = (message: string) => {
    if (active) { setError(message); scroll.scrollTo(0) }
    else host.showToast({ message, variant: "error" })
  }
  const cancel = () => {
    const requestId = displayedPending
    displayedPending = undefined
    if (!requestId) return
    void host.client.dispatch({ type: "side-question.stop", sessionId, requestId }).then((result) => {
      if (!result.ok) report(result.error)
    }).catch(() => report("Could not stop the side question."))
  }
  onCleanup(() => {
    active = false
    // Settings retire UI admission before withdrawing cached domain views.
    cancelOnRetirement ||= host.enabled()
    if (cancelOnRetirement) cancel()
    input?.blur(); input = undefined; scroll.detach()
  })
  const close = () => { cancelOnRetirement = true; cancel(); closeModal() }
  const run = async (label: string, mutation: Request) => {
    if (!active || pending()) return
    setPending(label)
    setError(undefined)
    try {
      const result = await host.client.dispatch(mutation)
      if (!active) {
        if (cancelOnRetirement && mutation.type === "side-question.ask" && result.ok && result.requestId) {
          void host.client.dispatch({ type: "side-question.stop", sessionId, requestId: result.requestId }).then((stopped) => { if (!stopped.ok) report(stopped.error) }).catch(() => report("Could not stop the side question."))
        }
        return
      }
      if (!result.ok) { report(result.error); return }
      return result
    } catch { if (active) report("Side question action failed. Try again.") }
    finally { if (active) setPending(undefined) }
  }
  const ask = async () => {
    const originalDraft = draft()
    const question = originalDraft.trim()
    if (!question || question.length > QUESTION_LIMIT || view()?.current?.state === "running") return
    const result = await run("Asking...", { type: "side-question.ask", sessionId, question })
    if (result) { if (draft() === originalDraft) setDraft(""); setSelection(undefined) }
  }
  const stop = async () => {
    const requestId = running()
    if (requestId) {
      const result = await run("Stopping...", { type: "side-question.stop", sessionId, requestId })
      if (result && displayedPending === requestId) displayedPending = undefined
    }
  }
  const clear = async () => {
    const snapshot = view()
    if (snapshot) await run("Clearing...", { type: "side-question.clear", sessionId, revision: snapshot.revision })
  }
  const keep = async () => {
    const row = selected()
    if (!row || !retained()) return
    const result = await run("Keeping...", { type: "side-question.keep", sessionId, exchangeId: row.id })
    if (result?.destinationSessionId) { close(); host.navigate.navigateSession(result.destinationSessionId) }
  }
  const copy = async () => {
    const answer = selected()?.answer
    if (!answer) return
    try { await host.clipboard.copy(answer) }
    catch { report("Could not copy the answer.") }
  }
  const browse = (direction: -1 | 1) => {
    const index = rows().findIndex((row) => row.id === selected()?.id)
    const row = rows()[Math.max(0, Math.min(rows().length - 1, index + direction))]
    if (row) { setSelection(row.id); scroll.reset() }
  }
  const attach = (prompt: TextareaRenderable) => {
    input = prompt
    prompt.onContentChange = () => setDraft(prompt.plainText)
    createEffect(on(draft, (text) => { if (prompt.plainText !== text) prompt.setText(text) }))
    prompt.focus()
  }
  const actions = [copy, clear, stop, keep, close]
  const browseControls = 2
  const key = (event: ListModalKeyEvent) => {
    const name = event.name.toLowerCase()
    if (name === "escape") close()
    else if (name === "tab") {
      const controls = browseControls + actions.length
      const next = (focus() + (event.shift ? controls : 1)) % (controls + 1)
      setFocus(next)
      if (next === 0) input?.focus(); else input?.blur()
    } else if (name === "pageup") scroll.pageBy(-1)
    else if (name === "pagedown") scroll.pageBy(1)
    else if ((name === "enter" || name === "return") && focus() > 0) {
      const control = focus()
      if (control <= browseControls) browse(control === 1 ? -1 : 1)
      else void actions[control - browseControls - 1]?.()
    }
    else return
    event.preventDefault?.()
  }
  const paste = (text: string) => { if (focus() === 0) input?.insertText(text) }
  return { questionLimit: QUESTION_LIMIT, draft, setDraft, view, rows, selected, retained, request, running, pending, error, ask, stop, clear, keep, copy, browse, close, focus, attach, key, paste, scroll }
}

export type SideQuestionModel = ReturnType<typeof createSideQuestionModel>
