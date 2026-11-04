/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid"
import { KeyEvent as NativeKeyEvent, RenderableEvents, StyledText, fg as stFg, type TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, untrack, type Accessor } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { OutputWindowCommandType } from "../output-window/output-window.js"
import type { SessionSurface } from "../hooks/create-session-surface.js"
import type { TextEntryKeyEvent } from "../keymap/text-entry.js"
import { useTheme } from "../context/theme.js"
import { Button } from "./button.js"
import { dispatchInterrupt, offeredSessionControls, resumeMutation, sessionControls, stopMutation, type ControlRefusal } from "../../protocol/client/session-controls.js"
import { sessionHeaderParts } from "../hooks/create-header-display.js"
import { ModalFrame, MODAL_FRAME_HORIZONTAL_INSET, sessionViewerBodyHeight, sessionViewerWidth } from "./modal-frame.js"
import { bindStyledTextContent } from "../utils/reactive-text.js"
import { ChildSessionBody, type ChildMessaging, type ChildSessionBodyInput, type ChildSessionBodyProps } from "./child-session-body.js"
import { normalizeChatInput } from "../../infra/chat-input.js"
import { recallOnUp } from "./composer-recall.js"
import type { ChatSubmissions } from "../../protocol/client/chat-submissions.js"

type KeyEvent = TextEntryKeyEvent

/** Formats the child viewer's aggregate statistics. Loading replaces all
 * historical values and does not read the live elapsed timer. */
export function childSessionStats(surface: Pick<SessionSurface, "budget" | "elapsed" | "summary">, width: number, threshold: number | undefined): string {
  const parts = sessionHeaderParts({
    ...surface,
    elapsed: () => surface.budget()?.totalsLoading || surface.summary()?.totalsLoading ? 0 : surface.elapsed(),
  }, width, threshold)
  return parts.before + parts.context + parts.after
}

export interface ChildSessionViewerInput extends ChildSessionBodyInput {
  finish(): void
  onKey(event: KeyEvent): void
  onPaste(text: string): void
  /** The viewer binds what Left does while the composer is empty or
   *  absent: going back (`close`), as a workflow agent's view does, or
   *  `none`, as a subagent's viewer answers, and Left then moves the
   *  cursor. */
  bindBack(back: () => "close" | "none"): void
  /** The viewer binds what Tab and Shift+Tab do: move to the next or the
   *  previous agent of a workflow, which answers true when the view has
   *  agents to move through. */
  bindAgentMove(move: (direction: 1 | -1) => boolean): void
}

const NO_MESSAGING: ChildMessaging = { admits: () => false, shown: () => false, send: async () => false }

/** One viewer-local input owner, so mounting and popping nested viewers
 * preserves its identity and its draft. A child asks its parent, never the
 * person, so the viewer routes no question input (PI-AGENT-024). */
