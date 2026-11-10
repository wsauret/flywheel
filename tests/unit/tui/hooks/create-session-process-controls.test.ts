import { expect, it } from "bun:test"
import { createStore, produce } from "solid-js/store"
import type { ToolEntry } from "../../../../src/infra/output-blocks.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import type { StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { createSessionProcessControls } from "../../../../src/tui/hooks/create-session-process-controls.js"
import { rowProcessControl, rowWaitsForProcessor } from "../../../../src/tui/output-blocks/stop-affordance.js"
import { terminalTranscript } from "../../../../src/tui/output-blocks/visible-output-blocks.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"
import { statusView } from "../../../helpers/runtime-views.js"

function harness(initial: StatusView) {
  const [views, setViews] = createStore<{ [sessionId: string]: StatusView }>({ parent: initial })
  const dispatched: FrontendMutation[] = []
  let reads = 0
  const controls = createSessionProcessControls({
    appService: { dispatch: runtimeDispatch({
      "bash.detach": (command) => { dispatched.push(command); return { ok: true } },
      "background.terminate": (command) => { dispatched.push(command); return { ok: true } },
    }) },
    signals: { statusView: (sessionId) => { reads += 1; return views[sessionId] } },
    showToast: () => {},
  })
  return {
    controls,
    dispatched,
    // The per-session cache replaces a session's whole view on every patch.
    publish: (next: StatusView) => { setViews(produce((state) => { state.parent = next })) },
    takeReads: () => { const taken = reads; reads = 0; return taken },
  }
}

it("shows the control and the processor wait that the session's current status names", () => {
  const { controls, dispatched, publish } = harness({
    ...statusView("executing_tools"),
    activeForegroundBashToolCallIds: ["held"],
    activeBackgroundCommands: [{ id: "bash-1", description: "bun run build", toolUseId: "managed", startedAtMs: 0 }],
    processorHeldToolCallIds: ["held"],
  })
  const row = controls("parent")

  expect(rowProcessControl(row, "held")?.label).toContain("detach")
  expect(rowProcessControl(row, "managed")?.label).toContain("stop")
  expect(rowProcessControl(row, "other")).toBeUndefined()
  expect(rowWaitsForProcessor(row, { id: "held", status: "completed" })).toBe(true)
  expect(rowWaitsForProcessor(row, { id: "managed", status: "completed" })).toBe(false)
  // Stop ends only a command that the background still manages.
  row.onStop("held")
  row.onStop("managed")
  expect(dispatched).toEqual([{ type: "background.terminate", sessionId: "parent", toolUseId: "managed" }])

  publish(statusView("idle"))

  expect(rowProcessControl(row, "held")).toBeUndefined()
  expect(rowProcessControl(row, "managed")).toBeUndefined()
  expect(rowWaitsForProcessor(row, { id: "held", status: "completed" })).toBe(false)
})

// A row checks its control on every pointer move, in a handler that has no
// reactive owner. A check that left anything subscribed to the status would
// run again on every later status change, for as long as the client lives.
it("keeps the work of a status change independent of how often the pointer crossed a row", async () => {
  const [{ testRender }, { createComponent }, { BlockRenderer }, { ThemeProvider }, { TickPoolProvider }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("../../../../src/tui/output-blocks/block-renderer.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  const tool: ToolEntry = {
    kind: "tool",
    id: "call",
    name: "bash",
    presentation: { name: "Bash", detail: "bun run build" },
    status: "streaming",
    timestamp: Date.now(),
  }
  const block = terminalTranscript([tool], false).timelineBlocks[0]!
  const held: StatusView = { ...statusView("executing_tools"), activeForegroundBashToolCallIds: [tool.id] }
  const { controls, dispatched, publish, takeReads } = harness(held)
  const result = await testRender(
    () => createComponent(TickPoolProvider, {
      get children() {
        return createComponent(ThemeProvider, {
          mode: "dark",
          get children() {
            return createComponent(BlockRenderer, {
              block,
              // What a call in a JSX attribute compiles to: every read of the
              // prop asks for the session's controls again.
              get processControls() { return controls("parent") },
            })
          },
        })
      },
    }),
    { width: 80, height: 8 },
  )
  try {
    await result.renderOnce()
    const lines = result.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("detach"))
    expect(row).toBeGreaterThanOrEqual(0)
    const column = lines[row]!.indexOf("detach")

    const readsOfOneChange = async (accumulatedActiveMs: number) => {
      takeReads()
      publish({ ...held, accumulatedActiveMs })
      await result.renderOnce()
      return takeReads()
    }
    // The pointer rests on the row for both counts, so the row is in the
    // same hover state and only the moves between them differ.
    await result.mockMouse.moveTo(2, row)
    const before = await readsOfOneChange(1)
    for (let move = 0; move < 40; move += 1) await result.mockMouse.moveTo(3 + (move % 2), row)
    expect(await readsOfOneChange(2)).toBe(before)

    await result.mockMouse.click(column + 1, row)
    expect(dispatched).toEqual([{ type: "bash.detach", sessionId: "parent", toolUseId: tool.id }])
  } finally {
    result.renderer.destroy()
  }
})
