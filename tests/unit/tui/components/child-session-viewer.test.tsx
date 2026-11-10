/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it, mock } from "bun:test"
import { TextAttributes, TextRenderable, type Renderable } from "@opentui/core"
import { createSignal, For } from "solid-js"
import { testRender } from "@opentui/solid"
import { ChildSessionViewer, childSessionStats, createChildSessionViewerInput as createInput } from "../../../../src/tui/components/child-session-viewer.js"
import { sessionViewerBodyHeight, sessionViewerWidth } from "../../../../src/tui/components/modal-frame.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { createOverlayLayers } from "../../../../src/tui/components/modal-stack.js"
import { createChildViewerOpener } from "../../../../src/tui/hooks/create-child-viewer-opener.js"
import { TickPoolProvider } from "../../../../src/tui/context/tick-pool-context.js"
import { transcriptOf } from "../_output-window-transcript.js"
import type { SessionSurface } from "../../../../src/tui/hooks/create-session-surface.js"
import { createSessionSurface } from "../../../../src/tui/hooks/create-session-surface.js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import type { RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import { fakeRuntimeClient, liveView, userMessageBlock } from "../hooks/_output-transcript-cache-fixtures.js"
import type { TranscriptLayoutSlot } from "../../../../src/tui/output-window/output-window-scroll.js"
import type { StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { sessionServingLabel, type RoleAssignmentView } from "../../../../src/protocol/role-protocol-types.js"
import type { FrontendMutation, SubagentSessionAction } from "../../../../src/protocol/app-service-types.js"
import { viewerSurface } from "./_child-session-viewer-fixtures.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { ChildSessionBody } from "../../../../src/tui/components/child-session-body.js"
import { createTranscriptInView } from "../../../../src/tui/hooks/transcript-in-view.js"
import { RuntimeCallTimeout } from "../../../../src/protocol/runtime-client-deadlines.js"
import { createChatSubmissions } from "../../../../src/protocol/client/chat-submissions.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

const renders: Awaited<ReturnType<typeof testRender>>[] = []
const unexpectedQuery = async (): Promise<never> => { throw new Error("unexpected query") }
afterEach(() => { for (const render of renders.splice(0)) render.renderer.destroy() })

function textByContent(root: Renderable, content: string): TextRenderable | undefined {
  const nodes: Renderable[] = [root]
  for (let index = 0; index < nodes.length; index++) nodes.push(...nodes[index]!.getChildren())
  return nodes.find((node): node is TextRenderable => node instanceof TextRenderable && node.plainText === content)
}

async function renderViewer(surface: SessionSurface, input: ReturnType<typeof createInput>, size: { width: number; height: number }, props: Partial<Parameters<typeof ChildSessionViewer>[0]> = {}) {
  const render = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
    <ChildSessionViewer sessionId="child" createSurface={() => surface} input={input} active={() => true} focused={() => true}
      layoutSlot={{}} appService={{ dispatch: async () => { throw new Error("unexpected dispatch") }, query: unexpectedQuery }}
      submissions={createChatSubmissions({ lanes: { onLane: () => () => {} }, dispatch: async () => { throw new Error("unexpected send") } })}
      createProcessControls={() => ({ status: () => undefined, onDetach: () => {}, onStop: () => {} })}
      sessionIntro={{ runtimeIdentity: () => ({ version: "test", buildId: null }), showBuild: () => false, projectRoot: () => "/repo", accountHome: "/home", userDataRoot: "/home/.flywheel",
        branchName: () => undefined, modelLabel: () => "Child model", profileName: () => undefined,
        fontTipDismissed: () => true, tabsHintDismissed: () => true, onDismissTabsHint: () => {}, moduleRows: () => [] }}
      showThinking={false} diffColors={() => "theme"} onClose={() => {}} showToast={() => {}}
      roleView={() => undefined} childStatus={() => ({ waitingOn: undefined })} ensureChildViews={() => {}}
      modelLabel={() => "Child model"} onOpenModel={() => {}} transcriptInView={{ show: () => {} }} onOpenBackground={() => {}} followBackground={() => () => {}} compactionThreshold={() => 40_000} {...props} />
  </TickPoolProvider></ThemeProvider>, size)
  renders.push(render)
  await render.renderOnce()
  return render
}

