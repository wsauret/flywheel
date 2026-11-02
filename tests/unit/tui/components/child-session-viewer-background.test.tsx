/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ChildSessionViewer, createChildSessionViewerInput } from "../../../../src/tui/components/child-session-viewer.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../src/tui/context/tick-pool-context.js"
import type { BackgroundModalTarget } from "../../../../src/tui/hooks/use-background-modal.js"
import type { StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { transcriptOf } from "../_output-window-transcript.js"
import { viewerSurface } from "./_child-session-viewer-fixtures.js"
import { createChatSubmissions } from "../../../../src/protocol/client/chat-submissions.js"

test("opens background work from a subagent's chip and lands in its viewer's transcript", async () => {
  const command = { id: "bg", toolUseId: "bash-bg", description: "Background proof", startedAtMs: 1 }
  const status: StatusView = {
    activity: "idle", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0,
    activeBackgroundCommands: [command], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: true,
    startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0,
    compactionStartedAt: null, replyWaits: [],
  }
  const loadAround = mock(async (_entryId: string) => {})
  const surface = viewerSurface("subagent", {
    status: () => status, activeBackgroundCommands: () => [command], waitingOnBackgroundWork: () => true,
    streamingToolText: () => ({ "bash-bg": { content: "viewer output" } }),
    transcript: { ...transcriptOf([{ kind: "text", id: "background-entry", content: "Background command output", timestamp: 1 }]), loadAround },
  })
  const input = createChildSessionViewerInput({ onClose: () => {}, dispatchCommand: async () => false })
  const onOpenBackground = mock((_target: BackgroundModalTarget) => {})
  const render = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
    <ChildSessionViewer sessionId="child" createSurface={() => surface} input={input} active={() => true} focused={() => true}
      layoutSlot={{}} appService={{ query: async () => { throw new Error("unexpected query") }, dispatch: async () => { throw new Error("unexpected dispatch") } }}
      submissions={createChatSubmissions({ lanes: { onLane: () => () => {} }, dispatch: async () => { throw new Error("unexpected send") } })}
      createProcessControls={() => ({ activeHeldToolCallIds: () => new Set(), processorHeldToolCallIds: () => new Set(), activeManagedProcessToolCallIds: () => new Set(), onDetach: () => {}, onStop: () => {} })}
      sessionIntro={{ runtimeIdentity: () => ({ version: "test", buildId: null }), showBuild: () => false, projectRoot: () => "/repo", accountHome: "/home", userDataRoot: "/home/.flywheel",
        branchName: () => undefined, modelLabel: () => "Child model", profileName: () => undefined,
        fontTipDismissed: () => true, tabsHintDismissed: () => true, onDismissTabsHint: () => {}, moduleRows: () => [] }}
      showThinking={false} diffColors={() => "theme"} onClose={() => {}} showToast={() => {}}
      roleView={() => undefined} childStatus={() => ({ waitingOn: undefined })} ensureChildViews={() => {}}
      modelLabel={() => "Child model"} onOpenModel={() => {}} transcriptInView={{ show: () => {} }} onOpenBackground={onOpenBackground} compactionThreshold={() => 40_000} />
  </TickPoolProvider></ThemeProvider>, { width: 100, height: 32 })
  try {
    await render.renderOnce()
    const rows = render.captureCharFrame().split("\n")
    const y = rows.findIndex((row) => row.includes("1 background process"))
    expect(y).toBeGreaterThanOrEqual(0)
    await render.mockMouse.click(rows[y]!.indexOf("1 background process") + 4, y)
    expect(onOpenBackground).toHaveBeenCalledWith({
      sessionId: "child", streamingToolText: surface.streamingToolText, navigateToProcess: expect.any(Function),
    })
    onOpenBackground.mock.calls[0]![0].navigateToProcess("background-entry")
    await render.renderOnce()
    expect(loadAround).toHaveBeenCalledTimes(1)
    expect(loadAround).toHaveBeenCalledWith("background-entry")
    expect(render.captureCharFrame()).toContain("Background command output")
  } finally { render.renderer.destroy() }
})
