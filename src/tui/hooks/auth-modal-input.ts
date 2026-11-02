import { createControlledTextEditor, SINGLE_LINE_TEXT_ENTRY_POLICY, type ControlledTextEditor, type TextEditorPresentation } from "../keymap/text-entry.js"
import type { ListModalKeyEvent } from "../components/modal-list-keys.js"
import type { AuthView } from "./auth-modal-options.js"

interface AuthModalInputDeps {
  view: () => AuthView
  draft: () => { apiKey: string; text: string }
  setApiKeyDraft: (value: string) => void
  setTextDraft: (value: string) => void
  submitApiKey: () => void
  /** Answers the login flow's question, or gives it the code that a browser login's page shows. */
  submitTextAnswer: () => void
  handleSettingKey: (event: ListModalKeyEvent, editor: ControlledTextEditor) => void
  beginSettingEdit: () => void
  submitProfileDelete: () => void
  setLoginChoice: (view: Extract<AuthView, { kind: "login-question" }>) => void
  answerLoginQuestion: (login: boolean) => void
  setConfirmationChoice: (view: Extract<AuthView, { kind: "login-confirmation" }>) => void
  answerLoginConfirmation: (replace: boolean) => void
  navigateToList: () => void
  setDeleteConfirmation: (view: Extract<AuthView, { kind: "profile-delete-confirmation" }>) => void
  navigateToProfile: () => void
  closeAuthModal: () => void
  returnToProviderList: () => void
  copyDeviceCode: () => void
  handleListKey: (event: ListModalKeyEvent) => void
  handleProviderModelsKey: (event: ListModalKeyEvent) => void
}

