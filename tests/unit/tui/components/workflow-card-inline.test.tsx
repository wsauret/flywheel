/** @jsxImportSource @opentui/solid */
import { afterEach, expect, it } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { WorkflowCardBox, type WorkflowCardAction } from "../../../../src/tui/output-blocks/workflow-card.js"
import type { WorkflowAgentLive } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { workflowCard, workflowCardChoice, type WorkflowCardChoices } from "../../../../src/protocol/client/workflow-card.js"
import { FANOUT, timedFanoutOutline } from "../../protocol/client/_workflow-card-fixtures.js"
import { resolvedTheme } from "./prompt-border-fixtures.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"

const renders: Awaited<ReturnType<typeof testRender>>[] = []
afterEach(() => { for (const render of renders.splice(0)) render.renderer.destroy() })

it.each([100, 70])("aligns inline rows and styles their exact cells at %i columns", async (width) => {
  const card = workflowCard(timedFanoutOutline(FANOUT.lanes), { settled: false })
  const render = await testRender(() => <ThemeProvider mode="dark"><WorkflowCardBox card={card} status="active"
    live={[{ attemptId: "lanes:1:probe-1", sessionId: "probe-session", operations: 1, duration: 0, revision: 1, activity: { name: "Read", detail: "model-access.md" } }]}
    width={width} now={() => 302_000} hovered={false} theme={resolvedTheme} /></ThemeProvider>, { width, height: 20 })
  renders.push(render)
  await render.flush()
  const rows = render.captureCharFrame().split("\n").map((row) => row.trimEnd())
  expect(rows[0]).toBe(`╭${"─".repeat(width - 2)}╮`)
  expect(rows[1]).toBe(`${`│ ▰▰▰▰▰▰▱▱▱▱▱  3/11${width >= 80 ? " done" : ""} · 3 running`.padEnd(width - 2)} │`)
  expect(rows.filter((row) => row.startsWith("│"))).not.toContain(`│${" ".repeat(width - 2)}│`)
  const phase = rows.find((row) => row.includes("● probe")) ?? ""
  const agent = rows.find((row) => row.includes("● api")) ?? ""
  expect(phase).toBe(`${"│ ● probe ▰▰▰  2/3 · api · cli · web".padEnd(width - 8)}1m 58s │`)
  expect(agent).toBe(`${"│   ├ ● api    Read model-access.md".padEnd(width - 8)}1m 51s │`)
  expect(phase.indexOf("2/3")).toBe(agent.indexOf("Read"))
  const spans = render.captureSpans().lines.flatMap((line) => line.spans)
  expect(spans.find(({ text }) => text === "Read")?.fg.equals(resolvedTheme.chatCodeType)).toBe(true)
  expect(spans.find(({ text }) => text === "probe")?.fg.equals(resolvedTheme.phaseName)).toBe(true)
  expect(spans.filter(({ text }) => text === "api").every(({ fg }) => fg.equals(resolvedTheme.agentName))).toBe(true)
})

it.each([100, 70])("keeps counts and call sentences visible beside a long item key at %i columns", async (width) => {
  const folded = workflowCard(timedFanoutOutline(FANOUT.lanes), { settled: false })
  const card = { ...folded, phases: folded.phases.map((phase) => ({ ...phase,
    agents: phase.agents?.map((agent) => agent.label === "api" ? { ...agent, label: "src/orchestration/session/conversation/conversation-block-projection-subagents.test.ts" } : agent),
  })) }
  const render = await testRender(() => <ThemeProvider mode="dark"><WorkflowCardBox card={card} status="active"
    live={[{ attemptId: "lanes:1:probe-1", sessionId: "probe-session", operations: 1, duration: 0, revision: 1, activity: { name: "Read", detail: "model-access.md" } }]}
    width={width} now={() => 302_000} hovered={false} theme={resolvedTheme} /></ThemeProvider>, { width, height: 20 })
  renders.push(render)
  await render.flush()
  const rows = render.captureCharFrame().split("\n").map((row) => row.trimEnd())
  const phase = rows.find((row) => row.includes("● probe")) ?? ""
  const agent = rows.find((row) => row.includes("Read model-access.md")) ?? ""
  expect(phase).toContain("2/3 · api")
  expect(agent).toContain("Read model-access.md")
  expect(phase.indexOf("2/3")).toBe(agent.indexOf("Read"))
  expect(agent.endsWith("1m 51s │")).toBe(true)
  expect(render.captureSpans().lines.flatMap((line) => line.spans).find(({ text }) => text === "Read")?.fg.equals(resolvedTheme.chatCodeType)).toBe(true)
})