export function createChildSessionViewerInput(deps: {
  onClose: () => void
  /** Routes slash text the way the chat composer does, and resolves true
   *  when a command took it. Slash text is never a message to the agent. */
  dispatchCommand: (text: string) => Promise<boolean>
}): ChildSessionViewerInput {
  const [text, setText] = createSignal("")
  const [lines, setLines] = createSignal(1)
  let prompt: TextareaRenderable | undefined
  let dispatchOutput: ((command: OutputWindowCommandType) => void) | undefined
  let messaging = NO_MESSAGING
  let back: () => "close" | "none" = () => "none"
  let moveAgent: (direction: 1 | -1) => boolean = () => false
  let submitting = false
  let finished = false
  function writeDraft(value: string): void {
    if (prompt) { prompt.clear(); prompt.insertText(value); sync() }
    else setText(value)
  }
  function sync(): void {
    const nextText = prompt?.plainText ?? ""
    setText(nextText)
    setLines(Math.max(1, prompt?.editorView.getTotalVirtualLineCount() ?? 1))
  }
  function returnDraft(): void {
    if (!finished || submitting) return
    const value = prompt?.plainText ?? untrack(text)
    const id = messaging.sessionId?.()
    if (value.length > 0 && id && messaging.returnToParent) {
      messaging.returnToParent(id, { text: value })
      writeDraft("")
    }
  }
  function submit(): void {
    if (!messaging.admits()) return
    if (!messaging.shown()) return
    const raw = prompt?.plainText ?? untrack(text)
    const value = raw.trim()
    if (!value || submitting) return
    submitting = true
    const submission = value.startsWith("/") ? deps.dispatchCommand(value) : messaging.send(value)
    void submission.then((accepted) => {
      const current = prompt?.plainText ?? untrack(text)
      if (accepted && current.startsWith(raw)) writeDraft(current.slice(raw.length))
    }).finally(() => { submitting = false; returnDraft() })
  }
  return {
    text,
    lines,
    finish() { finished = true; returnDraft() },
    attach(value) {
      prompt = value
      // The draft outlives the textarea: a composer that hides and shows
      // again takes the draft back.
      value.once(RenderableEvents.DESTROYED, () => { if (prompt === value) prompt = undefined })
      const draft = untrack(text)
      if (draft.length > 0 && value.plainText.length === 0) value.insertText(draft)
      value.onContentChange = sync
      value.onCursorChange = sync
      sync()
    },
    focus() { prompt?.focus() },
    onKey(event) {
      event.preventDefault?.()
      if (event.name === "escape") { deps.onClose(); return }
      if (event.name === "left" && (!messaging.shown() || untrack(text) === "") && back() === "close") {
        deps.onClose()
        return
      }
      if (event.name === "tab" && moveAgent(event.shift === true ? -1 : 1)) return
      if (event.name === "pageup" || event.name === "pagedown") {
        dispatchOutput?.(event.name === "pageup" ? "page-up" : "page-down")
        return
      }
      if (!messaging.shown()) return
      finished = false
      if (event.name === "up" && prompt && recallOnUp({
        ready: messaging.ready?.() ?? true, row: prompt.editorView.getCursor().row, text: prompt.plainText, active: true,
        queued: () => {
          const owner = messaging
          const sessionId = owner.sessionId?.()
          return owner.recall?.().then((recalled) => {
            if (!recalled) return null
            if (finished || sessionId !== messaging.sessionId?.()) { if (sessionId) owner.returnToParent?.(sessionId, recalled); return null }
            return recalled
          }) ?? null
        },
        restore: () => {},
        settle: (pending) => {
          void Promise.resolve(pending).then((recalled) => {
            if (!recalled) return
            const value = normalizeChatInput(recalled).text
            const existing = prompt?.plainText ?? untrack(text)
            const merged = existing ? `${existing}\n\n${value}` : value
            writeDraft(merged)
            returnDraft()
          })
        },
      })) return
      prompt?.handleKeyPress(new NativeKeyEvent({
        name: event.name, ctrl: event.ctrl ?? false, meta: event.meta ?? false, shift: event.shift ?? false,
        super: event.super, option: false, number: false, sequence: event.sequence ?? event.raw ?? event.name,
        raw: event.raw ?? event.sequence ?? "", eventType: "press", source: "raw",
      }))
      sync()
    },
    onPaste(pastedText) {
      if (!messaging.shown()) return
      prompt?.insertText(pastedText)
      sync()
    },
    submit,
    bindOutput(dispatch) { dispatchOutput = dispatch },
    bindMessaging(value) { messaging = value },
    bindBack(value) { back = value },
    bindAgentMove(value) { moveAgent = value },
  }
}

export interface ChildSessionViewerProps extends Omit<ChildSessionBodyProps,
  "surface" | "width" | "height" | "header" | "navigation" | "messaging" | "placeholder" | "controls" | "input" | "agentKind"> {
  createSurface: (sessionId: () => string | undefined) => SessionSurface
  input: ChildSessionViewerInput
  appService: Pick<RuntimeClient, "dispatch" | "query">
  submissions: Pick<ChatSubmissions, "send" | "recallQueued">
  onClose: () => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => void
  compactionThreshold: Accessor<number | undefined>
  returnDraft?: (sourceSessionId: string, input: import("../../infra/chat-input.js").ChatInputLike) => void
  inputReady?: Accessor<boolean>
}

/** A subagent is an ordinary session inside modal chrome. Only navigation
 * is specialized: child links push another viewer and Close pops this one.
 * A workflow opens as its full-size card instead. */
