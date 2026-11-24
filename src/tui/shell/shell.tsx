/** @jsxImportSource @opentui/solid */
import { faultReach, type TerminalAttach } from "../terminal-attach.js"
import { cardProfileName } from "../../protocol/client/new-chat-card.js"
import { runtimeFaultCopy, type ReleaseInstall } from "../../protocol/client/runtime-fault-copy.js"
import { providerSetup } from "../../protocol/client/provider-setup.js"
import { usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { OverlayHost, useOverlay } from "@tui/components/modal/modal"
import { ToastDisplay } from "@tui/components/notices/toast-display"
import { NavigationProvider } from "@tui/context/navigation.js"
import { SubagentControlsProvider } from "@tui/context/subagent-controls.js"
import { ClientExtensionsProvider } from "@tui/context/client-extensions.js"
import { useTheme } from "@tui/context/theme"
import { useTickPool } from "@tui/context/tick-pool-context"
import { useToast } from "@tui/context/toast"
import { createMemo, createSignal, from, onCleanup, onMount, Show } from "solid-js"
import { startupTrace, traceShellMount } from "../../infra/diagnostics/startup-trace.js"
import { errorMessage } from "../../infra/error-message.js"
import type { LaunchState } from "../../infra/distribution/launch-state.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import type { BackgroundWorkTarget } from "../../protocol/background-index-protocol-types.js"
import type { RuntimeIdentity } from "../../protocol/client/runtime-identity.js"
import type { Clipboard } from "../terminal/clipboard.js"
import { tuiFaultNotice } from "../modules.js"
import { StartupViewport } from "../components/startup/startup-viewport.js"
import { OutputWindow, type OutputWindowCommand, type OutputWindowCommandType } from "../transcript/output-window/output-window.js"
import { createTranscriptLayoutCache } from "../transcript/output-window/output-window-scroll.js"
import { createTerminalBackground, type TerminalBackgroundWriter } from "../hooks/create-terminal-background.js"
import { createTranscriptSelectionDrag } from "../hooks/transcript/create-transcript-selection-drag.js"
import { createFindBar } from "../transcript/output-window/create-find-bar.js"
import { FindBar } from "../transcript/output-window/find-bar.js"
import { createSessionProcessControls } from "../hooks/sessions/create-session-process-controls.js"
import { startSessionChangesWhenReady } from "../hooks/state/create-session-changes.js"
import type { SettingsOperations } from "../hooks/state/create-settings-store.js"
import { createLateBinding } from "../hooks/wiring/late-binding.js"
import { createShellState, ShellStateProvider, useShellState } from "../hooks/state/shell-state.js"
import type { RuntimeConfigCache } from "../hooks/state/runtime/create-runtime-config-cache.js"
import { useCopySelection } from "../components/use-copy-selection.js"
import { useReleaseNotice } from "../hooks/welcome/use-release-notice.js"
import { useTabsHint } from "../hooks/welcome/use-tabs-hint.js"
import { createShellCommands, ShellComposer } from "./shell-composer.js"
import { createShellComposer } from "./shell-composer-core.js"
import { ShellHeader } from "./shell-header.js"
import { createShellNavigation } from "./shell-navigation.js"
import { createShellPlaces } from "./shell-places.js"
import { createShellOverlays } from "./shell-overlays.js"

interface FlywheelShellProps { appService: AttachedRuntimeClient; attach: TerminalAttach; runtimeConfig: RuntimeConfigCache; projectRoot: string; stateRoot: string; userDataRoot: string; accountHome: string; appVersion: string; launcher: LauncherScope; clipboard: Clipboard; settingsOperations: SettingsOperations; launchState: LaunchState | undefined; attachedIdentity: Promise<RuntimeIdentity | undefined>; registerForeground?: (read: () => string | undefined) => void; terminalWriter: TerminalBackgroundWriter }

/** The terminal shell: it creates the one shell state, and the layout below
 *  composes the owners that read it. */
export function FlywheelShell(props: FlywheelShellProps) {
  startupTrace("flywheel shell setup start")
  const toast = useToast()
  const renderer = useRenderer()
  // Terminal.app (or the Compatible rendering setting): transparent base
  // cells + OSC 11 render theme-colored with native-drawn connected borders.
  // Other terminals get the theme background painted per cell by the root
  // box below, and the hook restores their own default background.
  // eslint-disable-next-line solid/reactivity -- the ordered terminal writer belongs to this shell's lifetime
  createTerminalBackground(props.terminalWriter)
  const wallTick = useTickPool().createSharedTick(1000, () => true)
  const now = createMemo(() => { wallTick(); return Date.now() })
  /* eslint-disable solid/reactivity -- shell props are static for the session lifetime, set once from composition root */
  const shell = createShellState({
    appService: props.appService,
    runtimeConfig: props.runtimeConfig,
    projectRoot: props.projectRoot,
    now,
    attachedIdentity: props.attachedIdentity,
    setTerminalTitle: (title: string) => { if (!renderer.isDestroyed) renderer.setTerminalTitle(title) },
    showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => toast.show(opts),
  })
  props.registerForeground?.(shell.signals.foregroundId)
  /* eslint-enable solid/reactivity */
  startupTrace("shell state created")
  onCleanup(() => { if (!renderer.isDestroyed) renderer.setTerminalTitle("") })
  return <ShellStateProvider value={shell}><ShellLayout {...props} /></ShellStateProvider>
}

/** Builds the owners in the order they read each other: the composer, the
 *  places, the overlays, the navigation, then the commands. The owners form
 *  cycles, such as a modal that opens a session whose viewer opens the modal,
 *  and each cycle closes at a late binding. The code that builds the target
 *  of a call binds it: this layout for a call between owners, and an owner
 *  for a call inside it. */
function ShellLayout(props: FlywheelShellProps) {
  const { signals, services } = useShellState()
  const themeContext = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const overlay = useOverlay()
  const toast = useToast()
  /* eslint-disable solid/reactivity -- shell props are static for the session lifetime, set once from composition root */
  const { appService, attach, runtimeConfig, clipboard, launcher, launchState, stateRoot, userDataRoot, accountHome, appVersion, settingsOperations } = props
  const directories = { userDataRoot, accountHome }
  const copySelection = useCopySelection(clipboard)
  const transcriptSelectionDrag = createTranscriptSelectionDrag(renderer)
  const findBar = createFindBar({
    client: appService,
    sessionId: signals.foregroundId,
    includeThinking: () => signals.display.showThinking,
    transcript: signals.outputTranscript,
    report: (message) => services.showToast({ message, variant: "error" }),
  })
  // The prompt is blurred while the find bar holds the keys, so a paste then
  // goes into the find field, unless a modal above both takes it.
  usePaste((event) => {
    if (!overlay.isOpen() && findBar.paste(new TextDecoder().decode(event.bytes))) event.preventDefault()
  })
  // A press anywhere but the find bar hands the keys back to the prompt; the
  // bar stays open.
  const onShellMouseDown: typeof transcriptSelectionDrag.onMouseDown = (event) => {
    findBar.blur()
    transcriptSelectionDrag.onMouseDown(event)
  }
  const onShellMouseUp = (): boolean => {
    transcriptSelectionDrag.onMouseUp()
    return copySelection()
  }
  const [outputCommand, setOutputCommand] = createSignal<OutputWindowCommand | undefined>()
  let outputCommandId = 0
  const dispatchOutputCommand = (type: OutputWindowCommandType) => setOutputCommand({ id: ++outputCommandId, type })
  const navigateToProcess = (entryId: string) => setOutputCommand({ id: ++outputCommandId, type: "block", entryId })
  const tabsHint = useTabsHint(runtimeConfig, appService, services.showToast)
  const releaseNotice = () => signals.updateStatus()?.releaseNotice
  const releaseNoticeActions = useReleaseNotice(releaseNotice, runtimeConfig, appService, services.showToast)
  /* eslint-enable solid/reactivity */
  const [firstFrame, setFirstFrame] = createSignal(false)
  const afterFrame = (): void => { setFirstFrame(true); renderer.off("frame", afterFrame) }
  renderer.on("frame", afterFrame)
  onCleanup(() => renderer.off("frame", afterFrame))
  const ready = () => firstFrame() && signals.startupStatus() === null
  // eslint-disable-next-line solid/reactivity -- the helper tracks readiness in its owned effect
  startSessionChangesWhenReady(ready, services.startDeferredReadings)
  const processControls = createSessionProcessControls({ appService, signals, showToast: services.showToast })
  const transcriptLayout = createTranscriptLayoutCache(() => signals.sessionCatalogRows().filter((row) => row.lifecycleState === "active").length)
  const setup = createMemo(() => providerSetup(signals.auth()))

  const openSession = createLateBinding<[sessionId: string], Promise<void>>("session navigation")
  const openTarget = createLateBinding<[target: BackgroundWorkTarget], Promise<void>>("target navigation")
  const dispatchCommand = createLateBinding<[text: string], Promise<boolean>>("command dispatch")
  const composer = createShellComposer({ appService, stateRoot, launchState })
  const places = createShellPlaces({ appService, composer, firstFrame, ready })
  const overlays = createShellOverlays({
    appService, attach, runtimeConfig, directories, appVersion, launcher, clipboard, settingsOperations, composer, places, navigateToProcess, openFind: findBar.open,
    openSession: openSession.call, openTarget: openTarget.call, dispatchCommand: dispatchCommand.call,
  })
  const sessionIntro = {
    runtimeIdentity: signals.runtimeIdentity,
    showBuild: () => signals.display.showBuild,
    projectRoot: signals.projectRoot,
    userDataRoot,
    accountHome,
    profileName: () => { const profile = signals.auth()?.profile; return cardProfileName(profile && { displayName: profile.displayName, count: profile.availableProfiles.length }) },
    moduleRows: overlays.slots.introRows,
    fontTipDismissed: () => signals.display.fontTipDismissed,
    tabsHintDismissed: tabsHint.dismissed,
    onDismissTabsHint: () => { void tabsHint.dismiss() },
  }
  const navigation = createShellNavigation({ appService, stateRoot, launchState, composer, places, overlays, processControls, transcriptLayout, sessionIntro, dispatchCommand: dispatchCommand.call })
  openSession.bind(navigation.activateSessionById)
  openTarget.bind(navigation.openTarget)
  const commands = createShellCommands({ appService, attach, runtimeConfig, directories, launcher, composer, places, overlays, providerSetup: setup, dispatchOutputCommand, findBar })
  dispatchCommand.bind(commands.dispatch.dispatch)

  onMount(() => {
    traceShellMount(renderer)
    void navigation.place.restore().catch((cause: unknown) => services.showToast({ message: errorMessage(cause), variant: "error" }))
  })
  const subagentControls = {
    details: services.sessionDetails,
    client: appService,
    report: (message: string, variant: "warning" | "error") => services.showToast({ message, variant }),
  }
  const showPrompt = createMemo(() => !overlay.isOpen())
  // The one notice a runtime that is not healthy gets: never a recovery in
  // progress, only a fault, with the runtime's own cause when it reported one
  // and the remedy for this lane or remote machine, or a process for this
  // project that Flywheel starts again, with how it last stopped. A relay
  // terminal that installs the machine's release says so in the same notice,
  // and says why when it could not (PI-REMOTE-016).
  const releaseInstall = attach.kind === "relay" ? from<ReleaseInstall | undefined>((set) => attach.install.subscribe((install) => set(install))) : () => undefined
  const runtimeFault = createMemo(() => { const health = signals.runtimeHealth(); return health.kind === "healthy" ? null : tuiFaultNotice(runtimeFaultCopy(health, faultReach(attach, releaseInstall())), health, { client: appService, clipboard, showToast: toast.show }) })

  return (
    <SubagentControlsProvider value={subagentControls}><NavigationProvider value={navigation.navigateUri}>
    <ClientExtensionsProvider value={navigation.moduleClients}>{navigation.modules.provide(() => <>
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={themeContext.baseBackground}
      onMouseDown={onShellMouseDown} onMouseDrag={transcriptSelectionDrag.onMouseDrag} onMouseUp={onShellMouseUp}>
      <ShellHeader places={places} chat={composer.chat} />

      {/* The transcript takes the rows the prompt area leaves. A tall pending
          question shrinks the prompt area instead of pushing its choices out of
          the frame, and the question dock scrolls inside the rows it gets. */}
      <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column" paddingLeft={2} paddingRight={1} paddingBottom={1} gap={1}>
        <StartupViewport
          foregroundKind={signals.foregroundTarget()?.kind}
          status={signals.startupStatus()}
          fault={runtimeFault()}
        />
        <Show when={signals.sessionState() !== null && signals.foregroundId()} keyed>
          {(id) => {
            // One controls object for the session this mount shows: a call in
            // the attribute would run again on every read of the prop.
            const controls = processControls(id)
            return <OutputWindow
              localSubmissions={composer.submissions.pending(id)}
              layoutSlot={transcriptLayout(id)}
              transcript={signals.outputTranscript()} running={signals.agentState() === "active"}
              showThinking={signals.display.showThinking}
              streamingToolText={signals.streamingToolText()}
              diffColors={() => signals.display.diffColors} command={outputCommand()}
              onNearEdge={services.pageForegroundOutput}
              registerSelectionAutoScroll={transcriptSelectionDrag.register}
              processControls={controls}
              roleView={signals.roleView}
              childStatus={(childSessionId) => signals.childStatus(childSessionId, id)}
              ensureChildViews={signals.ensureChildViews}
              find={findBar}
              findBar={<Show when={findBar.isOpen()}><FindBar bar={findBar} /></Show>}
              sessionIntro={{
                ...sessionIntro,
                branchName: () => signals.branch(id),
                sessionKind: () => "chat",
                modelLabel: signals.activeModelLabel,
                availableWidth: () => Math.max(1, dimensions().width - 4),
                noProviderReady: () => setup() === "none",
                releaseNotice: { notice: releaseNotice, dismiss: () => { void releaseNoticeActions.dismiss() }}
              }}
            />
          }}
        </Show>

      </box>
      <ShellComposer composer={composer} commands={commands} places={places} overlays={overlays} runtimeFault={runtimeFault} captureFocus={() => showPrompt() && !findBar.focused()} clipboard={clipboard} />
      <ToastDisplay headerHeight={showPrompt() ? 3 : 0} />
    </box>
    <OverlayHost clipboard={clipboard} />
    </>)}</ClientExtensionsProvider>
    </NavigationProvider></SubagentControlsProvider>
  )
}
