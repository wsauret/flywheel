/** @jsxImportSource @opentui/solid */

/**
 * Single dispatch point for the pending-question form's keyboard handling,
 * mirroring modal-stack.ts's shape. QuestionDock is not a modal overlay
 * (it renders inline in the prompt area, not via the modal stack's portal),
 * so it needs its own registration slot rather than joining `ModalContext`'s
 * stack - but the goal is the same: one authority a top-level `useKeyboard`
 * listener calls into, instead of the form registering its own independent
 * global listener that runs unconditionally regardless of what else is
 * focused (a real modal opened over a pending question previously received
 * the same keystroke as the question form, with neither aware of the other).
 */

import { createContext, type ParentProps, useContext } from "solid-js"

type KeyHandler = (evt: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string; raw?: string; preventDefault?: () => void }) => boolean
type PasteHandler = (text: string) => void

export interface QuestionInputContext {
  register(handlers: { onKey: KeyHandler; onPaste: PasteHandler }): void
  clear(): void
  input(evt: Parameters<KeyHandler>[0]): boolean
  /** While a question is pending, the prompt textarea (the only other paste
   *  receiver) is unmounted - a paste with no modal on top and no active
   *  question form previously vanished with no feedback. */
  paste(text: string): boolean
}

export function createQuestionInputRegistry(): QuestionInputContext {
  let active: { onKey: KeyHandler; onPaste: PasteHandler } | undefined
  return {
    register(handlers) { active = handlers },
    clear() { active = undefined },
    input(evt) {
      if (!active) return false
      return active.onKey(evt)
    },
    paste(text) {
      if (!active) return false
      active.onPaste(text)
      return true
    },
  }
}

const QuestionInputCtx = createContext<QuestionInputContext>()

export function useQuestionInput(): QuestionInputContext {
  const ctx = useContext(QuestionInputCtx)
  if (!ctx) throw new Error("useQuestionInput must be used within QuestionInputProvider")
  return ctx
}

export function QuestionInputProvider(props: ParentProps) {
  return <QuestionInputCtx.Provider value={createQuestionInputRegistry()}>{props.children}</QuestionInputCtx.Provider>
}
