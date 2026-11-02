/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { createWorkflowCardViewerInput, WorkflowCardViewer, type WorkflowCardViewerProps } from "../../../../src/tui/modules/workflows/card-viewer.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../src/tui/context/tick-pool-context.js"
import type { FrontendEvent, FrontendMutation, WorkflowDefinitionDrift, WorkflowSessionAction } from "../../../../src/protocol/app-service-types.js"
import { createRoleCache } from "../../../../src/tui/hooks/create-role-cache.js"
import { rolesCursor, type RoleAssignmentView } from "../../../../src/protocol/role-protocol-types.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import type { WorkflowAgentTarget } from "../../../../src/protocol/client/workflow-agent.js"
import type { LoadedWorkflowView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { attemptOf, stage } from "../../workflows/vm/_map-fixtures.js"
import { drive, frontendView, items, mapBindings, mapControl, mapOutcome, startNext, wideBindings, wideControl } from "../../workflows/vm/_tree-fixtures.js"
import { workflowDetail } from "../../../helpers/runtime-views.js"
import { resolvedTheme, sameColor } from "./prompt-border-fixtures.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const renders: Awaited<ReturnType<typeof testRender>>[] = []
afterEach(() => { for (const render of renders.splice(0)) render.renderer.destroy() })

/** A map run whose item a failed in implement, and whose item b runs
 *  implement now. */
function mapRun(): LoadedWorkflowView {
  const control = startNext(drive(mapControl(), mapOutcome(items("a", "b", "c"), new Set([attemptOf(stage(1, 1))])), (committed) => committed.attempts.some(({ state }) => state._tag === "failed")))
  return { ...frontendView(control, mapBindings), name: "Probe each surface" }
}

async function renderCard(view: LoadedWorkflowView, row: { readonly admittedActions?: readonly WorkflowSessionAction[]; readonly definitionDrift?: WorkflowDefinitionDrift; readonly totalTokens?: number; readonly totalCost?: number; readonly streamingStartedAt?: number } = {}, props: Partial<WorkflowCardViewerProps> = {}, width = 120) {
  const detail = workflowDetail({
    admittedActions: row.admittedActions?.flatMap((action) => action === "session.send" ? ["workflow.send" as const] : action === "background.terminate" ? ["workflow.stop" as const] : action === "session.delete" ? ["workflow.delete" as const] : [action]) ?? ["workflow.interrupt", "workflow.stop"],
    ...(row.definitionDrift ? { definitionDrift: row.definitionDrift } : {}), durationMs: 80_000,
    streamingStartedAt: row.streamingStartedAt ?? null,
    totals: { totalCost: row.totalCost ?? 0, totalBilledCost: row.totalCost ?? 0, priceUnavailable: false, totalInputTokens: row.totalTokens ?? 0, totalOutputTokens: 0 },
  })
  const input = createWorkflowCardViewerInput()
  const events: (string | WorkflowAgentTarget)[] = []
  const dispatched: FrontendMutation[] = []
  const [shown, setView] = createSignal(view)
  const render = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
    <WorkflowCardViewer workflowId="child" inspectWorkflow={() => ({ detail: () => detail, view: shown, live: () => [] })} input={input} active={() => true}
      roleView={() => undefined} ensureRoleViews={() => {}}
      appService={{ dispatch: runtimeDispatch({ "workflow.restart": async (command) => { dispatched.push(command); return { ok: true } } }) }}
      title={(id) => id === "parent" ? "Fanout-fail" : undefined}
      onClose={() => events.push("close")} onOpenAgent={(target) => events.push(target)} onOpenFollowUp={() => events.push("follow-up")} showToast={() => {}} {...props} />
  </TickPoolProvider></ThemeProvider>, { width, height: 36 })
  renders.push(render)
  await render.flush()
  await render.flush()
  const key = async (name: string) => { input.onKey({ name }); await render.flush() }
  const selected = () => render.captureCharFrame().split("\n").find((line) => line.includes("▸ ")) ?? ""
  return { render, events, dispatched, key, selected, setView, frame: () => render.captureCharFrame() }
}

