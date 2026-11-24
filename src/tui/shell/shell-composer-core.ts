import { useRenderer } from "@opentui/solid"
import { createMemo, onCleanup } from "solid-js"
import { useKeymap } from "@tui/context/keymap"
import { usesPerCommand } from "../../protocol/client/command-menu.js"
import { launchOutbox, type LaunchState } from "../../infra/distribution/launch-state.js"
import type { AttachedRuntimeClient } from "../../protocol/runtime/app-service-types.js"
import { commandSpecs, commandsToOptions } from "../commands/command-catalog.js"
import { buildCommandDefinitions } from "../commands/command-definitions.js"
import type { ComposerHandle } from "../components/composer/composer-types.js"
import { createComposerAttachSlot } from "../components/composer/attachments/create-composer-attach-slot.js"
import { createComposerPopupKeySlot } from "../components/composer/suggestions/create-composer-popup-key-slot.js"
import { createTerminalChatSubmissions } from "../hooks/create-chat-submissions.js"
import { createTerminalComposerReturns } from "../hooks/composer/create-composer-returns.js"
import { createDraftCache, mergeInputIntoDraft } from "../components/composer/create-draft-cache.js"
import { useShellState } from "../hooks/state/shell-state.js"
import { useChatMode } from "../hooks/use-chat-mode.js"
import { usePromptHistoryPersistence } from "../hooks/composer/use-composer-history-persistence.js"
import { useSessionControls } from "../hooks/sessions/use-session-controls.js"
import { snapshotSeeded } from "../transcript/transcript-store/output-transcript-cache-types.js"

/** What the composer holds before the places that hand it drafts exist: the
 *  draft cache, the chat submissions and the drafts they return, the prompt
 *  history, the slots that fill the prompt from outside, the foreground
 *  session's chat actions, and the command catalog its slash popup lists. */
export function createShellComposer(deps: { readonly appService: AttachedRuntimeClient; readonly stateRoot: string; readonly launchState: LaunchState | undefined }) {
  const { signals, services } = useShellState()
  const { keymap } = useKeymap()
  const renderer = useRenderer()
  // A predecessor terminal's drafts are in place before the composer mounts.
  const draftCache = createDraftCache(deps.launchState)
  const submissions = createTerminalChatSubmissions({
    dispatch: (sessionId, input) => deps.appService.dispatch({ type: "session.send", sessionId, input }),
    lanes: deps.appService,
    unsent: deps.launchState === undefined ? [] : launchOutbox(deps.launchState),
    report: (message, variant) => services.showToast({ message, variant }),
    position: (sessionId) => { const range = services.transcripts.visibleRange(sessionId); return range !== undefined && snapshotSeeded(range) ? range.totalBlocks : undefined },
    context: () => ({ health: signals.runtimeHealth().kind, foregroundId: signals.foregroundId() }),
  })
  // The mounted prompt replaces this handle; until then a draft goes to the cache.
  let handle: ComposerHandle = { adoptDraft: draftCache.adopt, persistDraft: () => {}, appendInput: (sessionId, input) => mergeInputIntoDraft(draftCache, sessionId, input) }
  const composerReturns = createTerminalComposerReturns({
    client: deps.appService, composer: () => handle, drafts: draftCache, submissions: () => submissions,
    row: signals.sessionRow,
    report: (message, variant) => services.showToast({ message, variant }),
  })
  services.observeOutput({ onBlocksAdopted: submissions.observe, onTranscriptChange: composerReturns.observe })
  renderer.on("frame", submissions.frame)
  onCleanup(() => {
    renderer.off("frame", submissions.frame)
    submissions.dispose()
  })
  const commandDefinitions = createMemo(() => buildCommandDefinitions(keymap.chordFor, signals.builtInCommands()))
  const commandCatalog = createMemo(() => commandSpecs(commandDefinitions()))
  const slashCatalog = createMemo(() => commandsToOptions(commandCatalog()))
  // The popup ranks one row per command, so an alias's uses count toward it.
  const commandUses = createMemo(() => usesPerCommand(signals.commandUsage(), commandCatalog().map((spec) => ({ id: spec.id, aliases: spec.aliases ?? [] }))))
  return {
    draftCache,
    submissions,
    composerReturns,
    handle: (): ComposerHandle => handle,
    mount: (mounted: ComposerHandle): void => { handle = mounted },
    promptHistory: usePromptHistoryPersistence(deps.stateRoot),
    // Created ahead of the surface that hands files into it; the composer
    // registers its sink once its textarea mounts.
    attachSlot: createComposerAttachSlot(),
    popupKeySlot: createComposerPopupKeySlot(),
    chat: useChatMode({ signals, appService: deps.appService, showToast: services.showToast }),
    sessionControls: useSessionControls({ row: signals.foregroundSummary, status: signals.foregroundStatus, appService: deps.appService, showToast: services.showToast }),
    commandDefinitions,
    commandCatalog,
    slashCatalog,
    commandUses,
  }
}

export type ShellComposerCore = ReturnType<typeof createShellComposer>