it.each([false, true])("keeps narrow agent sentences and times visible with a path key: %s", async (longKey) => {
  const folded = workflowCard(timedFanoutOutline(FANOUT.lanes), { settled: false })
  const card = { ...folded, phases: folded.phases.map((phase) => ({ ...phase,
    agents: phase.agents?.map((agent) => agent.state === "done" ? { ...agent, detail: "Finished the implementation" } : longKey ? { ...agent, label: "src/orchestration/session/conversation/conversation-block-projection-subagents.test.ts" } : agent),
  })) }
  const [live, setLive] = createSignal<readonly WorkflowAgentLive[]>([{ attemptId: "lanes:1:probe-1", sessionId: "probe-session", operations: 0, duration: 0, revision: 0, runtimeActivity: "thinking" }])
  const render = await testRender(() => <ThemeProvider mode="dark"><WorkflowCardBox card={card} status="active"
    live={live()}
    width={42} now={() => 302_000} hovered={false} theme={resolvedTheme} /></ThemeProvider>, { width: 42, height: 20 })
  renders.push(render)
  await render.flush()
  const before = render.captureCharFrame().split("\n").find((row) => row.includes("├ ●")) ?? ""
  expect(before).toContain("Thinking")
  expect(before.trimEnd().endsWith("1m 51s")).toBe(true)
  expect(render.captureSpans().lines.flatMap((line) => line.spans).find(({ text }) => text === "Thinking")?.fg.equals(resolvedTheme.textMuted)).toBe(true)
  setLive([{ attemptId: "lanes:1:probe-1", sessionId: "probe-session", operations: 1, duration: 0, revision: 1, activity: { name: "Read", detail: "model-access.md" } }])
  await render.flush()
  const text = render.captureCharFrame()
  const running = text.split("\n").find((row) => row.includes("├ ●")) ?? ""
  expect(running).toContain(longKey ? "Read model-acce…" : "Read model-access.md")
  expect(running.trimEnd().endsWith("1m 51s")).toBe(true)
  expect(text).not.toContain("Finished")
})

it("shows a muted live state before the first call in a narrow single-agent phase", async () => {
  const card = workflowCard(timedFanoutOutline(FANOUT.scout), { settled: false })
  const [live, setLive] = createSignal<readonly WorkflowAgentLive[]>([{ attemptId: "scout-1", sessionId: "scout-session", operations: 0, duration: 0, revision: 0, runtimeActivity: "thinking" }])
  const render = await testRender(() => <ThemeProvider mode="dark"><WorkflowCardBox card={card} status="active"
    live={live()} width={42} now={() => 302_000} hovered={false} theme={resolvedTheme} /></ThemeProvider>, { width: 42, height: 20 })
  renders.push(render)
  await render.flush()
  const before = render.captureCharFrame().split("\n")
  const focus = before.findIndex((row) => row.includes("Thinking"))
  expect(focus).toBeGreaterThanOrEqual(0)
  expect(render.captureSpans().lines.flatMap((line) => line.spans).find(({ text }) => text === "Thinking")?.fg.equals(resolvedTheme.textMuted)).toBe(true)
  setLive([{ attemptId: "scout-1", sessionId: "scout-session", operations: 1, duration: 0, revision: 1, activity: { name: "Read", detail: "model-access.md" } }])
  await render.flush()
  const after = render.captureCharFrame().split("\n")
  expect(after[focus]).toContain("Read model-access.md")
  expect(after.filter((row) => row.trim() !== "")).toHaveLength(before.filter((row) => row.trim() !== "").length)
  expect(render.captureCharFrame()).not.toContain("Thinking")
})

it("keeps the phase id before chits in a 45-column box", async () => {
  const card = workflowCard(timedFanoutOutline(FANOUT.reviewsFailing), { settled: false })
  const render = await testRender(() => <ThemeProvider mode="dark"><WorkflowCardBox card={card} status="active"
    live={[]} width={45} now={() => 600_000} hovered={false} theme={resolvedTheme} /></ThemeProvider>, { width: 45, height: 20 })
  renders.push(render)
  await render.flush()
  expect(render.captureCharFrame()).toContain("● review")
})

it("names each started agent's serving model in its own column and follows a changed reading", async () => {
  const card = workflowCard(timedFanoutOutline(FANOUT.lanes), { settled: false })
  const api = card.phases.flatMap(({ agents }) => agents ?? []).find(({ label }) => label === "api")!.agentNodeId
  const [model, setModel] = createSignal("gpt-x high")
  const render = await testRender(() => <ThemeProvider mode="dark"><WorkflowCardBox card={card} status="active"
    live={[{ attemptId: "lanes:1:probe-1", sessionId: "probe-session", operations: 1, duration: 0, revision: 1, activity: { name: "Read", detail: "model-access.md" } }]}
    modelLabel={(agentNodeId) => agentNodeId === api ? model() : undefined}
    width={100} now={() => 302_000} hovered={false} theme={resolvedTheme} /></ThemeProvider>, { width: 100, height: 20 })
  renders.push(render)
  await render.flush()
  const rows = () => render.captureCharFrame().split("\n").map((row) => row.trimEnd())
  const agent = rows().find((row) => row.includes("● api")) ?? ""
  const phase = rows().find((row) => row.includes("● probe")) ?? ""
  expect(agent).toBe(`${"│   ├ ● api    gpt-x high  Read model-access.md".padEnd(92)}1m 51s │`)
  expect(phase).not.toContain("gpt-x")
  expect(phase.indexOf("2/3")).toBe(agent.indexOf("Read"))
  expect(render.captureSpans().lines.flatMap((line) => line.spans).find(({ text }) => text.startsWith("gpt-x"))?.fg.equals(resolvedTheme.textMuted)).toBe(true)
  setModel("edited-model low")
  await render.flush()
  const edited = rows().find((row) => row.includes("● api")) ?? ""
  expect(edited).toContain("├ ● api    edited-model low  Read model-access.md")
  expect(edited.endsWith("1m 51s │")).toBe(true)
})

