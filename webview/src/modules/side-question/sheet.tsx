import { createComputed, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { readSideQuestionView, type SideQuestionResult, SIDE_QUESTION_COMMAND_NAME } from "../../../../src/protocol/modules/side-question.js"
import { pageDomainReader } from "../../client/module-domain-views.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { Sheet, SheetEmpty } from "../../app/sheets/sheet.js"
import { useClient } from "../../app/client-context.js"
import { Markdown } from "../../app/markdown-view.js"
import "./sheet.css"

/** Temporary answers read the session domain. Only selection and the unsent follow-up are local. */
export function SideQuestionSheet() {
  const client = useClient()
  const sessionId = client.state().sessionId
  const [draft, setDraft] = createSignal("")
  const [selectedId, setSelectedId] = createSignal<string>()
  const [working, setWorking] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  let disposed = false
  let cancelPending = false
  let input: HTMLTextAreaElement | undefined
  let pendingId: string | undefined
  const stopped = new Set<string>()
  const active = () => !disposed && client.state().sessionId === sessionId && client.state().settings?.moduleIds.includes("side-question") !== false
  const read = pageDomainReader(client.state)
  const view = () => active() ? readSideQuestionView(read) : undefined
  const exchanges = createMemo(() => {
    const source = view()
    if (!source) return []
    return [...source.exchanges.filter((exchange) => exchange.id !== source.current?.id), ...(source.current ? [source.current] : [])]
  })
  const selected = createMemo(() => exchanges().find((exchange) => exchange.id === selectedId()) ?? exchanges().at(-1))
  const index = () => exchanges().findIndex((exchange) => exchange.id === selected()?.id)
  const current = () => view()?.current
  const running = () => current()?.state === "running"
  const retained = () => view()?.exchanges.some((exchange) => exchange.id === selected()?.id) === true
  const stop = (requestId: string | undefined) => {
    if (!sessionId || !requestId || stopped.has(requestId)) return
    stopped.add(requestId)
    void client.connection.dispatch({ type: "side-question.stop", sessionId, requestId }).then((result) => {
      if (!result.ok && !disposed) client.report("warning", result.error)
    }).catch(() => { if (!disposed) client.report("warning", "Could not stop the side question.") })
  }
  const release = (cancel = false) => {
    if (cancel) { cancelPending = true; stop(pendingId) }
    disposed = true
  }
  createComputed(() => {
    if (!active() || client.signal.aborted) {
      release(!client.signal.aborted && client.state().sessionId !== sessionId)
      client.closeSheet()
      return
    }
    pendingId = running() ? current()?.id : undefined
  })
  const retire = () => release()
  client.signal.addEventListener("abort", retire, { once: true })
  onCleanup(() => { retire(); client.signal.removeEventListener("abort", retire) })
  const close = () => { release(true); client.closeSheet(); client.focusComposer() }
  const mutate = async (command: Extract<FrontendMutation, { type: `side-question.${string}` }>): Promise<Extract<SideQuestionResult, { ok: true }> | undefined> => {
    if (!active() || working()) return undefined
    setWorking(true)
    setProblem(undefined)
    try {
      const outcome = await client.connection.dispatch(command)
      if (!outcome.ok) { if (active()) setProblem(outcome.error); return undefined }
      return outcome
    } catch {
      if (active()) setProblem("The side question action failed. Try again.")
      return undefined
    } finally { if (active()) setWorking(false) }
  }
  const ask = async () => {
    const question = draft().trim()
    if (!sessionId || !question || running() || working() || !active()) return
    input?.focus()
    const result = await mutate({ type: "side-question.ask", sessionId, question })
    if (active()) input?.focus()
    if (!result) return
    if (!active()) { if (cancelPending) stop(result.requestId); return }
    setDraft("")
    setSelectedId(result.requestId)
  }
  const keep = async () => {
    const exchange = selected()
    if (!sessionId || !exchange || !retained()) return
    const result = await mutate({ type: "side-question.keep", sessionId, exchangeId: exchange.id })
    if (active() && result?.destinationSessionId) { close(); client.actions.selectSession(result.destinationSessionId) }
  }
  const copy = async () => {
    const answer = selected()?.answer
    if (!answer) return
    if (!client.host.capabilities.writeClipboardText) { setProblem("Clipboard access is not available."); return }
    try { await client.host.capabilities.writeClipboardText(answer); if (active()) client.report("info", "Answer copied.") }
    catch { if (active()) setProblem("Could not copy the answer. Check clipboard access.") }
  }
  return <Sheet title={SIDE_QUESTION_COMMAND_NAME} onClose={close} place={selected()?.id} footer={
    <div class="side-question-footer">
      <Show when={current()}>
        <p role="status" class="side-question-note">{current()?.state === "running" ? current()?.answer ? "Answering…" : "Waiting for answer…" : current()?.state === "stopped" ? "Stopped" : current()?.state === "error" ? current()?.error ?? "The side question failed." : "Answered"}</p>
      </Show>
      <Show when={problem()}><p role="alert" class="side-question-error">{problem()}</p></Show>
      <div class="side-question-actions">
        <button class="secondary" disabled={!selected()?.answer} onClick={() => { void copy() }}>Copy</button>
        <button class="secondary" disabled={working() || !retained()} onClick={() => { void keep() }}>Keep as fork</button>
        <button class="ghost-text" disabled={working() || !view() || exchanges().length === 0} onClick={() => {
          const source = view()
          if (sessionId && source) void mutate({ type: "side-question.clear", sessionId, revision: source.revision })
        }}>Clear</button>
        <Show when={running()}><button class="secondary" onClick={() => stop(pendingId)}>Stop</button></Show>
      </div>
      <form class="side-question-form" aria-busy={working() || undefined} onSubmit={(event) => { event.preventDefault(); void ask() }}>
        <label for="side-question-input">Follow-up question</label>
        <textarea ref={(element) => { input = element }} id="side-question-input" data-autofocus rows={2} value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} placeholder="Ask a side question" onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void ask() }
        }} />
        <button class="primary" type="submit" disabled={working() || running() || !draft().trim()}>Ask</button>
      </form>
    </div>
  }>
    <div class="side-question">
      <p class="side-question-note">Temporary · no tools</p>
      <nav class="side-question-actions" aria-label="Side question history">
        <button class="ghost-text" disabled={index() <= 0} onClick={() => setSelectedId(exchanges()[index() - 1]?.id)}>Previous</button>
        <span>{exchanges().length ? `${index() + 1} of ${exchanges().length}` : "No history"}</span>
        <button class="ghost-text" disabled={index() >= exchanges().length - 1} onClick={() => setSelectedId(exchanges()[index() + 1]?.id)}>Next</button>
      </nav>
      <Show when={selected()} fallback={<SheetEmpty>Ask a side question. The main agent keeps working.</SheetEmpty>}>
        <h3 class="side-question-source">{selected()?.question}</h3>
        <div aria-label="Answer" class="side-question-answer">
          <Markdown class="block assistant" source={selected()?.answer ?? ""} />
        </div>
      </Show>
    </div>
  </Sheet>
}