describe("workflow full-size card", () => {
  it.each([3, 30])("updates serving readings without more requests across %s card members", async (count) => {
    let dispose = () => {}
    const captured: string[][] = []
    const listeners = new Set<(event: FrontendEvent) => void>()
    const role = (model: string): RoleAssignmentView => ({
      assignments: { chat: { model: "wrong-chat", effort: "low" } },
      serving: { slot: { kind: "role", roleId: "brief.work.at.worker" }, selection: { model, effort: "high" } },
    })
    const query = runtimeQuery({
      roleSnapshot: async (request) => {
        captured.push([...request.sessionIds])
        return { snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: role("shared-model") })) }
      },
    })
    const cache = createRoot((cleanup) => {
      dispose = cleanup
      return createRoleCache({ appService: { query, onLane: fakeLanes().onLane, subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      } } })
    })
    try {
      const loaded = frontendView(drive(wideControl(count), () => ({ handoff: { summary: "done" } })), wideBindings)
      const view = { ...loaded, attempts: loaded.attempts.map((attempt) => ({ ...attempt, sessionId: `session-${attempt.id}` })) }
      const { render, frame, key, setView } = await renderCard(view, {}, { roleView: cache.view, ensureRoleViews: cache.ensureMany }, 200)
      await render.flush()
      expect(captured).toHaveLength(1)
      expect(captured[0]?.length).toBe(view.attempts.length)
      expect(frame()).toContain("shared-model high")
      expect(frame()).not.toContain("wrong-chat")
      captured.length = 0
      const sessionId = view.attempts[0]!.sessionId
      for (let index = 0; index < 3; index++) {
        for (const listener of listeners) listener({ type: "patch", patch: {
          cursor: rolesCursor(sessionId), position: index + 1, prevPosition: index,
          payload: { kind: "roles.updated", roles: role(`edited-${index}`) },
        } })
        setView({ ...view, attempts: view.attempts.map((attempt) => ({ ...attempt })) })
        await render.flush()
      }
      await key("home")
      await key("right")
      expect(frame()).toContain("edited-2 high")
      expect(captured).toEqual([])
    } finally { dispose() }
    expect(listeners.size).toBe(0)
  })

  it("keeps each agent's model on its own line, so the last agent of a phase to start moves no column", async () => {
    const loaded = frontendView(drive(wideControl(8), () => ({ handoff: { summary: "Finished the probe" } })), wideBindings)
    // Every agent but the first of the phase holds a session.
    const view = (all: boolean) => ({ ...loaded, attempts: loaded.attempts.map((attempt, index) => all || index > 0 ? { ...attempt, sessionId: `session-${attempt.id}` } : attempt) })
    const serving: RoleAssignmentView = { assignments: {}, serving: { slot: { kind: "role", roleId: "brief.work.at.worker" }, selection: { model: "same-model", effort: "high" } } }
    const { render, frame, key, setView } = await renderCard(view(false), {}, { roleView: () => serving }, 200)
    await key("home")
    await key("right")
    const agentLines = () => frame().split("\n").filter((line) => /[├└] ✓ t\d/.test(line))
    const columns = () => agentLines().map((line) => line.indexOf("Finished the probe"))
    const before = columns()
    expect(before).toHaveLength(8)
    expect(agentLines().filter((line) => line.includes("same-model high"))).toHaveLength(7)
    setView(view(true))
    await render.flush()
    expect(columns()).toEqual(before)
    expect(agentLines().every((line) => line.includes("same-model high"))).toBe(true)
  })

  it("does not name a model for a row that has no session", async () => {
    let reads = 0
    const { frame } = await renderCard(mapRun(), {}, { roleView: () => { reads++; return { assignments: {}, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "unbound-model", effort: "high" } } } } })
    expect(reads).toBe(0)
    expect(frame()).not.toContain("unbound-model")
  })
  it("advances duration without repinning a wheel-scrolled reader on equal views, agent updates, or a TickPool tick", async () => {
    const start = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(start)
    const intervals = spyOn(globalThis, "setInterval")
    try {
      const view = frontendView(startNext(wideControl(40)), wideBindings)
      const { render, frame, key, setView } = await renderCard(view, { streamingStartedAt: start })
      const tick = intervals.mock.calls.find(([, delay]) => delay === 1000)?.[0]
      if (typeof tick !== "function") throw new Error("TickPool did not subscribe")
      for (let index = 0; index < 12; index++) { await render.mockMouse.scroll(10, 15, "down"); await render.flush() }
      const visible = () => frame().split("\n").flatMap((text, y) => /[├└] [○●] t\d/.test(text) ? [{ key: text.match(/t\d+/)?.[0], y }] : [])[0]
      const anchor = visible()
      expect(anchor).toBeDefined()
      expect(frame()).not.toContain("▸ ● implement")
      setView({ ...view, attempts: view.attempts.map((attempt) => ({ ...attempt })) })
      await render.flush()
      expect(visible()).toEqual(anchor)
      setView({ ...view, attempts: view.attempts.map((attempt) => ({ ...attempt, toolUses: (attempt.toolUses ?? 0) + 1 })) })
      await render.flush()
      expect(visible()).toEqual(anchor)
      clock.mockReturnValue(start + 1000)
      tick()
      await render.flush()
      expect(frame()).toContain("1m 21s")
      expect(visible()).toEqual(anchor)
      await key("home")
      expect(frame()).toContain("▸ ● implement")
    } finally { clock.mockRestore(); intervals.mockRestore() }
  })
  it("names the chat to go back to, the workflow, and its controls, lists every phase and every agent of a running phase, and pins the plan bar and the keys", async () => {
    const { frame, render } = await renderCard(mapRun())
    // The run's name that its view carries names it, as its inline card
    // does, and not the session's generated title.
    expect(frame()).toMatch(/‹ Fanout-fail\s+⚙ Probe each surface[^\n]*Interrupt\s+Stop\s+x/)
    expect(frame()).not.toContain("Run Workflow With Supplied Input")
    // A phase's name and an agent's name read in the colours they have on the inline card and in the agent view.
    const span = (text: string) => render.captureSpans().lines.flatMap((line) => line.spans).find((candidate) => candidate.text === text)
    expect(sameColor(span("implement")!.fg, resolvedTheme.phaseName)).toBe(true)
    expect(sameColor(span("c")!.fg, resolvedTheme.agentName)).toBe(true)
    expect(frame()).toMatch(/✓ plan[\s\S]*implement[\s\S]*├ ✗ a[\s\S]*├ ● b[\s\S]*└ ○ c[\s\S]*review[\s\S]*tail/)
    expect(frame()).toMatch(/done · 1 running · 1 failed/)
    expect(frame()).toContain("↑↓ select · enter open · → expand · ← fold · esc back")
  })

  it("moves the selection with Up and Down, opens an agent with Enter, folds and expands a phase, and goes back to the chat", async () => {
    const { key, selected, events } = await renderCard(mapRun())
    // The selection starts on the phase that runs.
    expect(selected()).toMatch(/▸ ● implement/)
    await key("down")
    expect(selected()).toMatch(/▸ +├ ✗ a/)
    // A settled agent opens pinned.
    await key("return")
    await key("down")
    // A running agent opens following its item.
    await key("return")
    expect(events).toEqual([{ agentNodeId: stage(1, 1), follow: false }, { agentNodeId: stage(2, 1), follow: true }])
    // Left moves from an agent to its phase, then folds it, then goes back.
    await key("left")
    expect(selected()).toMatch(/▸ ● implement/)
    await key("left")
    expect(selected()).toMatch(/▸ ● implement ▸/)
    await key("right")
    expect(selected()).toMatch(/▸ ● implement ▾/)
    await key("up")
    expect(selected()).toMatch(/▸ ✓ plan/)
    // Enter on a phase of one agent opens its agent.
    await key("return")
    expect(events.at(-1)).toEqual({ agentNodeId: "mapped:node:1", follow: false })
    await key("left")
    await key("escape")
    expect(events.slice(-2)).toEqual(["close", "close"])
  })

  it("hovers and opens a line only from its text, never from the blank after it", async () => {
    const { render, events, frame } = await renderCard(mapRun())
    const rows = frame().split("\n")
    const y = rows.findIndex((line) => line.includes("├ ✗ a  summary is required"))
    const x = rows[y]!.indexOf("✗ a") + 2
    const blank = rows[y]!.indexOf("required") + "required".length + 4
    // A hovered line underlines its name.
    const nameAttributes = () => {
      let column = 0
      return render.captureSpans().lines[y]!.spans.find((span) => (column += span.width) > x)!.attributes
    }
    const idle = nameAttributes()
    await render.mockMouse.moveTo(x, y)
    await render.flush()
    expect(nameAttributes()).not.toBe(idle)
    await render.mockMouse.moveTo(blank, y)
    await render.flush()
    expect(nameAttributes()).toBe(idle)
    await render.mockMouse.click(blank, y)
    expect(events).toEqual([])
    await render.mockMouse.click(x, y)
    expect(events).toEqual([{ agentNodeId: stage(1, 1), follow: false }])
  })

  it("says why a workflow whose definition changed cannot continue, and offers Resume", async () => {
    const paused = { ...mapRun(), state: "paused" as const }
    const { frame } = await renderCard(paused, {
      admittedActions: ["workflow.resume", "session.delete"],
      definitionDrift: { workflowDefinitionId: "implement", changes: [{ component: "graph" }, { component: "persona", id: "reviewer" }] },
    })
    const text = frame().split("\n").map((row) => row.replace(/^[│\s]+|[│\s]+$/g, "")).join(" ").replace(/\s+/g, " ")
    expect(text).toContain("The implement workflow cannot continue because its definition changed after it started. These parts changed: the order of its phases; persona reviewer. Restore them, then press Resume, or start a new workflow.")
    expect(frame()).toMatch(/Cannot continue[^\n]*Resume/)
  })

  it("lays its lines across the whole frame, so a wide terminal leaves no empty columns at the right of a line", async () => {
    const { frame } = await renderCard(mapRun(), {}, {}, 200)
    const rows = frame().split("\n")
    // A phase's count stands in the last columns of the frame, before the
    // time's column, and not at a fixed column in the middle of it.
    for (const text of ["● implement", "○ review"]) {
      const row = rows.find((candidate) => candidate.includes(text)) ?? ""
      expect({ text, count: row.indexOf("0/3") + 3 }).toEqual({ text, count: 188 })
    }
  })

  it("omits tokens, keeps cost when it fits, and preserves the name, state, time, and controls", async () => {
    const paused = { ...mapRun(), state: "paused" as const }
    const wide = await renderCard(paused, { admittedActions: ["workflow.resume", "session.delete"], totalTokens: 18_000, totalCost: 12.34 })
    expect(wide.frame()).toMatch(/⚙ Probe each surface · Interrupted · 1m 20s · \$12\.34\s+Resume/)
    expect(wide.frame()).not.toContain("tokens")
    const narrow = await renderCard(paused, { admittedActions: ["workflow.resume", "session.delete"], totalTokens: 18_000, totalCost: 12.34 }, {}, 84)
    expect(narrow.frame()).toMatch(/⚙ Probe each surface · Interrupted · 1m 20s\s+Resume\s+x/)
    expect(narrow.frame()).not.toContain("tok")
  })

  it("shortens a long name before it drops the state or the time", async () => {
    const paused = { ...mapRun(), state: "paused" as const }
    const { frame } = await renderCard({ ...paused, name: "Run workflow with supplied surfaces and files for every reviewer" }, { admittedActions: ["workflow.resume", "session.delete"], totalTokens: 18_000 }, {}, 100)
    expect(frame()).toMatch(/⚙ Run workflow with supplied[^\n]*… · Interrupted · 1m 20s\s+Resume\s+x/)
  })

  it("keeps a long way back whole while the header has room, and cuts the longer of it and the name first once the header is full, so a 60-column header keeps the state and the time", async () => {
    const paused = { ...mapRun(), state: "paused" as const }
    const chat = "Investigate the flaky login tests on the CI runners"
    const wide = await renderCard(paused, { admittedActions: ["workflow.resume", "session.delete"] }, { title: () => chat }, 160)
    expect(wide.frame()).toContain(`‹ ${chat}  ⚙ Probe each surface · Interrupted · 1m 20s`)
    const full = await renderCard(paused, { admittedActions: ["workflow.resume", "session.delete"] }, { title: () => chat }, 100)
    expect(full.frame()).toMatch(/‹ Investigate the flaky login te…\s+⚙ Probe each surface · Interrupted · 1m 20s\s+Resume\s+x/)
    const { frame } = await renderCard({ ...paused, name: "Run workflow with supplied surfaces and files for every reviewer" }, { admittedActions: ["workflow.resume", "background.terminate", "session.delete"], totalTokens: 18_000 }, {}, 60)
    expect(frame()).toMatch(/‹ \S+\s+⚙ \S+ · Interrupted · 1m 20s\s+Resume\s+Stop\s+x/)
  })

  it("offers Restart for saved progress that cannot run, and runs it", async () => {
    const { frame, dispatched, render } = await renderCard({ ...mapRun(), state: "paused" }, { admittedActions: ["workflow.restart", "session.delete"] })
    expect(frame()).toContain("Restart runs it again from its recorded request.")
    const rows = frame().split("\n")
    const y = rows.findIndex((row) => row.includes(" Restart "))
    await render.mockMouse.pressDown(rows[y]!.indexOf(" Restart ") + 2, y)
    await render.mockMouse.release(rows[y]!.indexOf(" Restart ") + 2, y)
    await render.flush()
    expect(dispatched).toEqual([{ type: "workflow.restart", workflowId: "child" }])
  })
})
