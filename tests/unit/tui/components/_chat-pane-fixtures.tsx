/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"
import type { ChatInput } from "../../../../src/infra/chat-input.js"
import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import type { ProjectFileEntry } from "../../../../src/protocol/transcript-protocol-types.js"
import type { ChatPaneHost } from "../../../../src/tui/components/chat-pane.js"
import type { ModalSelectOption } from "../../../../src/tui/components/modal-select-types.js"
import { createComposerAttachSlot } from "../../../../src/tui/hooks/create-composer-attach-slot.js"
import { createDismissibleUpdateStatus } from "../../../../src/tui/hooks/create-composer-border-layout.js"
import { createDraftCache, type DraftCache } from "../../../../src/tui/hooks/create-draft-cache.js"
import { heightEstimatesFromBlocks } from "../../../../src/tui/hooks/output-height-estimates.js"
import type { SessionSurface } from "../../../../src/tui/hooks/create-session-surface.js"
import { useCommands } from "../../../../src/tui/hooks/use-commands.js"
import { createKeymap } from "../../../../src/tui/keymap/keymap.js"
import { createTranscriptLayoutCache } from "../../../../src/tui/output-window/output-window-scroll.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { transcriptOf } from "../_output-window-transcript.js"
import { childBodyProps, viewerSurface } from "./_child-session-viewer-fixtures.js"
import { createHistory } from "./prompt-area-fixture.js"

/** A chat's surface over scripted blocks, with the store's own height estimates, so a place by block index lands
 *  where it would in the product. */
export function chatSurface(sessionId: string, blocks: readonly FrontendOutputBlock[], over: Partial<SessionSurface> = {}): SessionSurface {
  const transcript = transcriptOf(blocks)
  const snapshot = transcript.visibleRange()
  const estimated = snapshot && { ...snapshot, heightEstimates: heightEstimatesFromBlocks(blocks, 0, false) }
  const chat = viewerSurface("chat")
  const summary = (): ReturnType<SessionSurface["summary"]> => { const row = chat.summary(); return row && { ...row, id: sessionId } }
  return { ...chat, sessionId: () => sessionId, summary, transcript: { ...transcript, visibleRange: () => estimated }, ...over }
}

export interface ChatPaneHostOptions {
  readonly transcripts?: { readonly [sessionId: string]: readonly FrontendOutputBlock[] }
  /** Receives each plain message a composer sends, as the shell's submissions owner does. */
  readonly send?: (sessionId: string, input: ChatInput) => Promise<void>
  readonly slashCatalog?: readonly ModalSelectOption[]
  readonly projectFiles?: readonly ProjectFileEntry[]
  readonly draftCache?: DraftCache
  /** The contexts a view's pane takes from the shell. */
  readonly provide?: (children: () => JSX.Element) => JSX.Element
  readonly over?: Partial<ChatPaneHost>
}

/** The shell's chat pane host with inert window parts, the production command
 *  routing for submits, and scripted transcripts. */
export function chatPaneHost(options: ChatPaneHostOptions = {}): ChatPaneHost {
  const body = childBodyProps()
  const slash = options.slashCatalog ?? []
  const names = (): string[] => slash.map((row) => row.value.slice(1))
  const commands = useCommands({
    dispatch: { completableNames: names, dispatchableNames: names, dispatch: async () => false },
    showToast: () => {},
    sendMessage: options.send ?? (async () => {}),
    startChat: async () => ({ kind: "failed" as const }),
    openSettingsDestination: async () => {},
    providerSetup: () => "usable" as const,
    openSubscriptionSpendReview: () => false,
  })
  const keymap = createKeymap().keymap
  const Strips: ChatPaneHost["Strips"] = (props) => <>{props.children}</>
  return {
    client: { dispatch: runtimeDispatch({}), query: runtimeQuery({}) },
    showToast: () => {},
    provide: options.provide ?? ((children) => children()),
    createSurface: (sessionId) => { const id = sessionId() ?? ""; return chatSurface(id, options.transcripts?.[id] ?? []) },
    follow: () => {},
    runtimeFault: () => null,
    update: createDismissibleUpdateStatus(() => undefined),
    chordFor: keymap.chordFor,
    activeSessionCount: () => 1,
    sessionCount: () => 1,
    chatDefault: () => ({ kind: "pending" }),
    hidesTabControls: () => false,
    roleView: body.roleView,
    childStatus: body.childStatus,
    ensureChildViews: body.ensureChildViews,
    branch: () => undefined,
    createChanges: () => () => undefined,
    openChanges: () => {},
    layoutSlot: createTranscriptLayoutCache(),
    pendingSubmissions: () => [],
    processControls: body.createProcessControls,
    showThinking: () => false,
    diffColors: body.diffColors,
    compactionThreshold: () => 270_000,
    compact: async () => true,
    sessionIntro: body.sessionIntro,
    Strips,
    sessionRows: () => ({ composerStatus: () => [], introRows: () => [] }),
    stripFocused: () => false,
    releaseStripFocus: () => {},
    composer: {
      completableNames: names,
      dispatchableNames: names,
      slashCatalog: () => slash,
      projectFiles: async () => options.projectFiles ?? [],
      promptAttachSlot: createComposerAttachSlot(),
      history: createHistory(),
      commandFrequency: () => new Map(),
      clipboard: { copy: async () => {}, readImage: async () => null },
      onAttachmentWarning: () => {},
      draftCache: options.draftCache ?? createDraftCache(),
      onAnswerQuestion: async () => true,
      onCancelQuestion: async () => true,
      onOpenSessions: () => {},
      onModuleAction: () => {},
      onNew: () => {},
      onClose: () => {},
      onNextTab: () => {},
    },
    submit: commands.handleComposerSubmit,
    recallLocal: () => null,
    recallQueued: async () => null,
    openModel: () => {},
    openBackground: () => {},
    transcriptInView: body.transcriptInView,
    followBackground: body.followBackground,
    paneKey: () => {},
    ...options.over,
  }
}
