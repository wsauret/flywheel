/** @jsxImportSource @opentui/solid */
import { afterEach, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import type { AgentGroupBlock } from "../../../../src/infra/output-blocks.js"
import type { RoleAssignmentView } from "../../../../src/protocol/role-protocol-types.js"
import { BlockRenderer } from "../../../../src/tui/output-blocks/block-renderer.js"
import { terminalTranscript } from "../../../../src/tui/output-blocks/visible-output-blocks.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../src/tui/context/tick-pool-context.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"

const renders: Awaited<ReturnType<typeof testRender>>[] = []
afterEach(() => { for (const render of renders.splice(0)) render.renderer.destroy() })

it("a subagent keeps its persona while initializing and reveals its full card when ready", async () => {
  const initial: AgentGroupBlock = {
    kind: "agentGroup", containerKind: "subagent", id: "child-row", toolUseId: "child-call",
    label: "Explorer", description: "Read the files", status: "pending", children: [], totalToolCount: 0, timestamp: 1,
  }
  const [block, setBlock] = createSignal<AgentGroupBlock>(initial)
  const [roles, setRoles] = createSignal<RoleAssignmentView>()
  const theme = resolveTheme(flywheelTheme, "dark")
  const render = await testRender(() => <TickPoolProvider><ThemeProvider mode="dark"><BlockRenderer block={terminalTranscript([block()], false).timelineBlocks[0]!} roleView={roles} childStatus={() => ({ waitingOn: "Waiting on parent" })} processControls={{
    activeHeldToolCallIds: () => new Set(), processorHeldToolCallIds: () => new Set(), activeManagedProcessToolCallIds: () => new Set(),
    onDetach() {}, onStop() {}, onStopChild() {},
  }} /></ThemeProvider></TickPoolProvider>, { width: 160, height: 8 })
  renders.push(render)
  const captureText = () => render.captureSpans().lines.map(({ spans }) => spans.map(({ text }) => text).join("")).join("\n")
  const partials: readonly AgentGroupBlock[] = [
    initial,
    { ...initial, description: "Read the files and report", model: "gpt-6-astra high" },
    { ...initial, status: "active", linkUri: "flywheel://session/child", activeStartedAt: Date.now() },
    { ...initial, status: "active", linkUri: "flywheel://session/child", model: "gpt-6-astra high", children: [{ kind: "tool", id: "read", name: "read", presentation: { name: "Read", detail: "preview.ts" }, status: "completed", timestamp: 1 }], totalToolCount: 1 },
  ]
  for (const partial of partials) {
    setBlock(partial)
    await render.renderOnce()
    expect(captureText()).toContain("Explorer · Initializing...")
    expect(captureText()).not.toContain("└")
    const capturedSpans = render.captureSpans().lines.flatMap(({ spans }) => spans)
    const persona = capturedSpans.find(({ text }) => text.includes("Explorer"))
    expect(persona?.fg.equals(theme.text)).toBe(true)
    expect((persona?.attributes ?? 0) & TextAttributes.UNDERLINE).toBe(0)
    expect(capturedSpans.find(({ text }) => text.includes("Initializing"))?.fg.equals(theme.textSubtle)).toBe(true)
    for (const detail of ["Read the files", "gpt-6-astra", "stop", "Open", "preview.ts", "Waiting on parent"]) expect(captureText()).not.toContain(detail)
  }
  const ready: AgentGroupBlock = { ...initial, status: "active", model: "gpt-6-astra high", linkUri: "flywheel://session/child", activeStartedAt: Date.now() }
  setBlock(ready)
  setRoles({ assignments: { chat: { model: "wrong-chat", effort: "low" } }, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "gpt-6-astra", effort: "medium" } } })
  await render.renderOnce()
  expect(captureText()).not.toContain("Initializing")
  for (const detail of ["Explorer", "Read the files", "gpt-6-astra medium", "stop", "Waiting on parent"]) expect(captureText()).toContain(detail)
  expect(captureText()).toMatch(/└ ● Waiting on parent/)
  expect(captureText().split("\n")[0]).not.toContain("Waiting on parent")
  const readySpans = render.captureSpans().lines.flatMap(({ spans }) => spans)
  expect(readySpans.find(({ text }) => text === "●")?.fg.equals(theme.primary)).toBe(true)
  expect(readySpans.find(({ text }) => text.includes("Waiting on parent"))?.fg.equals(theme.warning)).toBe(true)
  expect(captureText()).not.toContain("gpt-6-astra high")
  setRoles({ assignments: {}, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "edited-agent", effort: "high" } } })
  await render.renderOnce()
  expect(captureText()).toContain("edited-agent high")
  expect(captureText()).not.toContain("gpt-6-astra")
  for (const preserved of [
    { ...initial, status: "queued" as const },
    { ...initial, status: "interrupted" as const },
    { ...initial, status: "completed" as const },
    { ...ready, activeStartedAt: undefined, duration: 10 },
  ]) {
    setBlock(preserved)
    await render.renderOnce()
    expect(captureText()).not.toContain("Initializing")
    expect(captureText()).toContain("Explorer")
  }
})
