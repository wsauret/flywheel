import type { ModuleRowAction } from "../../protocol/protocol-module.js"
import type { ProjectFileEntry } from "../../protocol/transcript-protocol-types.js"
import type { Accessor } from "solid-js"
import type { ChatInput, ChatInputLike } from "../../infra/chat-input.js"
import type { QuestionBlock } from "../../infra/output-blocks.js"
import type { AgentInputAnswer } from "../../protocol/question-protocol-types.js"
import type { LocalRecall } from "../../protocol/client/chat-submissions.js"
import type { DraftCache } from "../hooks/create-draft-cache.js"
import type { PromptHistoryHook } from "../hooks/create-composer-history.js"
import type { Clipboard } from "../utils/clipboard.js"
import type { ComposerPopupKeySlot } from "../hooks/create-composer-popup-key-slot.js"
import type { ComposerAttachSlot } from "../hooks/create-composer-attach-slot.js"
import type { SpinnerStatusSource } from "../hooks/create-spinner-status.js"
import type { ModalSelectOption } from "./modal-select-types.js"
import type { ComposerBorderLayout } from "./composer-border-layout.js"

interface QuestionAnswers {
  [question: string]: AgentInputAnswer
}

export interface ComposerHandle {
  /** Merge a pending draft with the live destination buffer, if visible, and its cache. */
  adoptDraft: DraftCache["adopt"]
  /** Write the live buffer, with its caret, into the foreground's draft. */
  persistDraft(): void
  appendInput(sessionId: string, input: ChatInputLike): void
}

/** How the prompt treats a submission: false keeps the input, true takes it,
 *  and a pending settlement takes it at once but gets it back when `accepted`
 *  resolves false. A refusal that comes later, such as a launch the runtime
 *  refuses, then costs the person no retyping. */
export type ComposerSubmitResult = boolean | { readonly accepted: Promise<boolean> }

export interface ComposerProps {
  ref?: (handle: ComposerHandle) => void
  foregroundId: Accessor<string | undefined>
  agentState: Accessor<"idle" | "active">
  /** Whether Escape interrupts now (`isInterruptible`), which the placeholder names. */
  interruptible: Accessor<boolean>
  pendingQuestion: Accessor<QuestionBlock | undefined>
  inChat: Accessor<boolean>
  lineWidth: Accessor<number>
  completableNames: () => string[]
  dispatchableNames: () => string[]
  /** Full slash-command catalog for the suggestion popup; value is the dispatchable slash text. */
  slashCatalog: readonly ModalSelectOption[]
  /** The runtime's ranked project files and folders for an `@` query. */
  projectFiles: (query: string) => Promise<readonly ProjectFileEntry[]>
  /** Shell keyboard slot the prompt popups claim keys through while open. */
  promptPopupKeySlot: ComposerPopupKeySlot
  /** Where `/attach` hands the files it picked, once the prompt is mounted. */
  promptAttachSlot: ComposerAttachSlot
  /** The foreground session's live state that the bottom border's status line
   *  folds. The composer owns the fold, so the line stays current while an
   *  overlay covers the composer. */
  spinnerSource: SpinnerStatusSource
  promptBorderLayout: Accessor<ComposerBorderLayout>
  onDismissUpdate: () => void
  onOpenChanges: () => void
  history: PromptHistoryHook
  /** Account-global slash-command usage counts; ranks suggestions and ghost completion. */
  commandFrequency: Accessor<ReadonlyMap<string, number>>
  /** The TUI's clipboard, read when the user pastes an image into the prompt. */
  clipboard: Clipboard
  /** Reports a file that could not become an attachment without losing the draft. */
  onAttachmentWarning: (message: string) => void
  /** Return false to retain input that no command or session accepted. */
  onSubmit: (input: ChatInput) => ComposerSubmitResult
  onRecallQueued?: () => ChatInputLike | null | Promise<ChatInputLike | null>
  /** Up on an empty prompt asks this first: a message that did not go
   *  through comes back for editing, and a message that waits for the
   *  connection stays, with the caller saying why. Either way Up ends here. */
  onRecallLocal?: () => LocalRecall | null
  onAnswerQuestion: (toolUseId: string, answers: QuestionAnswers) => Promise<boolean>
  onCancelQuestion: (toolUseId: string) => Promise<boolean>
  draftCache: DraftCache
  onOpenSessions: () => void
  onModuleAction: (action: ModuleRowAction) => void
  onOpenModel: () => void
  onNew: () => void
  onClose: () => void
  onNextTab: () => void
  onOpenBackground: () => void
  /** The border's `ctrl+r resume` hint, shown while the session admits Resume and no turn runs. */
  onResume: () => void
  captureFocus: Accessor<boolean>
}
