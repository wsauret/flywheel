import type { ChatInputLike } from "../../../../src/infra/chat-input.js"
import type { QuestionBlock } from "../../../../src/infra/output-blocks.js"
import type { LocalRecall } from "../../../../src/protocol/client/chat-submissions.js"
import type { ComposerHandle, ComposerProps } from "../../../../src/tui/components/composer-types.js"
import type { DraftCache } from "../../../../src/tui/hooks/create-draft-cache.js"
import type { PromptHistoryHook } from "../../../../src/tui/hooks/create-composer-history.js"
import type { SpinnerStatusSource } from "../../../../src/tui/hooks/create-spinner-status.js"

const { testRender } = await import("@opentui/solid")
const { createComponent } = await import("solid-js/web")
const { Composer } = await import("../../../../src/tui/components/composer.js")
const { QuestionInputProvider } = await import("../../../../src/tui/components/question-input.js")
const { ThemeProvider } = await import("../../../../src/tui/context/theme.js")
const { TickPoolProvider } = await import("../../../../src/tui/context/tick-pool-context.js")

export function createHistory(entries: readonly string[] = []): PromptHistoryHook {
  return {
    entries: () => entries,
    add: () => {},
    flush: () => Promise.resolve(),
    dispose: () => {},
  }
}

interface MountOptions {
  readonly ref?: (handle: ComposerHandle) => void
  readonly draftCache: DraftCache
  readonly foregroundId: () => string | undefined
  readonly agentState?: () => "idle" | "active"
  readonly history?: PromptHistoryHook
  readonly onRecallQueued?: () => ChatInputLike | null | Promise<ChatInputLike | null>
  readonly onRecallLocal?: () => LocalRecall | null
  readonly onSubmit?: ComposerProps["onSubmit"]
  readonly pendingQuestion?: () => QuestionBlock | undefined
  readonly slashCatalog?: () => ComposerProps["slashCatalog"]
  readonly dispatchableNames?: ComposerProps["dispatchableNames"]
  readonly promptPopupKeySlot?: ComposerProps["promptPopupKeySlot"]
  readonly kittyKeyboard?: boolean
  readonly clipboardImage?: Promise<{ mediaType: string; data: string } | null>
  readonly spinnerSource?: SpinnerStatusSource
  /** False while the shell shows an overlay over the composer. */
  readonly captureFocus?: () => boolean
}

/** A foreground session at rest: no turn, no park, no notice. */
export function idleSpinnerSource(overrides: Partial<SpinnerStatusSource> = {}): SpinnerStatusSource {
  return {
    sessionId: () => "session-a",
    status: () => undefined,
    streamingOutputChars: () => 0,
    agentState: () => "idle",
    waitingOnBackgroundWork: () => false,
    parentSessionId: () => undefined,
    compactionStartedAt: () => null,
    notice: () => null,
    ...overrides,
  }
}

/** Mounts the production Composer with local providers and clipboard input.
 *  The caller must destroy the returned renderer in its cleanup. */
export async function mountPrompt(options: MountOptions) {
  const clipboardImage = options.clipboardImage ?? Promise.resolve(null)
  // The prompt holds no clipboard of its own: the shell injects one, so the test
  // injects a fake with the same surface.
  const clipboard = {
    copy: async () => {},
    readImage: () => clipboardImage,
  }
  return testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(TickPoolProvider, {
          get children() {
            return createComponent(QuestionInputProvider, {
              get children() {
                return createComponent(Composer, {
                  ref: options.ref,
                  foregroundId: options.foregroundId,
                  clipboard,
                  agentState: options.agentState ?? (() => "idle"),
                  interruptible: () => (options.agentState?.() ?? "idle") === "active",
                  pendingQuestion: options.pendingQuestion ?? (() => undefined),
                  inChat: () => true,
                  lineWidth: () => 80,
                  completableNames: () => options.slashCatalog?.().map(row => row.value.slice(1)) ?? [],
                  dispatchableNames: options.dispatchableNames ?? (() => options.slashCatalog?.().map(row => row.value.slice(1)) ?? []),
                  get slashCatalog() { return options.slashCatalog?.() ?? [] },
                  projectFiles: async () => [],
                  promptPopupKeySlot: options.promptPopupKeySlot ?? { register: () => {}, input: () => false },
                  promptAttachSlot: { register: () => {}, capture: () => undefined },
                  spinnerSource: options.spinnerSource ?? idleSpinnerSource(),
                  promptBorderLayout: () => ({ modelLabel: undefined, update: undefined, composerStatus: [], hints: [], sessionsClickHint: null }),
                  onDismissUpdate: () => {},
                  onOpenChanges: () => {},
                  history: options.history ?? createHistory(),
                  commandFrequency: () => new Map<string, number>(),
                  onAttachmentWarning: () => {},
                  onSubmit: options.onSubmit ?? (() => true),
                  ...(options.onRecallQueued ? { onRecallQueued: options.onRecallQueued } : {}),
                  ...(options.onRecallLocal ? { onRecallLocal: options.onRecallLocal } : {}),
                  onAnswerQuestion: async () => true,
                  onCancelQuestion: async () => true,
                  draftCache: options.draftCache,
                  onOpenSessions: () => {},
                  onModuleAction: () => {},
                  onOpenModel: () => {},
                  onNew: () => {},
                  onClose: () => {},
                  onNextTab: () => {},
                  onOpenBackground: () => {},
                  onResume: () => {},
                  captureFocus: options.captureFocus ?? (() => true),
                })
              },
            })
          },
        })
      },
    }),
    { width: 100, height: 8, kittyKeyboard: options.kittyKeyboard },
  )
}

// Characters typed back-to-back arm paste-burst detection, which reclassifies
// the following Enter as a pasted newline. Spacing keystrokes past the burst
// interval keeps Enter a real submit.
export async function typeAsHuman(mockInput: { pressKey: (name: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    mockInput.pressKey(ch)
    await Bun.sleep(10)
  }
}
