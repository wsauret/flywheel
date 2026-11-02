/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { TextAttributes, TextRenderable, type Renderable } from "@opentui/core"
import { WorkflowAgentViewer, type WorkflowAgentViewerProps } from "../../../../src/tui/modules/workflows/agent-viewer.js"
import { createChildSessionViewerInput } from "../../../../src/tui/components/child-session-viewer.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../src/tui/context/tick-pool-context.js"
import type { FrontendMutation, FrontendOutputBlock, RuntimeQuery } from "../../../../src/protocol/app-service-types.js"
import type { LoadedWorkflowView, WorkflowAgentLive } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { attemptOf, stage } from "../../workflows/vm/_map-fixtures.js"
import { drive, frontendView, items, mapBindings, mapControl, mapOutcome, phaseBindings, phaseControl, startNext } from "../../workflows/vm/_tree-fixtures.js"
import { childBodyProps, viewerSurface } from "./_child-session-viewer-fixtures.js"
import { workflowDetail } from "../../../helpers/runtime-views.js"
import { transcriptOf } from "../_output-window-transcript.js"
import type { StatusView } from "../../../../src/protocol/status-protocol-types.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { resolvedTheme, sameColor } from "./prompt-border-fixtures.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

const renders: Awaited<ReturnType<typeof testRender>>[] = []
afterEach(() => { for (const render of renders.splice(0)) render.renderer.destroy() })

/** A map run whose item a failed in implement, and whose item b runs
 *  implement now. */
function mapRun(): LoadedWorkflowView {
  const control = startNext(drive(mapControl(), mapOutcome(items("a", "b", "c"), new Set([attemptOf(stage(1, 1))])), (committed) => committed.attempts.some(({ state }) => state._tag === "failed")))
  return { ...frontendView(control, mapBindings), name: "Probe each surface" }
}

const unexpectedQuery = async (query: RuntimeQuery): Promise<never> => { throw new Error(`unexpected query ${query.type}`) }

async function renderAgent(props: Partial<WorkflowAgentViewerProps> & Pick<WorkflowAgentViewerProps, "target">, view: () => LoadedWorkflowView, options: { readonly admitted?: readonly ("session.send" | "workflow.interrupt" | "workflow.resume")[]; readonly live?: () => readonly WorkflowAgentLive[]; readonly interruptible?: () => boolean; readonly status?: () => StatusView | undefined; readonly streamingOutputChars?: () => number; readonly width?: number; readonly blocks?: readonly FrontendOutputBlock[] } = {}) {
  const loaded = () => ({ ...view(), followUpSessionId: "follow-up", attempts: view().attempts.map((attempt) => ({ ...attempt, sessionId: `member-${attempt.id}`, history: attempt.history ?? [] })) })
  const base = viewerSurface("workflow-agent").summary()
  if (base?.kind !== "workflow-agent") throw new Error("Expected a member row")
  const surfaces = (sessionId: () => string | undefined) => viewerSurface("workflow-agent", {
    sessionId,
    summary: () => {
      const attempt = loaded().attempts.find((candidate) => candidate.sessionId === sessionId())
      const held = options.live?.().some((agent) => agent.attemptId === attempt?.id && agent.interruptedAt !== undefined)
      return { ...base, id: sessionId() ?? "", admittedActions: attempt?.status === "running" ? ["session.send", "chat.interrupt", ...(held ? ["chat.resume" as const] : [])] : [] }
    },
    transcript: { ...transcriptOf([]), visibleRange: () => transcriptOf(options.blocks ?? [{ kind: "text", id: `text-${sessionId()}`, content: `Transcript of ${sessionId()?.replace("member-", "")}`, timestamp: 1 }]).visibleRange() },
    status: options.status ?? (() => undefined),
    streamingOutputChars: options.streamingOutputChars ?? (() => 0),
    agentState: () => options.status?.()?.activity === "idle" ? "idle" : "active",
    waitingOnBackgroundWork: () => options.status?.()?.waitingOnBackgroundWork ?? false,
    interruptible: options.interruptible ?? (() => !options.live?.().some((agent) => agent.sessionId === sessionId() && agent.interruptedAt !== undefined)),
  })
  const dispatched: FrontendMutation[] = []
  const answered = async (command: FrontendMutation) => { dispatched.push(command); return { ok: true as const } }
  const events: string[] = []
  const input = createChildSessionViewerInput({ onClose: () => events.push("back"), dispatchCommand: async () => false })
  const render = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
    <WorkflowAgentViewer workflowId="child" origin="chat" createSurface={surfaces}
      inspectWorkflow={() => ({ detail: () => workflowDetail(), view: loaded, live: options.live ?? (() => []) })}
      body={childBodyProps} input={input} active={() => true} focused={() => true}
      appService={{
        dispatch: runtimeDispatch({ "session.send": answered, "chat.interrupt": answered, "chat.resume": answered, "workflow.interrupt": async (command) => { dispatched.push(command); return { ok: true, kind: "interrupt", interrupted: true } } }),
        query: unexpectedQuery,
      }}
      title={(id) => id === "parent" ? "Fanout-fail" : undefined}
      onBack={() => events.push("back")} onClose={() => events.push("close")} showToast={() => {}} showThinking={false} diffColors={() => "theme"} {...props} />
  </TickPoolProvider></ThemeProvider>, { width: options.width ?? 100, height: 32 })
  renders.push(render)
  await render.flush()
  await render.flush()
  const press = async (label: string) => {
    const rows = render.captureCharFrame().split("\n")
    const y = rows.findIndex((row) => row.includes(label))
    expect(y).toBeGreaterThanOrEqual(0)
    await render.mockMouse.pressDown(rows[y]!.indexOf(label) + 1, y)
    await render.mockMouse.release(rows[y]!.indexOf(label) + 1, y)
    await render.flush()
  }
  return { render, input, dispatched, events, press, frame: () => render.captureCharFrame() }
}