export function ChildSessionViewer(props: ChildSessionViewerProps) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const surface = untrack(() => props.createSurface(() => props.sessionId))
  const width = createMemo(() => sessionViewerWidth(dimensions().width))
  const contentWidth = () => width() - MODAL_FRAME_HORIZONTAL_INSET
  const height = createMemo(() => sessionViewerBodyHeight(dimensions().height))
  const summary = surface.summary
  // The row is the one reader of what the child admits (ARCH-PROTOCOL-050); every
  // control below derives from it and none holds its own state.
  const controls = createMemo(() => sessionControls(summary() ?? undefined))
  // Interrupt only while the child runs, Resume only while it does not.
  const offered = createMemo(() => offeredSessionControls(summary() ?? undefined, surface.interruptible()))
  // Stop terminates the parent's tool call, so it names the parent session,
  // not this child.
  const stop = createMemo(() => stopMutation(summary() ?? undefined))
  const stopControl = (mutation: ReturnType<typeof stopMutation>) => mutation === undefined ? {} : { stop: () => { void props.appService.dispatch(mutation).then(report) } }
  const messageable = createMemo(() => controls().message)
  createEffect(() => {
    const row = summary()
    if (props.inputReady?.() !== false && row?.kind === "subagent" && (row.runOutcome === "completed" || row.runOutcome === "partial")) untrack(() => props.input.finish())
  })
  // A message reads the same row as every other control, so a message the
  // row does not admit is never sent, and a refused one shows its reason.
  const send = async (text: string): Promise<boolean> => {
    if (!messageable()) return false
    try {
      const outcome = await props.submissions.send(props.sessionId, { text })
      if (outcome.kind === "draft_kept") { props.showToast({ message: outcome.error, variant: "warning" }); return false }
      return outcome.kind === "failed" ? report({ ok: false, error: outcome.error }) : true
    } catch (error) {
      props.showToast({ message: `Message failed: ${errorMessage(error)}`, variant: "error" })
      return false
    }
  }
  const recallQueuedMessage = () => props.appService.query({ type: "recallQueuedMessage", sessionId: props.sessionId })
  const recall = () => props.submissions.recallQueued(props.sessionId, recallQueuedMessage)
  const interrupt = () => {
    const row = summary()
    if (row) void dispatchInterrupt(props.appService, row).then(reportRefusal)
  }
  const resume = () => {
    const row = summary()
    if (row) void props.appService.dispatch(resumeMutation(row)).then(report)
  }
  const statsContent = createMemo(() => new StyledText([stFg(theme.text)(childSessionStats(surface, dimensions().width, props.compactionThreshold()))]))
  const reportRefusal = (refusal: ControlRefusal | undefined): void => {
    if (refusal) props.showToast({ message: `Interrupt failed: ${refusal.reason}`, variant: refusal.variant })
  }
  const report = (result: { ok: true } | { ok: false; error: string }): boolean => {
    if (result.ok) return true
    props.showToast({ message: result.error, variant: "error" })
    return false
  }
  return <ModalFrame title={summary()?.title || "Child session"} width={width()} onClose={props.onClose}>
    <ChildSessionBody {...props} agentKind="subagent" surface={surface} width={contentWidth()} height={height()}
      messaging={{ admits: messageable, shown: messageable, send, sessionId: () => props.sessionId,
        ready: props.inputReady,
        returnToParent: props.returnDraft ? (id, input) => {
          props.returnDraft?.(id, input)
          props.showToast({ message: "This subagent finished. Your unsent draft is in the parent chat's composer.", variant: "info" })
        } : undefined,
        recall }}
      placeholder="Message this subagent"
      controls={() => ({
        ...(offered().primary === "interrupt" ? { interrupt } : {}),
        ...(offered().primary === "resume" ? { resume } : {}),
        ...stopControl(stop()),
      })}
      navigation={<Button label="Close" hotkey="esc" muted onPress={props.onClose} />}
      header={<box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.textMuted}>{props.sessionId}</text>
        <text ref={bindStyledTextContent(statsContent)} overflow="hidden" wrapMode="none" />
      </box>} />
  </ModalFrame>
}
