import { createEffect, createMemo, type Accessor } from "solid-js"
import { useOverlay } from "@tui/components/modal/modal"
import { useKeymap } from "@tui/context/keymap"
import { Log } from "../../infra/log.js"
import type { AttachedRuntimeClient } from "../../protocol/runtime/app-service-types.js"
import { createOpenSessionKeeper } from "../../protocol/client/open-session-keeper.js"
import { discardIfTransientForeground } from "../hooks/foreground/background-foreground.js"
import { createForegroundSwitcher } from "../hooks/foreground/create-foreground-switcher.js"
import { createSessionCreator } from "../hooks/sessions/create-session-creator.js"
import { createTabCloser } from "../hooks/create-tab-closer.js"
import { createTabState } from "../hooks/create-tabs.js"
import { createSessionActivator } from "../hooks/foreground/session-activation.js"
import { useShellState } from "../hooks/state/shell-state.js"
import { createFocusedSessionReadiness, useOpenSessionRunners } from "../hooks/use-open-session-runners.js"
import type { ShellComposerCore } from "./shell-composer-core.js"

const keeperLog = Log.create({ service: "session-keeper" })

interface ShellPlacesDeps {
  readonly appService: AttachedRuntimeClient
  readonly composer: Pick<ShellComposerCore, "draftCache" | "composerReturns" | "handle">
  readonly firstFrame: Accessor<boolean>
  /** True once the first frame is drawn and the runtime is ready. */
  readonly ready: Accessor<boolean>
}

/** The places the shell shows: the tabs, the session in front, and how a
 *  chat starts, comes to the front, and closes. The overlays open these
 *  places, so they come first. */
export function createShellPlaces(deps: ShellPlacesDeps) {
  const { signals, services } = useShellState()
  const overlay = useOverlay()
  const { keymap } = useKeymap()
  const { draftCache, composerReturns } = deps.composer
  const { tabs, openSessionTab, closeSessionTab, openPendingTab, removePendingTab, hasPendingTab, isTransientSessionTab, reorderTab } = createTabState({ sessions: signals.sessionCatalogRows, signals })
  const sessionTabs = () => tabs().filter((tab) => tab.kind === "session")
  const activeSessionCount = createMemo(() => sessionTabs().length)
  createEffect(() => { composerReturns.own(deps.firstFrame() ? sessionTabs().map((tab) => tab.id) : []) })
  const switchForeground = createForegroundSwitcher({ signals, sessions: signals.sessionCatalogRows, tabs })
  const focusReady = createFocusedSessionReadiness(() => { const id = signals.foregroundId(); return id === undefined || services.transcripts.isCurrent(id) })
  useOpenSessionRunners({
    tabs,
    ready: deps.ready,
    keeper: createOpenSessionKeeper({ client: deps.appService, focusReady, onDiagnostic: (message, detail) => keeperLog.warn(message, { detail }) }),
  })
  const { startChat, focusSession, recallFailedChat } = createSessionCreator({
    signals,
    appService: deps.appService,
    openSessionTab,
    openPendingTab,
    removePendingTab,
    hasPendingTab,
    tabs,
    draftCache,
    adoptDraft: (key, sessionId) => deps.composer.handle().adoptDraft(key, sessionId),
    seedSessionCatalogRow: services.seedSessionCatalogRow,
    startKnownEmptyTranscript: services.startKnownEmptyTranscript,
    retireTransientSession: (sessionId) => { void discardIfTransientForeground({ draftCache, appService: deps.appService, showToast: services.showToast, closeSessionTab, isTransientSessionTab }, sessionId) },
    showToast: services.showToast,
  })
  const activateSession = createSessionActivator({
    signals,
    draftCache,
    appService: deps.appService,
    openSessionTab,
    closeSessionTab,
    isTransientSessionTab,
    showToast: services.showToast,
    dismissModalStack: overlay.clear,
  })
  const { closeTab, closeChat } = createTabCloser({
    tabs, appService: deps.appService, switchForeground, startChat, closeSessionTab, removePendingTab, draftCache, seedSessionCatalogRow: services.seedSessionCatalogRow,
    showToast: services.showToast,
  })
  async function startNewChat(): Promise<void> {
    const settlement = await startChat()
    if (settlement.kind === "foregrounded") {
      services.showToast({ message: "New chat started", variant: "success" })
    }
  }
  // /clear serves muscle memory from harnesses where it wipes the session in
  // place. Flywheel sessions are tabs, so it opens a fresh tab like /new and
  // teaches the model once, at the moment the user reached for a reset.
  async function startClearedChat(): Promise<void> {
    const settlement = await startChat()
    if (settlement.kind === "foregrounded") {
      services.showToast({
        message: `Sessions are tabs: this is a fresh one. Chats with content keep their tabs; unused empty tabs are replaced. ${keymap.chordFor("new")} new, ${keymap.chordFor("tab.close")} close tab.`,
        variant: "info",
        duration: 8000,
      })
    }
  }
  return {
    tabs, openSessionTab, closeSessionTab, reorderTab, activeSessionCount, switchForeground,
    startChat, startNewChat, startClearedChat, focusSession, recallFailedChat, activateSession, closeTab, closeChat,
  }
}

export type ShellPlaces = ReturnType<typeof createShellPlaces>