export function createAuthModalInput(deps: AuthModalInputDeps) {
  const apiKeyEditor = createControlledTextEditor({ value: () => deps.draft().apiKey, setValue: deps.setApiKeyDraft, policy: SINGLE_LINE_TEXT_ENTRY_POLICY, history: "disabled" })
  const promptEditor = createControlledTextEditor({ value: () => deps.draft().text, setValue: deps.setTextDraft, policy: SINGLE_LINE_TEXT_ENTRY_POLICY })
  // The code or address that a browser login's page shows is a credential step, so it keeps no history.
  const browserCodeEditor = createControlledTextEditor({ value: () => deps.draft().text, setValue: deps.setTextDraft, policy: SINGLE_LINE_TEXT_ENTRY_POLICY, history: "disabled" })
  const renameEditor = createControlledTextEditor({ value: () => deps.draft().text, setValue: deps.setTextDraft, policy: SINGLE_LINE_TEXT_ENTRY_POLICY })
  const profileEditor = createControlledTextEditor({ value: () => deps.draft().text, setValue: deps.setTextDraft, policy: SINGLE_LINE_TEXT_ENTRY_POLICY })

  function runEditor(editor: ControlledTextEditor, evt: ListModalKeyEvent, submit: () => void, cancel: () => void): void {
    const result = editor.handleKey(evt)
    if (result === "submit") submit()
    else if (result === "cancel") cancel()
  }

  /** The keys of a question with two buttons: escape, a move between the buttons, and the answer of the focused one. */
  function twoChoiceKey(evt: ListModalKeyEvent, escape: () => void, move: () => void, answer: () => void): void {
    const action = evt.name === "escape" ? escape : evt.name === "left" || evt.name === "right" || evt.name === "tab" ? move : evt.name === "enter" || evt.name === "return" ? answer : undefined
    if (action === undefined) return
    evt.preventDefault?.()
    action()
  }

  function handleKey(evt: ListModalKeyEvent): void {
    const view = deps.view()
    switch (view.kind) {
      case "login-question":
        if (view.submitting) {
          if (evt.name === "escape") { evt.preventDefault?.(); deps.closeAuthModal() }
          return
        }
        twoChoiceKey(evt, deps.closeAuthModal, () => deps.setLoginChoice({ ...view, choice: view.choice === "login" ? "decline" : "login" }), () => deps.answerLoginQuestion(view.choice === "login"))
        return
      case "login-confirmation":
        if (view.submitting) {
          if (evt.name === "escape") { evt.preventDefault?.(); deps.closeAuthModal() }
          return
        }
        twoChoiceKey(evt, () => deps.answerLoginConfirmation(false), () => deps.setConfirmationChoice({ ...view, choice: view.choice === "replace" ? "keep" : "replace" }), () => deps.answerLoginConfirmation(view.choice === "replace"))
        return
      case "list":
        deps.handleListKey(evt)
        return
      case "provider-models":
        if (evt.name === "left") { evt.preventDefault?.(); deps.returnToProviderList(); return }
        deps.handleProviderModelsKey(evt)
        return
      case "api-key-input":
        runEditor(apiKeyEditor, evt, deps.submitApiKey, deps.navigateToList)
        return
      case "login-prompt":
        runEditor(promptEditor, evt, deps.submitTextAnswer, deps.navigateToList)
        return
      case "rename-input":
        deps.handleSettingKey(evt, renameEditor)
        return
      case "profile-create-input":
      case "profile-rename-input":
        deps.handleSettingKey(evt, profileEditor)
        return
      case "profile-delete-confirmation":
        if (evt.name === "escape") { evt.preventDefault?.(); deps.navigateToProfile(); return }
        if ((evt.name === "up" || evt.name === "down") && view.phase === "ready" && view.preview.kind === "choose") {
          evt.preventDefault?.()
          const candidates = view.preview.candidates
          const index = candidates.findIndex((candidate) => candidate.id === view.successorId)
          const next = candidates[(index + (evt.name === "down" ? 1 : candidates.length - 1)) % candidates.length]
          if (next) deps.setDeleteConfirmation({ ...view, successorId: next.id })
          return
        }
        if (evt.name === "left" || evt.name === "right" || evt.name === "tab") {
          evt.preventDefault?.()
          const next = view.choice === "cancel" ? "confirm" : "cancel"
          deps.setDeleteConfirmation({ ...view, choice: next })
          return
        }
        if (evt.name === "enter" || evt.name === "return") {
          evt.preventDefault?.()
          deps.submitProfileDelete()
        }
        return
      case "device-code":
        if (evt.name === "escape") { evt.preventDefault?.(); deps.closeAuthModal(); return }
        if (evt.name === "left") { evt.preventDefault?.(); if (view.question) deps.closeAuthModal(); else deps.navigateToList(); return }
        if (evt.name === "c") { evt.preventDefault?.(); deps.copyDeviceCode() }
        return
      case "browser-auth":
        // The left arrow moves through a typed code, and goes back to the list from an empty field.
        if (evt.name === "left" && deps.draft().text === "") { evt.preventDefault?.(); if (view.question) deps.closeAuthModal(); else deps.navigateToList(); return }
        runEditor(browserCodeEditor, evt, deps.submitTextAnswer, deps.closeAuthModal)
        return
    }
  }

  function handlePaste(text: string): void {
    const view = deps.view()
    const editor = textEditorOf(view)
    editor?.handlePaste(text)
  }

  function presentation(): TextEditorPresentation {
    const view = deps.view()
    const editor = textEditorOf(view)
    return editor?.presentation() ?? { value: "", cursor: 0, selection: null, preferredVisualColumn: null }
  }

  function prepare(): void {
    deps.beginSettingEdit()
    reset()
    const view = deps.view()
    const editor = view.kind === "rename-input" ? renameEditor
      : view.kind === "profile-create-input" || view.kind === "profile-rename-input" ? profileEditor : undefined
    if (editor !== undefined) editor.setSelection(0, deps.draft().text.length)
  }

  function reset(): void {
    for (const editor of [apiKeyEditor, promptEditor, browserCodeEditor, renameEditor, profileEditor]) editor.resetEphemeralState()
  }

  /** The text field that a view shows, if it shows one. */
  function textEditorOf(view: AuthView): ControlledTextEditor | undefined {
    switch (view.kind) {
      case "api-key-input": return apiKeyEditor
      case "login-prompt": return promptEditor
      case "browser-auth": return browserCodeEditor
      case "rename-input": return renameEditor
      case "profile-create-input":
      case "profile-rename-input": return profileEditor
      default: return undefined
    }
  }

  return { handleKey, handlePaste, presentation, prepare, reset }
}