/** The props the shell's viewer factory supplies to every viewer the opener pushes. */
function openerViewerProps(overrides: Partial<ReturnType<Parameters<typeof createChildViewerOpener>[0]["viewer"]>> = {}): ReturnType<Parameters<typeof createChildViewerOpener>[0]["viewer"]> {
  return {
    createSurface: () => viewerSurface("subagent"),
    appService: { dispatch: async () => { throw new Error("unexpected dispatch") }, query: unexpectedQuery },
    submissions: createChatSubmissions({ lanes: { onLane: () => () => {} }, dispatch: async () => { throw new Error("unexpected send") } }),
    layoutSlot: {},
    createProcessControls: () => ({ status: () => undefined, onDetach: () => {}, onStop: () => {} }),
    sessionIntro: { runtimeIdentity: () => ({ version: "test", buildId: null }), showBuild: () => false, projectRoot: () => "/repo", accountHome: "/home", userDataRoot: "/home/.flywheel",
      branchName: () => undefined, modelLabel: () => "Child model", profileName: () => undefined,
      fontTipDismissed: () => true, tabsHintDismissed: () => true, onDismissTabsHint: () => {}, moduleRows: () => [] },
    showThinking: false, diffColors: () => "theme",
    roleView: () => undefined, childStatus: () => ({ waitingOn: undefined }), ensureChildViews: () => {},
    modelLabel: () => "Child model", onOpenModel: () => {}, transcriptInView: { show: () => {} }, onOpenBackground: () => {}, followBackground: () => () => {}, compactionThreshold: () => undefined,
    ...overrides,
  }
}

