/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import { createSignal, For, type JSX } from "solid-js"
import { testRender, useKeyboard } from "@opentui/solid"
import type { ChildSessionRow, FrontendOutputBlock, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import { ChatPane, ChatViewPane, createChatPaneInput, routeChatPaneKey, type ChatPaneHost, type ChatPaneInput } from "../../../../src/tui/components/chat-pane.js"
import { createOverlayLayers, type OverlayLayers, type ViewerHandle } from "../../../../src/tui/components/modal-stack.js"
import { ClientExtensionsProvider } from "../../../../src/tui/context/client-extensions.js"
import { NavigationProvider } from "../../../../src/tui/context/navigation.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../src/tui/context/tick-pool-context.js"
import { createChildViewerOpener } from "../../../../src/tui/hooks/create-child-viewer-opener.js"
import { createTranscriptSelectionDrag } from "../../../../src/tui/hooks/create-transcript-selection-drag.js"
import { createLinkNavigator, createSessionActivator, createSessionActivatorById } from "../../../../src/tui/hooks/session-activation.js"
import { createTranscriptInView } from "../../../../src/tui/hooks/transcript-in-view.js"
import { useSessionControls } from "../../../../src/tui/hooks/use-session-controls.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import type { TuiModuleClient } from "../../../../src/tui/tui-module-client.js"
import { chatPaneHost, chatSurface } from "./_chat-pane-fixtures.js"
import { childBodyProps, viewerSurface } from "./_child-session-viewer-fixtures.js"

const renders: { renderer: { destroy(): void } }[] = []
afterEach(() => { for (const render of renders.splice(0)) render.renderer.destroy() })

/** A module whose activity card renders every workflow row, as the workflows module's does. */
const workflowCards: TuiModuleClient = {
  provide: (children) => children(), openUri: async () => false, openSession: () => false, restore: async () => false,
  activity: { matches: (block) => block.containerKind === "workflow", render: (props) => <text>Workflow card: {props.block.label}</text> },
}

const BLOCKS: readonly FrontendOutputBlock[] = [
  { kind: "agentGroup", containerKind: "workflow", id: "review", toolUseId: "wf", label: "Review PR 5110", description: "Review", status: "active", children: [], totalToolCount: 0, timestamp: 1 },
  { kind: "agentGroup", containerKind: "subagent", id: "explorer", toolUseId: "dispatch", label: "Explorer", description: "Inspect repository", status: "completed",
    linkUri: "flywheel://session/explorer", children: [], totalToolCount: 0, timestamp: 2 },
]

/** The shell's contexts, which the tab's pane sits in and which a view's pane takes through `provide`. */
function shellContexts(navigate: (uri: string) => void) {
  return (children: () => JSX.Element): JSX.Element => <ClientExtensionsProvider value={[workflowCards]}><NavigationProvider value={navigate}>{children()}</NavigationProvider></ClientExtensionsProvider>
}

/** The shell's keyboard listener: an open overlay takes the key first. */
function OverlayKeys(props: { readonly overlay: OverlayLayers }): JSX.Element {
  useKeyboard((event) => { props.overlay.input(event) })
  return null
}

function catalogRow(id: string): SessionCatalogRow {
  return { id, kind: "chat", inputMode: { kind: "chat" }, title: id, shortTitle: id, executionCwd: "/repo", lifecycleState: "active", activity: "idle",
    createdAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", notices: [], totalsLoading: true }
}

/** The subagent that the shown chat launched, as the runtime's detail read answers for it. */
const EXPLORER: RuntimeSessionDetailView = {
  source: "durable", id: "explorer", kind: "subagent", conversationId: "explorer-conversation", budget: null,
  row: { id: "explorer", kind: "subagent", title: "Explorer", lifecycleState: "active", notices: [], inputMode: { kind: "message" }, admittedActions: [],
    parentSessionId: "shown", lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/repo", totalsLoading: true } satisfies ChildSessionRow,
  status: { activity: "idle", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
    activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0,
    compactionStartedAt: null, replyWaits: [] },
}

/** One window with a chat in its tab, and another chat with the same blocks in a view over it, as the lead's modal
 *  opens it. Links follow the shell's production route: the link navigator and the session activators. */
async function mountWindow() {
  const overlay = createOverlayLayers()
  const transcriptInView = createTranscriptInView(() => {})
  let foreground = "front"
  const children = createChildViewerOpener({
    viewerLayer: overlay.viewer, navigateUri: () => {}, showToast: () => {}, provide: (child) => child(), openModuleSession: () => false,
    kindOf: () => "subagent", dispatchCommand: async () => false,
    viewer: () => ({ ...viewerProps(), createSurface: () => viewerSurface("subagent", { sessionId: () => "explorer" }) }),
  })
  const activateSession = createSessionActivator({
    signals: { foregroundId: () => foreground, setForegroundId: (id) => { if (id !== undefined) foreground = id } },
    draftCache: { hasDraft: () => false }, appService: { dispatch: runtimeDispatch({}) },
    openSessionTab: () => {}, closeSessionTab: () => {}, isTransientSessionTab: () => false, showToast: () => {}, dismissModalStack: overlay.clear,
  })
  const navigate = createLinkNavigator({
    openSession: createSessionActivatorById({
      rows: () => [catalogRow("front"), catalogRow("shown")],
      appService: { query: runtimeQuery({ sessionDetail: async (request) => ({ view: request.sessionId === "explorer" ? EXPLORER : null }) }) },
      shown: (sessionId) => transcriptInView.chatInView()?.sessionId() === sessionId,
      activateSession, openChild: children.openChild, seedSessionCatalogRow: () => {}, showToast: () => {},
    }),
    openModuleUri: async () => false, showToast: () => {},
  })
  const host = chatPaneHost({
    transcripts: { shown: BLOCKS },
    provide: shellContexts(navigate),
    over: { transcriptInView },
  })
  // The tab shows another chat with the same blocks: a view never shows the chat of the tab under it.
  const tab = chatSurface("front", BLOCKS)
  const render = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
    <OverlayKeys overlay={overlay} />
    <box flexDirection="column" width={100} height={60}>
      <box height={20}>{shellContexts(navigate)(() => <TabPane host={host} />)}</box>
      <For each={overlay.viewer.stack}>{(entry) => <box position="absolute" top={20} width={100} height={40}>{typeof entry.element === "function" ? entry.element() : entry.element}</box>}</For>
    </box>
  </TickPoolProvider></ThemeProvider>, { width: 100, height: 60 })
  renders.push(render)
  function TabPane(props: { readonly host: ChatPaneHost }) {
    const controls = useSessionControls({ row: tab.summary, status: tab.status, appService: props.host.client, showToast: () => {} })
    return <ChatPane host={props.host} surface={tab} changes={() => undefined} controls={controls} input={createChatPaneInput()} width={() => 100} focused={() => false}
      selectionDrag={createTranscriptSelectionDrag({ getSelection: () => null })} />
  }
  // The view over the tab, as the lead's modal mounts it.
  const input: ChatPaneInput = createChatPaneInput()
  const [handle, setHandle] = createSignal<ViewerHandle>()
  setHandle(overlay.viewer.push(() => <ChatViewPane host={host} surface={host.createSurface(() => "shown")} input={input}
    view={{ active: () => handle()?.isActive() ?? false, leave: () => handle()?.close(), closeChat: () => handle()?.close() }} width={() => 100} focused={() => handle()?.isFocused() ?? false}
    selectionDrag={createTranscriptSelectionDrag({ getSelection: () => null })} />,
  { onKey: (event) => { routeChatPaneKey(host, input, event, (key) => { if (key.name !== "escape") return false; handle()?.close(); return true }) } }))
  const settle = async (): Promise<void> => {
    for (let frame = 0; frame < 5; frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
      await render.renderOnce()
    }
  }
  const press = async (name: string): Promise<void> => {
    render.renderer.keyInput.processParsedKey({ name, ctrl: false, shift: false, meta: false, option: false, number: false, sequence: "", raw: "", eventType: "press", source: "raw" })
    await settle()
  }
  await settle()
  const lines = (): string[] => render.captureCharFrame().split("\n")
  return { overlay, render, lines, press, settle, foreground: () => foreground }
}

function viewerProps() {
  return {
    ...childBodyProps(),
    appService: { dispatch: runtimeDispatch({}), query: runtimeQuery({}) },
    submissions: { send: async () => ({ kind: "sent" as const }), recallQueued: async () => null },
    compactionThreshold: () => undefined,
  }
}

describe("the chat pane", () => {
  it("renders a chat's rows the same in its tab and in a view over the tab, and a subagent row there opens its viewer over the view, which stays", async () => {
    const window = await mountWindow()
    const rows = (from: number, to: number): string[] => window.lines().slice(from, to).filter((line) => /Workflow card|Explorer/.test(line)).map((line) => line.trim())
    const inTab = rows(0, 20)
    expect(inTab.some((line) => line.includes("Workflow card: Review PR 5110"))).toBe(true)
    expect(inTab.some((line) => line.includes("Explorer"))).toBe(true)
    expect(rows(20, 60)).toEqual(inTab)

    const lines = window.lines()
    const explorer = lines.findIndex((line, index) => index >= 20 && line.includes("Explorer"))
    await window.render.mockMouse.click(lines[explorer]!.indexOf("Explorer") + 2, explorer)
    await window.settle()
    // The view stays and the tab in front stays in front: the child opens over the view, as over a tab.
    expect(window.overlay.viewer.stack).toHaveLength(2)
    expect(window.foreground()).toBe("front")
    await window.press("escape")
    expect(window.overlay.viewer.stack).toHaveLength(1)
  })
})
