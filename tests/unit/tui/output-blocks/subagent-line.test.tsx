/** @jsxImportSource @opentui/solid */
import { afterEach, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import type { AgentGroupBlock } from "../../../../src/infra/output-blocks.js"
import type { RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import type { SubagentControls } from "../../../../src/tui/context/subagent-controls.js"
import { SubagentControlsProvider } from "../../../../src/tui/context/subagent-controls.js"
import { AgentGroupBlock as AgentBlock } from "../../../../src/tui/output-blocks/agent-group-block.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../src/tui/context/tick-pool-context.js"
import { RowWidthProvider } from "../../../../src/tui/context/row-width.js"
import { NavigationProvider } from "../../../../src/tui/context/navigation.js"
import { resolvedTheme } from "../components/prompt-border-fixtures.js"
import { viewerSurface } from "../components/_child-session-viewer-fixtures.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

const renders: Awaited<ReturnType<typeof testRender>>[] = []
afterEach(() => { for (const render of renders.splice(0)) render.renderer.destroy() })
const base: AgentGroupBlock = {
  kind: "agentGroup", containerKind: "subagent", id: "child", toolUseId: "dispatch", status: "active",
  label: "Explorer", description: "Trace rendering", model: "model high", totalToolCount: 3, totalTokens: 900,
  duration: 7000, children: [], timestamp: 1, linkUri: "flywheel://session/child",
  activity: { name: "Read", detail: "src/file.ts" }, summary: "Fixed the issue",
}

async function renderBlock(block: () => AgentGroupBlock, width = 100, controls?: SubagentControls) {
  const render = await testRender(() => <TickPoolProvider><ThemeProvider mode="dark"><RowWidthProvider value={{ width: () => width, report() {} }}>
    <SubagentControlsProvider value={controls}><NavigationProvider value={() => {}}>
      <AgentBlock block={block()} processControls={{ status: () => undefined, onStop() {}, onDetach() {}, onStopChild() {} }} />
    </NavigationProvider></SubagentControlsProvider>
  </RowWidthProvider></ThemeProvider></TickPoolProvider>, { width, height: 8 })
  renders.push(render)
  await render.renderOnce()
  return render
}

it.each([
  ["active", "●", "primary"], ["completed", "✓", "success"], ["partial", "◐", "warning"],
  ["error", "✗", "error"], ["paused", "‖", "warning"], ["interrupted", "‖", "warning"],
  ["stopped", "–", "textMuted"], ["cancelled", "–", "textMuted"], ["queued", "○", "textMuted"],
] as const)("styles the %s glyph and keeps time only in the header", async (status, glyph, color) => {
  const block: AgentGroupBlock = status === "error"
    ? { ...base, status, failure: { title: "Failed", message: "Rate limited", guidance: "" } }
    : status === "paused" ? { ...base, status, pausedBy: "person" } : { ...base, status }
  const render = await renderBlock(() => block, 70)
  const rows = render.captureCharFrame().split("\n")
  const header = rows.find((row) => row.includes("Explorer")) ?? ""
  const line = rows.find((row) => row.includes(`└ ${glyph}`)) ?? ""
  expect(header).toContain("model high · 7s")
  expect(line).not.toContain("7s")
  const capturedSpans = render.captureSpans().lines.flatMap(({ spans }) => spans)
  expect(capturedSpans.find(({ text }) => text === glyph)?.fg.equals(resolvedTheme[color])).toBe(true)
  expect(capturedSpans.find(({ text }) => text.includes(" · 7s"))?.fg.equals(resolvedTheme.textSubtle)).toBe(true)
  if (status === "partial") expect(line).toContain("Partial: Fixed the issue")
  if (status === "active") expect(capturedSpans.find(({ text }) => text === "Read")?.fg.equals(resolvedTheme.chatCodeType)).toBe(true)
})

it("drops operations, then cuts the goal while keeping identity, model, time, and controls", async () => {
  for (const [width, operations, goal] of [[110, true, true], [80, true, true], [65, false, true], [50, false, false]] as const) {
    const render = await renderBlock(() => base, width)
    const header = render.captureCharFrame().split("\n").find((row) => row.includes("Explorer")) ?? ""
    expect(header).not.toContain("tokens")
    expect(header.includes("3 operations")).toBe(operations)
    expect(header.includes("Trace rendering")).toBe(goal)
    for (const text of ["Explorer", "model high · 7s", "↗ Open", "stop"]) expect(header).toContain(text)
    if (width === 110) expect(header).toContain("Explorer · Trace rendering · model high · 7s · 3 operations")
  }
})

it("highlights the persona and Open control while the card is hovered", async () => {
  const render = await renderBlock(() => base)
  const headerSpans = () => render.captureSpans().lines[0]!.spans
  expect(headerSpans().find(({ text }) => text === "Explorer")?.fg.equals(resolvedTheme.text)).toBe(true)
  expect(headerSpans().find(({ text }) => text.includes("↗ Open"))?.fg.equals(resolvedTheme.primary)).toBe(true)
  await render.mockMouse.moveTo(5, 0)
  await render.renderOnce()
  const hovered = headerSpans()
  expect(hovered.find(({ text }) => text === "Explorer")?.fg.equals(resolvedTheme.textBright)).toBe(true)
  const open = hovered.find(({ text }) => text.includes("↗ Open"))
  expect(open?.fg.equals(resolvedTheme.primaryBright)).toBe(true)
  expect((open?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
})

it("dispatches admitted Interrupt and person Resume, preserving the held detail across line updates", async () => {
  const [block, setBlock] = createSignal<AgentGroupBlock>(base)
  const original = viewerSurface("subagent").summary()!
  if (original.kind !== "subagent") throw new Error("expected a subagent row")
  const [row, setRow] = createSignal({ ...original, admittedActions: ["subagent.interrupt", "subagent.resume"] as const })
  const dispatched: unknown[] = []
  const answered = async (mutation: unknown) => { dispatched.push(mutation); return { ok: true as const } }
  let retains = 0
  let releases = 0
  const render = await renderBlock(block, 100, {
    details: {
      retain: () => { retains++; return { release: () => { releases++ } } },
      view: (): RuntimeSessionDetailView => ({
        id: "child", source: "durable", kind: "subagent", conversationId: "conversation", budget: null, row: row(),
        status: {
          activity: "idle", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected",
          activeSubagentCount: 0, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
          waitingOnBackgroundWork: false, startedAt: 0, streamingStartedAt: null,
          accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
        },
      }),
    },
    // Answers only the subagent controls.
    client: { dispatch: runtimeDispatch({ "subagent.interrupt": answered, "subagent.resume": answered }) },
    report: (message) => { throw new Error(message) },
  })
  const click = async (label: string) => {
    const rows = render.captureCharFrame().split("\n")
    const y = rows.findIndex((line) => line.includes(label))
    expect(y).toBeGreaterThanOrEqual(0)
    const span = render.captureSpans().lines[y]?.spans.find(({ text }) => text.includes(label))
    expect(span?.bg.equals(resolvedTheme.primary)).toBe(true)
    await render.mockMouse.click(rows[y]!.indexOf(label) + 1, y)
  }
  await click("interrupt")
  setBlock({ ...base, activity: { name: "Tested", detail: "rendering" }, totalTokens: 901 })
  await render.renderOnce()
  expect(retains).toBe(1)
  expect(releases).toBe(0)
  setBlock({ ...base, status: "paused", pausedBy: "person" })
  setRow({ ...row(), admittedActions: ["subagent.interrupt", "subagent.resume"] as const })
  await render.renderOnce()
  expect(render.captureCharFrame()).toContain("Interrupted by you")
  expect(render.captureCharFrame()).not.toContain("stop")
  await click("resume")
  expect(dispatched).toEqual([{ type: "subagent.interrupt", sessionId: "child" }, { type: "subagent.resume", sessionId: "child" }])
  setBlock({ ...base, status: "completed" })
  await render.renderOnce()
  expect(releases).toBe(1)
  expect(render.captureCharFrame()).not.toContain("resume")
  render.renderer.destroy()
  renders.pop()
  expect(releases).toBe(1)
})