describe("workflow agent viewer", () => {
  it("opens an imported generation as an ordinary read-only session and returns to the current member", async () => {
    const current = mapRun()
    const shown = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) } }, () => ({
      ...current, attempts: current.attempts.map((attempt) => ({ ...attempt, history: [{ sessionId: "old-generation", conversationId: "old-conversation" }] })),
    }))
    await shown.press("Earlier session 1")
    expect(shown.frame()).toContain("Transcript of old-generation")
    expect(shown.frame()).not.toContain("Message item b")
    expect(shown.frame()).not.toContain("Interrupt")
    await shown.press("Latest session")
    expect(shown.frame()).toContain(`Transcript of ${attemptOf(stage(2, 1))}`)
    expect(shown.frame()).toContain("Message item b")
  })

  it("retains history buttons and transcript across workflow rereads and uses the current history destination", async () => {
    const initial = mapRun()
    const [view, setView] = createSignal({ ...initial, attempts: initial.attempts.map(attempt => ({ ...attempt, history: [{ sessionId: "old-generation", conversationId: "old-conversation" }] })) })
    const shown = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) } }, view)
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
    const nodes = descendants(shown.render.renderer.root)
    const earlier = nodes.find(node => node instanceof TextRenderable && node.plainText.includes("Earlier session 1"))
    const transcript = nodes.find(node => node instanceof TextRenderable && node.plainText.includes("Transcript of"))
    if (!earlier || !transcript) throw new Error("History or transcript did not render")
    setView(structuredClone(view()))
    await shown.render.renderOnce()
    expect(descendants(shown.render.renderer.root).includes(earlier)).toBe(true)
    expect(descendants(shown.render.renderer.root).includes(transcript)).toBe(true)
    await shown.press("Earlier session 1")
    expect(shown.frame()).toContain("Transcript of old-generation")
  })
  it("folds the original brief in the ordinary transcript and expands it in place without hiding later messages", async () => {
    const shown = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) } }, mapRun, { blocks: [
      { kind: "userMessage", id: "original-brief", content: "Unique initial brief\nSecond brief line", timestamp: 1, pending: false, injected: false },
      { kind: "text", id: "answer", content: "Agent response", timestamp: 2 },
      { kind: "userMessage", id: "later-direction", content: "Unique later direction", timestamp: 3, pending: false, injected: false },
    ] })
    expect(shown.frame()).toContain("▸ Brief")
    expect(shown.frame()).not.toContain("Unique initial brief")
    expect(shown.frame()).toContain("Unique later direction")
    const rows = shown.frame().split("\n")
    const y = rows.findIndex((row) => row.includes("▸ Brief"))
    const x = rows[y]!.indexOf("▸ Brief") + 1
    await shown.render.mockMouse.pressDown(x, y)
    await shown.render.mockMouse.release(x, y)
    await shown.render.flush()
    expect(shown.frame()).toContain("Unique initial brief")
    expect(shown.frame()).toContain("Second brief line")
    expect(shown.frame()).toContain("Agent response")
  })
  it("renders the selected member's live status in the ordinary border with its color and no blinking", async () => {
    const [status, setStatus] = createSignal<StatusView>({
      activity: "thinking", activityStartedAt: Date.now(), settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0,
      activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, 
      startedAt: Date.now(), streamingStartedAt: Date.now(), accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
    })
    const [streamingOutputChars, setStreamingOutputChars] = createSignal(0)
    const shown = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) } }, mapRun, { status, streamingOutputChars })
    const assertStatus = (label: string) => {
      expect(shown.frame()).toContain(label)
      const spans = shown.render.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.includes(label))
      expect(spans.length).toBeGreaterThan(0)
      expect(spans.some((span) => sameColor(span.fg, resolvedTheme.text))).toBe(true)
      expect(spans.every((span) => (span.attributes & TextAttributes.BLINK) === 0)).toBe(true)
    }
    assertStatus("Thinking")
    setStatus({ ...status(), activity: "generating" })
    setStreamingOutputChars(10)
    await shown.render.flush()
    assertStatus("Generating")
    setStatus({ ...status(), activity: "idle", compactionStartedAt: Date.now() })
    await shown.render.flush()
    assertStatus("Compacting")
    setStatus({ ...status(), compactionStartedAt: null, waitingOnBackgroundWork: true, replyWaits: [{ sessionId: "parent", name: "Parent" }] })
    await shown.render.flush()
    assertStatus("Waiting on parent")
    setStatus({ ...status(), waitingOnBackgroundWork: false, replyWaits: [], connectionState: "reconnecting" })
    await shown.render.flush()
    expect(shown.frame()).not.toContain("Reconnecting")
    assertStatus("Idle")
  })
  it("draws the workflow band above a rule, then one agent line with the phase and the agent's own name, and drops the word workflow, then the chits, before it cuts any text", async () => {
    // One run and one mounted viewer serve every width: the viewer resizes
    // in place, as a terminal does, and the run is driven once rather than
    // replayed on each read of the view.
    const run = mapRun()
    const shown = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) }, origin: "card" }, () => run, { width: 160 })
    const rows = async (width: number) => {
      shown.render.resize(width, 32)
      await shown.render.renderOnce()
      return shown.frame().split("\n").map((row) => row.replace(/^[│\s]+|[│\s]+$/g, ""))
    }
    const wide = await rows(160)
    // From the full-size card the way back names the card, and the
    // workflow's name stands apart from it behind the workflow's glyph, as
    // the full-size card's title names it. The close affordance keeps the
    // same two columns from the progress that it keeps from any control.
    expect(wide[2]).toMatch(/^‹ All agents {2}⚙ Probe each surface {20,}workflow {2}▰▰▰▰▱▱▱▱ {2}2\/8 done · 1 running · 1 failed {2}x$/)
    expect(wide[3]).toMatch(/^─+$/)
    // The agent is its item, never the record id that every agent of its
    // phase shares, and no line lists its siblings.
    expect(wide[4]).toMatch(/^implement › b {10,}running {3}Interrupt$/)
    expect(wide[5]).toBe("")
    expect(wide.join("\n")).not.toMatch(/✗ a|○ c|phase /)
    expect(wide.join("\n")).toContain("Next agent 2/3 tab")
    // The run's name that its view carries names it, not the session's
    // generated title.
    expect(wide.join("\n")).not.toContain("Run Workflow With Supplied Input")
    // The widths on each side of each drop, from the widest down: the word
    // goes first, then the chits, then the count takes its short words, and
    // the name is cut only once nothing is left to drop. The count, the way
    // back, the close affordance, the agent, its state, and its control
    // stay.
    for (const width of [99, 98, 89, 88, 79, 78, 74, 73]) {
      const all = await rows(width)
      const band = all[2] ?? ""
      expect({ width, word: band.includes("workflow"), chits: band.includes("▰"), long: band.includes("done"), cut: band.includes("…") }).toEqual({ width, word: width >= 99, chits: width >= 89, long: width >= 79, cut: width < 74 })
      expect(band).toMatch(/^‹ \S.* {2}\S.* {2}2\/8( done)? · 1 running · 1 failed {2}x$/)
      expect(all[3]).toMatch(/^─+$/)
      expect(all[4]).toMatch(/^implement › b +running {3}Interrupt$/)
    }
    // A band that would cut the way back or the name below 8 columns takes
    // two lines, and the progress reads its full words again on its own.
    const narrow = await rows(50)
    expect(narrow[2]).toMatch(/^‹ All agents {2}⚙ Probe each surface +x$/)
    expect(narrow[3]).toMatch(/^ *▰▰▰▰▱▱▱▱ {2}2\/8 done · 1 running · 1 failed$/)
    expect(narrow[4]).toMatch(/^─+$/)
    // A band of two lines whose first line cuts a name keeps only the close
    // affordance's two columns, so no column stands empty beside a cut.
    const longRun = { ...run, name: "Launch fanout UI workflow with supplied files" }
    const long = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) } }, () => longRun, { width: 60 })
    const first = long.frame().split("\n").map((row) => row.replace(/^[│\s]+|[│\s]+$/g, ""))[2] ?? ""
    expect(first).toMatch(/^‹ Fanout-fail {2}⚙ Launch fanout UI workflow with…  x$/)
  })

  it("names the workflow apart from a way back to the chat, heads the follow-up conversation, and lights the way back under the pointer", async () => {
    const fromChat = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) } }, mapRun, { width: 160 })
    expect(fromChat.frame()).toMatch(/‹ Fanout-fail {2}⚙ Probe each surface +workflow {2}▰/)
    const followUp = await renderAgent({ target: { kind: "followUp" } }, mapRun, { width: 100 })
    expect(followUp.frame()).toMatch(/│ {2}follow-up +│/)
    const theme = resolveTheme(flywheelTheme, "dark")
    const rows = fromChat.frame().split("\n")
    const y = rows.findIndex((row) => row.includes("‹ Fanout-fail"))
    const back = () => fromChat.render.captureSpans().lines[y]!.spans.find(({ text }) => text.includes("‹ Fanout-fail"))!
    expect(back().bg.equals(theme.backgroundElement)).toBe(true)
    // The workflow's name stands apart from the way back: plain ground and
    // bold, where the way back is a raised button.
    const name = fromChat.render.captureSpans().lines[y]!.spans.find(({ text }) => text.includes("⚙ Probe each surface"))!
    expect(name.bg.equals(theme.backgroundElement)).toBe(false)
    expect((name.attributes & TextAttributes.BOLD) !== 0).toBe(true)
    await fromChat.render.mockMouse.moveTo(rows[y]!.indexOf("‹") + 1, y)
    await fromChat.render.flush()
    expect(back().bg.equals(theme.primary)).toBe(true)
    expect(back().fg.equals(theme.background)).toBe(true)
  })

  it("names the way back by its origin, addresses its composer to the agent's item, and goes back on Escape and on Left in an empty composer", async () => {
    const fromChat = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) } }, mapRun)
    expect(fromChat.frame()).toContain("‹ Fanout-fail")
    // The agent line leads with the phase id and names the agent by its item.
    expect(fromChat.frame()).toMatch(/implement › b +running {3}Interrupt/)
    expect(fromChat.frame()).toContain(`Transcript of ${attemptOf(stage(2, 1))}`)
    expect(fromChat.frame()).toContain("Message item b")
    fromChat.input.onPaste("Keep the old flag names.")
    fromChat.input.onKey({ name: "return" })
    await fromChat.render.flush()
    await fromChat.press("Interrupt")
    expect(fromChat.dispatched).toEqual([
      { type: "session.send", sessionId: `member-${attemptOf(stage(2, 1))}`, input: "Keep the old flag names." },
      expect.objectContaining({ type: "chat.interrupt", sessionId: `member-${attemptOf(stage(2, 1))}` }),
    ])
    fromChat.input.onKey({ name: "left" })
    fromChat.input.onKey({ name: "escape" })
    await fromChat.press("Close")
    expect(fromChat.events).toEqual(["back", "back", "close"])

    const fromCard = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) }, origin: "card" }, mapRun)
    expect(fromCard.frame()).toMatch(/‹ All agents {2}⚙ Probe each surface/)
  })

  it("moves with Tab through the agents that started, opens a settled agent pinned, and shows no composer for a finished agent", async () => {
    const { frame, input, render } = await renderAgent({ target: { kind: "agent", agentNodeId: stage(1, 1) } }, mapRun)
    // Item a failed in implement: the view stays on that agent and takes no
    // message.
    expect(frame()).toMatch(/implement › a +failed/)
    expect(frame()).not.toContain("Message item")
    expect(frame()).toContain("Next agent 1/3 tab")
    input.onKey({ name: "tab" })
    await render.flush()
    expect(frame()).toMatch(/implement › b +running/)
    expect(frame()).toContain("Next agent 2/3 tab")
    expect(frame()).toContain("Message item b")
    input.onKey({ name: "tab", shift: true })
    input.onKey({ name: "tab", shift: true })
    await render.flush()
    expect(frame()).toMatch(/│ {2}plan +done +│/)
  })

  it("follows a running agent into the next phase, stays after settlement, and pins manual navigation", async () => {
    const [view, setView] = createSignal(mapRun())
    const { frame, render, input } = await renderAgent({ target: { kind: "agent", agentNodeId: stage(2, 1) } }, view)
    expect(frame()).toMatch(/implement › b +running/)
    const moved = startNext(drive(mapControl(), mapOutcome(items("a", "b", "c"), new Set([attemptOf(stage(1, 1))])), (committed) => committed.attempts.some(({ id, state }) => id === attemptOf(stage(2, 1)) && state._tag === "completed")))
    setView({ ...frontendView(moved, mapBindings), name: "Map Run" })
    await render.flush()
    await render.flush()
    expect(frame()).toMatch(/review › b +running/)
    expect(frame()).not.toContain("implement › b")
    const settled = drive(mapControl(), mapOutcome(items("a", "b", "c"), new Set([attemptOf(stage(1, 1))])), (committed) => committed.attempts.some(({ id, state }) => id === attemptOf(stage(2, 2)) && state._tag === "completed"))
    setView(frontendView(settled, mapBindings))
    await render.flush()
    await render.flush()
    expect(frame()).toMatch(/review › b +done/)
    expect(frame()).toContain(`Transcript of ${attemptOf(stage(2, 2))}`)
    input.onKey({ name: "tab", shift: true })
    await render.flush()
    expect(frame()).toMatch(/implement › b +done/)
    setView({ ...frontendView(settled, mapBindings) })
    await render.flush()
    expect(frame()).toMatch(/implement › b +done/)
  })

  it("names the agent of a phase of one agent by its phase alone and addresses it by its record id", async () => {
    const view = { ...frontendView(startNext(phaseControl(false)), phaseBindings(false)), name: "Phases" }
    const running = view.tree.nodes.find((node) => node.kind === "agent" && node.disposition === "running")
    if (running === undefined) throw new Error("a running agent required")
    const { frame } = await renderAgent({ target: { kind: "agent", agentNodeId: running.id } }, () => view)
    expect(frame()).toContain("Message agent implement")
    expect(frame()).toMatch(/│ {2}implement +running {3}Interrupt +│/)
    expect(frame()).not.toContain("implement › ")
    expect(frame()).toMatch(/Next agent tab/)
  })

  it("gives each concurrent agent its own Interrupt, and its own Resume while an interrupt holds it", async () => {
    const view = frontendView(startNext(startNext(phaseControl(true))), phaseBindings(true))
    const [first, second] = view.tree.nodes.filter((node) => node.kind === "agent" && node.disposition === "running")
    if (first?.kind !== "agent" || second?.kind !== "agent") throw new Error("running agents required")
    const [live, setLive] = createSignal<readonly WorkflowAgentLive[]>([])
    const startedAt = Date.now() - 20_000
    const { press, dispatched, frame, render } = await renderAgent({ target: { kind: "agent", agentNodeId: second.id, follow: false } },
      () => ({ ...view, attempts: view.attempts.map((attempt) => ({ ...attempt, startedAt })) }), { admitted: ["session.send", "workflow.interrupt", "workflow.resume"], live })
    await press("Interrupt")
    expect(dispatched.at(-1)).toEqual({ type: "chat.interrupt", sessionId: `member-${second.currentAttemptId}` })
    setLive([{ attemptId: second.currentAttemptId!, sessionId: `member-${second.currentAttemptId}`, operations: 0, interruptedAt: startedAt + 5_000, duration: 5_000, revision: 1 }])
    await render.flush()
    expect(frame()).toContain("interrupted")
    expect(frame()).toContain("5s")
    await press("Resume")
    expect(dispatched.at(-1)).toEqual({ type: "chat.resume", sessionId: `member-${second.currentAttemptId}` })
    expect(first.definitionId).not.toBe(second.definitionId)
  })
})