it("drops a model column that would crowd the sentences before it cuts a name or a time", async () => {
  const card = workflowCard(timedFanoutOutline(FANOUT.lanes), { settled: false })
  const render = await testRender(() => <ThemeProvider mode="dark"><WorkflowCardBox card={card} status="active"
    live={[{ attemptId: "lanes:1:probe-1", sessionId: "probe-session", operations: 1, duration: 0, revision: 1, activity: { name: "Read", detail: "model-access.md" } }]}
    modelLabel={() => "claude-opus-4-1-20250805 high"}
    width={70} now={() => 302_000} hovered={false} theme={resolvedTheme} /></ThemeProvider>, { width: 70, height: 20 })
  renders.push(render)
  await render.flush()
  const agent = render.captureCharFrame().split("\n").map((row) => row.trimEnd()).find((row) => row.includes("● api")) ?? ""
  expect(agent).toBe(`${"│   ├ ● api    Read model-access.md".padEnd(62)}1m 51s │`)
})

it("hovers and opens an agent only inside the box, though the frame is wider than the card", async () => {
  const card = workflowCard(timedFanoutOutline(FANOUT.lanes), { settled: false })
  const actions: WorkflowCardAction[] = []
  const render = await testRender(() => <ThemeProvider mode="dark"><WorkflowCardBox card={card} status="active" live={[]}
    width={140} now={() => 302_000} hovered={false} theme={resolvedTheme} onAction={(action) => actions.push(action)} /></ThemeProvider>, { width: 140, height: 20 })
  renders.push(render)
  await render.flush()
  const y = render.captureCharFrame().split("\n").findIndex((row) => row.includes("● api"))
  const agentUnderlines = () => render.captureSpans().lines[y]!.spans
    .filter(({ text }) => text === "api")
    .map(({ attributes }) => (attributes & TextAttributes.UNDERLINE) !== 0)
  await render.mockMouse.moveTo(120, y)
  await render.renderOnce()
  expect(agentUnderlines()).toEqual([false])
  await render.mockMouse.moveTo(10, y)
  await render.renderOnce()
  expect(agentUnderlines()).toEqual([true])
  await render.mockMouse.moveTo(120, y)
  await render.renderOnce()
  expect(agentUnderlines()).toEqual([false])
  await render.mockMouse.click(120, y)
  expect(actions).toEqual([])
  await render.mockMouse.click(10, y)
  expect(actions.map(({ kind }) => kind)).toEqual(["agent"])
})

it.each([false, true])("expands the counted line once when a drag releases over a newly revealed agent (paint during drag: %s)", async (paintDuringDrag) => {
  const outline = timedFanoutOutline(FANOUT.reviews)
  const actions: WorkflowCardAction[] = []
  const render = await testRender(() => {
    const [choices, setChoices] = createSignal<WorkflowCardChoices>()
    const card = createMemo(() => workflowCard(outline, { settled: false, choices: choices() }))
    const onAction = (action: WorkflowCardAction) => {
      actions.push(action)
      if (action.kind === "agent" || action.kind === "followUp") return
      setChoices(workflowCardChoice(choices(), action, card(), "active"))
    }
    return <ThemeProvider mode="dark"><WorkflowCardBox card={card()} status="active" live={[]}
      width={100} now={() => 302_000} hovered={false} theme={resolvedTheme} onAction={onAction} /></ThemeProvider>
  }, { width: 100, height: 30 })
  renders.push(render)
  await render.flush()
  const rows = render.captureCharFrame().split("\n")
  const y = rows.findIndex(row => row.includes("+8 more"))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = rows[y]!.indexOf("more")
  await render.mockMouse.pressDown(x, y)
  await render.mockMouse.moveTo(x + 1, y)
  if (paintDuringDrag) await render.renderOnce()
  await render.mockMouse.release(x + 1, y)
  expect(actions).toHaveLength(1)
  expect(actions.map(({ kind }) => kind)).toEqual(["counted"])
})