describe("child session viewer", () => {
  it.each(["stopped", "failed", "cancelled"] as const)("keeps a %s child's draft for Resume without a finished notice", async (runOutcome) => {
    const original = viewerSurface("subagent").summary()!
    const [settled, setSettled] = createSignal(false)
    const surface = viewerSurface("subagent", { summary: () => ({ ...original, kind: "subagent", inputMode: { kind: "message" },
      lifecycleState: settled() ? "inactive" : "active", runOutcome: settled() ? runOutcome : undefined,
      admittedActions: settled() ? ["subagent.resume"] : ["session.send"] }) })
    const returned = mock(() => {})
    const input = createInput({ onClose: () => {}, dispatchCommand: async () => false })
    const render = await renderViewer(surface, input, { width: 100, height: 32 }, { returnDraft: returned })
    input.onPaste("keep for Resume")
    setSettled(true)
    await render.flush()
    expect(returned).not.toHaveBeenCalled()
    expect(input.text()).toBe("keep for Resume")
    expect(render.captureCharFrame()).not.toContain("finished")
    expect(render.captureCharFrame()).toContain("Resume")
  })
  it.each([{ width: 60, runOutcome: "completed" }, { width: 100, runOutcome: "partial" }, { width: 140, runOutcome: "completed" }] as const)("wraps the finished notice inside an intact frame at %s", async ({ width, runOutcome }) => {
    const original = viewerSurface("subagent").summary()!
    const surface = viewerSurface("subagent", { summary: () => ({ ...original, kind: "subagent", inputMode: { kind: "message" },
      runOutcome, admittedActions: [], lifecycleState: "inactive" }) })
    const render = await renderViewer(surface, createInput({ onClose: () => {}, dispatchCommand: async () => false }), { width, height: 32 })
    await render.flush()
    const rows = render.captureCharFrame().split("\n")
    const first = rows.findIndex(row => row.includes("This subagent finished."))
    expect(first).toBeGreaterThan(0)
    const bottom = rows.findIndex((row, index) => index > first && row.includes("╰"))
    expect(bottom).toBeGreaterThan(first)
    expect(rows.slice(first, bottom).map(row => row.replace(/[│]/g, "").trim()).join(" ")).toContain(
      "This subagent finished. Unread messages stay in the parent chat and return to the sending window's composer while it is open.")
  })
  it("accepts a header and geometry without modal width limits or implicit Stop", async () => {
    const supplied = openerViewerProps()
    const input = createInput({ onClose: () => {}, dispatchCommand: async () => false })
    const render = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
      <ChildSessionBody {...supplied} agentKind="subagent" sessionId="child" surface={viewerSurface("subagent")}
        input={input} active={() => true} focused={() => true} width={124} height={24}
        header={<text>{"Injected header " + "x".repeat(100)}</text>}
        navigation={<text>Return to origin</text>}
        messaging={{ admits: () => false, shown: () => false, send: async () => false }}
        placeholder="Message agent" controls={() => ({})} />
    </TickPoolProvider></ThemeProvider>, { width: 140, height: 30 })
    renders.push(render)
    await render.flush()
    expect(render.captureCharFrame()).toContain("Injected header " + "x".repeat(100))
    expect(render.captureCharFrame()).toContain("Return to origin")
    expect(render.captureCharFrame()).not.toContain("Stop")
    expect(render.captureCharFrame()).not.toContain("Message agent")
  })

  it("sends Model and effort to the agent whose view is in front, and to the chat once no agent view is", async () => {
    const [active, setActive] = createSignal(true)
    const openChatModel = mock(() => {})
    const onOpenModel = mock((_agentName: string) => {})
    const transcriptInView = createTranscriptInView(openChatModel)
    const surface = viewerSurface("subagent")
    const render = await renderViewer(surface, createInput({ onClose: () => {}, dispatchCommand: async () => false }), { width: 100, height: 32 }, { active, onOpenModel, transcriptInView })
    await render.flush()
    transcriptInView.openModel()
    expect(onOpenModel.mock.calls).toEqual([[surface.summary()!.title]])
    expect(openChatModel).not.toHaveBeenCalled()
    expect(transcriptInView.agentInView()).toBe("subagent")
    setActive(false)
    expect(transcriptInView.agentInView()).toBeUndefined()
    transcriptInView.openModel()
    expect(openChatModel).toHaveBeenCalledTimes(1)
    expect(onOpenModel).toHaveBeenCalledTimes(1)
  })

  it("preserves viewer state across overlays", async () => {
    const [active, setActive] = createSignal(true)
    const [focused, setFocused] = createSignal(true)
    const input = createInput({ onClose: () => {}, dispatchCommand: async () => false })
    const layoutSlot: TranscriptLayoutSlot = {}
    const transcript = transcriptOf(Array.from({ length: 60 }, (_, index) => ({ kind: "text", id: `row-${index}`, content: `Transcript row ${index}`, timestamp: 1 })))
    const [budget, setBudget] = createSignal({ totalsLoading: false as const, tokens: 20_000, contextPromptTokens: 20_000, contextPercent: 5, cost: 1.2, billedCost: 1.2, priceUnavailable: false })
    const surface: SessionSurface = {
      sessionId: () => "child", summary: () => ({
        id: "child", kind: "subagent", title: "Child", lifecycleState: "active",
        notices: [], inputMode: { kind: "message" }, lastUpdated: "", executionCwd: "/repo",
        admittedActions: ["session.send"],
        totalsLoading: false, totalCost: 1.2, totalBilledCost: 1.2, priceUnavailable: false,
        totalTokens: 20_000, contextPercent: 5, contextPromptTokens: 20_000, durationMs: 65_000,
      }),
      detail: () => null, loadResult: () => undefined, transcript, outputView: () => undefined,
      status: () => undefined, budget,
      pendingQuestion: () => undefined, streamingToolText: () => ({}), streamingOutputChars: () => 0,
      agentState: () => "idle", interruptible: () => false, activeSubagentCount: () => 0, waitingOnBackgroundWork: () => false,
      activeBackgroundCommands: () => [], sessionKind: () => "subagent", sessionState: () => "active",
      elapsed: () => 65_000, pageOutput: () => {},
    }
    const onOpenModel = mock((_agentName: string) => {})
    const [roles, setRoles] = createSignal<RoleAssignmentView>({
      assignments: { chat: { model: "wrong-parent", effort: "low" } },
      serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "Child model", effort: "high" } },
    })
    const render = await renderViewer(surface, input, { width: 80, height: 32 }, { active, focused, layoutSlot, onOpenModel, modelLabel: () => sessionServingLabel(roles()) })
    await render.flush()
    const rows = render.captureCharFrame().split("\n")
    const composerTop = rows.find((row) => row.includes("Child model"))!
    expect(composerTop).toMatch(/^│  ╭.*╮  │/)
    expect(render.captureCharFrame()).toContain("50% ctx")
    expect(render.captureCharFrame()).toContain("$1.20")
    const initialStats = textByContent(render.renderer.root, "1m 5s · 50% ctx · $1.20")
    expect(initialStats).toBeDefined()
    setBudget((current) => ({ ...current, cost: 1.3, billedCost: 1.3 }))
    await render.flush()
    expect(textByContent(render.renderer.root, "1m 5s · 50% ctx · $1.30")).toBe(initialStats)
    input.onPaste("preserved draft")
    const modelRows = render.captureCharFrame().split("\n")
    const modelRow = modelRows.findIndex((row) => row.includes("Child model"))
    await render.mockMouse.click(modelRows[modelRow]!.indexOf("Child model") + 1, modelRow)
    expect(onOpenModel.mock.calls).toEqual([["Child"]])
    expect(input.text()).toBe("preserved draft")
    input.onKey({ name: "pageup" })
    await render.flush()
    const priorScroll = layoutSlot.scroll?.offset
    const priorFrame = render.captureCharFrame()
    expect(priorScroll).toBeGreaterThan(0)
    setFocused(false)
    await render.flush()
    expect(render.captureCharFrame()).toContain("Transcript row")
    expect(input.text()).toBe("preserved draft")
    setActive(false)
    await render.flush()
    expect(render.captureCharFrame()).not.toContain("Transcript row")
    expect(input.text()).toBe("preserved draft")
    setActive(true)
    setFocused(true)
    await render.flush()
    expect(layoutSlot.scroll?.offset).toBe(priorScroll)
    expect(render.captureCharFrame()).toBe(priorFrame)
    expect(input.text()).toBe("preserved draft")
    setRoles({ assignments: {}, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "edited-child", effort: "low" } } })
    await render.flush()
    expect(render.captureCharFrame()).toContain("edited-child low")
    expect(render.captureCharFrame()).not.toContain("wrong-parent")
    expect(input.text()).toBe("preserved draft")
    expect(layoutSlot.scroll?.offset).toBe(priorScroll)
  })
  it("pushes a nested child over its viewer and keeps the outer viewer's draft", async () => {
    const overlay = createOverlayLayers()
    const navigateUri = mock((_uri: string) => {})
    const outerRow = viewerSurface("subagent").summary()!
    const surfaces = new Map([
      ["outer", viewerSurface("subagent", {
        sessionId: () => "outer",
        summary: () => ({ ...outerRow, id: "outer", childSessionIds: ["subagent"] }),
        transcript: transcriptOf([{
          kind: "agentGroup", containerKind: "subagent", id: "explorer", toolUseId: "dispatch",
          label: "Explorer", description: "Inspect repository", status: "completed",
          linkUri: "flywheel://session/subagent", children: [], totalToolCount: 0, timestamp: 1,
        }, {
          kind: "agentGroup", containerKind: "subagent", id: "stranger", toolUseId: "other",
          label: "Stranger", description: "Named elsewhere", status: "completed",
          linkUri: "flywheel://session/elsewhere", children: [], totalToolCount: 0, timestamp: 2,
        }]),
      })],
      ["subagent", viewerSurface("subagent", { sessionId: () => "subagent" })],
    ])
    const places = createChildViewerOpener({
      viewerLayer: overlay.viewer, navigateUri, showToast: () => {}, provide: (children) => children(), openModuleSession: () => false,
      kindOf: (sessionId) => sessionId === "subagent" ? "subagent" : undefined, dispatchCommand: async () => false,
      viewer: (sessionId) => openerViewerProps({ createSurface: () => surfaces.get(sessionId)! }),
    })
    places.openChild({ id: "outer", kind: "subagent" })
    const outer = overlay.viewer.stack[0]!
    const render = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
      <For each={overlay.viewer.stack}>{(entry) => <box position="absolute">{typeof entry.element === "function" ? entry.element() : entry.element}</box>}</For>
    </TickPoolProvider></ThemeProvider>, { width: 100, height: 32 })
    renders.push(render)
    await render.flush()
    overlay.viewer.paste("outer draft")
    await render.flush()
    const rows = render.captureCharFrame().split("\n")
    const explorerRow = rows.findIndex((row) => row.includes("Explorer"))
    await render.mockMouse.click(rows[explorerRow]!.indexOf("Explorer") + 2, explorerRow)
    await render.flush()

    expect(navigateUri).not.toHaveBeenCalled()
    expect(overlay.viewer.stack).toHaveLength(2)
    expect(overlay.viewer.stack[0]).toBe(outer)
    overlay.viewer.input({ name: "escape" })
    await render.flush()
    expect(overlay.viewer.stack).toEqual([outer])
    expect(render.captureCharFrame()).toContain("outer draft")

    // A link to a session that is not this viewer's own child resolves
    // through the shell's route walk.
    const strangerRows = render.captureCharFrame().split("\n")
    const strangerRow = strangerRows.findIndex((row) => row.includes("Stranger"))
    await render.mockMouse.click(strangerRows[strangerRow]!.indexOf("Stranger") + 2, strangerRow)
    expect(navigateUri).toHaveBeenCalledWith("flywheel://session/elsewhere")
    expect(overlay.viewer.stack).toEqual([outer])
  })
  it("reports a module viewer that fails to open instead of leaving the rejection unhandled", async () => {
    const overlay = createOverlayLayers()
    const toasts: string[] = []
    const timeout = RuntimeCallTimeout.forDeadline(5_000)
    const places = createChildViewerOpener({
      viewerLayer: overlay.viewer, navigateUri: () => {}, showToast: (toast) => { toasts.push(toast.message) }, provide: (children) => children(),
      openModuleSession: () => Promise.reject(timeout), kindOf: () => undefined, dispatchCommand: async () => false, viewer: () => openerViewerProps(),
    })
    places.openChild({ id: "member", kind: "workflow-agent" })
    // A rejection nobody handled fails this test once this turn ends.
    await Bun.sleep(1)

    expect(toasts).toEqual([`Open failed for member: ${timeout.message}`])
    expect(overlay.viewer.stack).toEqual([])
  })
  it("sends one message from a subagent viewer and shows the pending row its output cursor delivers", async () => {
    const runtime = fakeRuntimeClient({ subagent: [] })
    const overlay = createOverlayLayers()
    const dispatched: FrontendMutation[] = []
    const toasts: { message: string; variant: string }[] = []
    let detailHolds = 0
    let detailReleases = 0
    const row = { ...viewerSurface("subagent").summary()!, id: "subagent" }
    if (row.kind !== "subagent") throw new Error("expected a subagent row")
    const detail: RuntimeSessionDetailView = { id: "subagent", source: "durable", kind: "subagent", conversationId: "conversation", budget: null, row, status: {
      activity: "idle", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
      activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0, streamingStartedAt: null,
      accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
    } }
    const none = { ensure: () => {}, ensureMany: () => {}, view: () => undefined }
    let transcriptCache: ReturnType<typeof createOutputTranscriptCache> | undefined
    const render = await testRender(() => {
      const transcripts = createOutputTranscriptCache({ appService: runtime.client })
      transcriptCache = transcripts
      const open = createChildViewerOpener({
        viewerLayer: overlay.viewer, navigateUri: () => {}, showToast: (toast) => { toasts.push(toast) }, provide: (children) => children(), openModuleSession: () => false,
        kindOf: () => undefined,
        dispatchCommand: async () => false,
        viewer: () => openerViewerProps({
          submissions: createChatSubmissions({ lanes: { onLane: () => () => {} }, dispatch: async (sessionId, input) => {
            dispatched.push({ type: "session.send", sessionId, input })
            return dispatched.length === 1 ? { ok: true } : { ok: false, kind: "handing_off", error: "This agent has started its handoff and cannot read another message. Your draft was kept." }
          } }),
          appService: { query: unexpectedQuery, dispatch: async () => { throw new Error("viewer bypassed its submission owner") } },
          createSurface: (id) => createSessionSurface({
            detailCache: { ...none, retain: () => {
              detailHolds++
              return { release: () => { detailReleases++ } }
            }, state: () => ({ loaded: true }), view: () => detail },
            appService: { query: async () => { throw new Error("unexpected query") } },
            transcriptCache: transcripts, statusCache: none, budgetCache: none, questionCache: none,
            row: () => undefined, catalogReady: () => true, now: () => 0, hydrateToHead: async () => {}, onTranscriptFailure: (_id, cause) => { throw cause },
          }, id),
        }),
      })
      open.openChild({ id: "subagent", kind: "subagent" })
      return <ThemeProvider mode="dark"><TickPoolProvider>
        <For each={overlay.viewer.stack}>{(entry) => <box position="absolute">{typeof entry.element === "function" ? entry.element() : entry.element}</box>}</For>
      </TickPoolProvider></ThemeProvider>
    }, { width: 100, height: 32 })
    renders.push(render)
    await render.flush()

    overlay.viewer.paste("human guidance")
    overlay.viewer.input({ name: "return" })
    await render.flush()
    expect(dispatched).toEqual([{ type: "session.send", sessionId: "subagent", input: { text: "human guidance", submissionIds: [expect.any(String)] } }])
    expect(toasts).toEqual([])
    expect(render.captureCharFrame()).not.toContain("human guidance")

    await runtime.live(transcriptCache!, "subagent", liveView([userMessageBlock("message-1", "human guidance", true)]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await render.flush()
    expect(render.captureCharFrame()).toContain("human guidance")

    // A refused message says why and keeps the draft.
    overlay.viewer.paste("late guidance")
    overlay.viewer.input({ name: "return" })
    await render.flush()
    expect(toasts).toEqual([{ message: "This agent has started its handoff and cannot read another message. Your draft was kept.", variant: "warning" }])
    expect(render.captureCharFrame()).toContain("late guidance")
    expect(detailHolds).toBe(1)
    expect(detailReleases).toBe(0)
    overlay.viewer.input({ name: "escape" })
    await render.flush()
    expect(detailReleases).toBe(1)
    expect(dispatched).toHaveLength(2)
  })

  it("keeps Left for the cursor of a subagent's composer, and Escape closes the viewer", async () => {
    const closed: string[] = []
    const input = createInput({ onClose: () => closed.push("closed"), dispatchCommand: async () => false })
    await renderViewer(viewerSurface("subagent"), input, { width: 100, height: 32 })
    input.onKey({ name: "left" })
    expect(closed).toEqual([])
    input.onKey({ name: "escape" })
    expect(closed).toEqual(["closed"])
  })

  it("shows the viewed subagent's live activity on its composer border", async () => {
    const [active, setActive] = createSignal(true)
    const [focused, setFocused] = createSignal(true)
    const [activity, setActivity] = createSignal<StatusView["activity"]>("executing_tools")
    const [streamingOutputChars, setStreamingOutputChars] = createSignal(0)
    const [admittedActions, setAdmittedActions] = createSignal<readonly SubagentSessionAction[]>(["session.send"])
    const status = (): StatusView => ({
      activity: activity(),
      settledOutputPosition: null,
      activityStartedAt: 0,
      connectionState: "connected",
      activeSubagentCount: 0,
      waitingOnBackgroundWork: false,
      activeBackgroundCommands: [],
      activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
      startedAt: Date.now(),
      streamingStartedAt: Date.now(),
      accumulatedActiveMs: 0,
      compactionStartedAt: null,
      replyWaits: [],
    })
    const input = createInput({ onClose: () => {}, dispatchCommand: async () => false })
    const surface: SessionSurface = {
      sessionId: () => "child",
      summary: () => ({
        id: "child", kind: "subagent", title: "Child", lifecycleState: "active",
        notices: [], inputMode: { kind: "message" }, lastUpdated: "", executionCwd: "/repo",
        admittedActions: admittedActions(),
        totalsLoading: false, totalCost: 0, totalBilledCost: 0, priceUnavailable: false,
        totalTokens: 0, contextPercent: 0, contextPromptTokens: 0, durationMs: 0,
      }),
      detail: () => null,
      loadResult: () => undefined,
      transcript: transcriptOf([]),
      outputView: () => undefined,
      status,
      budget: () => undefined,
      pendingQuestion: () => undefined,
      streamingToolText: () => ({}),
      streamingOutputChars,
      agentState: () => activity() === "idle" ? "idle" : "active",
      interruptible: () => activity() !== "idle",
      activeSubagentCount: () => 0,
      waitingOnBackgroundWork: () => false,
      activeBackgroundCommands: () => [],
      sessionKind: () => "subagent",
      sessionState: () => "active",
      elapsed: () => 0,
      pageOutput: () => {},
    }
    const render = await renderViewer(surface, input, { width: 80, height: 32 }, { active, focused })
    expect(render.captureCharFrame().split("\n").find((row) => row.includes("Executing"))).toMatch(/^│  ╰/)

    setFocused(false)
    setActivity("generating")
    setStreamingOutputChars(1)
    await Promise.resolve()
    await render.renderOnce()
    expect(render.captureCharFrame()).toContain("Generating")
    const generatingSpans = render.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.includes("Generating"))
    expect(generatingSpans.length).toBeGreaterThan(0)
    expect(generatingSpans.every((span) => span.fg.equals(resolveTheme(flywheelTheme, "dark").text))).toBe(true)
    expect(generatingSpans.every((span) => (span.attributes & TextAttributes.BLINK) === 0)).toBe(true)

    setActive(false)
    await Promise.resolve()
    await render.renderOnce()
    expect(render.captureCharFrame()).not.toContain("Generating")

    setActive(true)
    setFocused(true)
    await Promise.resolve()
    await render.renderOnce()
    expect(render.captureCharFrame().split("\n").find((row) => row.includes("Generating"))).toMatch(/^│  ╰/)

    setActivity("idle")
    setAdmittedActions(["session.delete"])
    await Promise.resolve()
    await render.renderOnce()
    const settledFrame = render.captureCharFrame()
    expect(settledFrame.split("\n").find((row) => row.includes("Idle"))).toMatch(/^│  ╰/)
    expect(settledFrame).not.toContain("Message this subagent")
  })
  it("offers subagent controls and stops through the parent's tool call", async () => {
    const kind = "subagent" as const
    const [admittedActions, setAdmittedActions] = createSignal<readonly SubagentSessionAction[]>(["session.send", "subagent.interrupt", "background.terminate"])
    const [agentState, setAgentState] = createSignal<"active" | "idle">("active")
    const dispatched: FrontendMutation[] = []
    const answered = async (command: FrontendMutation) => { dispatched.push(command); return { ok: true as const } }
    const input = createInput({ onClose: () => {}, dispatchCommand: async () => false })
    const surface: SessionSurface = {
      sessionId: () => "child",
      summary: () => ({
        id: "child", title: "Child", lifecycleState: "active",
        notices: [], lastUpdated: "", executionCwd: "/repo",
        parentSessionId: "parent", parentToolUseId: "tool-7",
        kind, inputMode: { kind: "message" as const }, admittedActions: admittedActions(),
        totalsLoading: false, totalCost: 0, totalBilledCost: 0, priceUnavailable: false,
        totalTokens: 0, contextPercent: 0, contextPromptTokens: 0, durationMs: 0,
      }),
      detail: () => null, loadResult: () => undefined, transcript: transcriptOf([]), outputView: () => undefined,
      status: () => undefined, budget: () => undefined,
      pendingQuestion: () => undefined, streamingToolText: () => ({}), streamingOutputChars: () => 0,
      agentState, interruptible: () => agentState() === "active", activeSubagentCount: () => 0, waitingOnBackgroundWork: () => false,
      activeBackgroundCommands: () => [], sessionKind: () => kind, sessionState: () => "active",
      elapsed: () => 0, pageOutput: () => {},
    }
    // A running child animates its status, so its frames never go idle.
    const render = await renderViewer(surface, input, { width: 80, height: 32 }, { appService: {
      query: unexpectedQuery,
      dispatch: runtimeDispatch({ "subagent.interrupt": answered, "subagent.resume": answered, "background.terminate": answered, "workflow.interrupt": async (command) => { dispatched.push(command); return { ok: true, kind: "interrupt", interrupted: true } } }),
    } })
    const press = async (label: string) => {
      const rows = render.captureCharFrame().split("\n")
      const y = rows.findIndex((row) => row.includes(` ${label} `))
      await render.mockMouse.pressDown(rows[y]!.indexOf(` ${label} `) + 1, y)
      await render.mockMouse.release(rows[y]!.indexOf(` ${label} `) + 1, y)
    }
    // A subagent's controls sit in its footer.
    const actionRow = () => render.captureCharFrame().split("\n").find((row) => row.includes("Close")) ?? ""
    expect(actionRow()).toContain("Interrupt")
    expect(actionRow()).toContain("Stop")
    expect(actionRow()).not.toContain("Resume")
    expect(actionRow()).not.toContain("Pause")

    await press("Interrupt")
    await press("Stop")
    await Promise.resolve()
    expect(dispatched).toEqual([
      { type: "subagent.interrupt", sessionId: "child" },
      { type: "background.terminate", sessionId: "parent", toolUseId: "tool-7" },
    ])

    // Interrupt is offered only while the child runs.
    setAgentState("idle")
    await render.flush()
    expect(actionRow()).not.toContain("Interrupt")

    setAdmittedActions(["subagent.resume"])
    await render.flush()
    expect(actionRow()).toContain("Resume")
    expect(actionRow()).not.toContain("Interrupt")
    expect(actionRow()).not.toContain("Stop")
    await press("Resume")
    await Promise.resolve()
    expect(dispatched.at(-1)).toEqual({ type: "subagent.resume", sessionId: "child" })
  })
  // A child's question goes to its parent, which answers it or asks the
  // person in its own dock, so the child viewer has no question dock and
  // keeps its composer while a question is open.
  it("shows no question dock in a subagent viewer and keeps the composer for a message", async () => {
    const surface = viewerSurface("subagent", {
      pendingQuestion: () => ({ kind: "question", toolUseId: "question-1", timestamp: 1, questions: [{
        question: "Which color should the page use?", multiSelect: false,
        choices: [{ kind: "option", choiceId: "choice-0", label: "Red" }, { kind: "freeform", label: "Other" }],
      }] }),
    })
    const render = await renderViewer(surface, createInput({ onClose: () => {}, dispatchCommand: async () => false }), { width: 90, height: 32 })
    await render.flush()
    const frame = render.captureCharFrame()
    expect(frame).not.toContain("Ask User")
    expect(frame).not.toContain("Which color should the page use?")
    expect(frame).toContain("Message this subagent")
  })

  it("names the session a parked child waits on in its status", async () => {
    const status: StatusView = {
      activity: "idle", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, waitingOnBackgroundWork: true,
      activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null,
      accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [{ sessionId: "parent", name: "Design chat" }],
    }
    const surface = viewerSurface("subagent", { status: () => status, waitingOnBackgroundWork: () => true })
    const render = await renderViewer(surface, createInput({ onClose: () => {}, dispatchCommand: async () => false }), { width: 90, height: 32 })
    await render.flush()
    expect(render.captureCharFrame()).toContain("Waiting on parent")
  })

  it("shares terminal-filling viewer dimensions with a minimum width", () => {
    expect(sessionViewerBodyHeight(12)).toBe(5)
    expect(sessionViewerWidth(200)).toBe(198)
    expect(sessionViewerWidth(20)).toBe(34)
  })

  it("shows loading history and joins the child's own measured budget without the client timer", () => {
    const text = childSessionStats({
      budget: () => ({ totalsLoading: true }),
      summary: () => ({
        id: "child",
        kind: "subagent",
        title: "Child",
        lifecycleState: "inactive",
        notices: [],
        inputMode: { kind: "message" },
        admittedActions: ["session.delete"],
        lastUpdated: "2026-01-01T00:00:00.000Z",
        executionCwd: "/repo",
        totalsLoading: true,
      }),
      elapsed: () => { throw new Error("loading duration must not read the client timer") },
    }, 70, 0.8)

    expect(text).toBe("totals loading")
    expect(childSessionStats({
      budget: () => ({ totalsLoading: false, tokens: 100, cost: 1, billedCost: 1, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0, averageGenerationTokensPerSecond: 9.54 }),
      summary: () => null,
      elapsed: () => 0,
    }, 80, 0)).toBe("0.0k ctx · $1.00 · 10 tok/s")
  })
})
