import { expect, it, mock } from "bun:test"
import type { AgentGroupBlock as AgentGroupBlockType } from "../../../../src/infra/output-blocks.js"
import { terminalTranscript } from "../../../../src/tui/output-blocks/visible-output-blocks.js"
import { workflowDetail } from "../../../helpers/runtime-views.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

it("stops a linked durable child through its parent's tool call", async () => {
  const [{ testRender }, { createComponent }, { BlockRenderer }, { ThemeProvider }, { TickPoolProvider }, { RowWidthProvider }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("../../../../src/tui/output-blocks/block-renderer.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
    import("../../../../src/tui/context/row-width.js"),
  ])
  const childToolUseId = "subagent-bash-call"
  const block: AgentGroupBlockType = {
    kind: "agentGroup",
    containerKind: "subagent",
    id: "subagent-row",
    toolUseId: "subagent-call",
    totalToolCount: 1,
    label: "Explorer with a deliberately long display name",
    description: "Trace provider recovery across every relevant runtime boundary",
    status: "active",
    model: "gpt-6-astra high",
    activeStartedAt: Date.now(),
    activity: { name: "Ran", detail: "bun run test" },
    linkUri: "flywheel://session/child-session",
    children: [{
      kind: "tool",
      id: childToolUseId,
      name: "bash",
      presentation: { name: "Bash", detail: "bun run test" },
      status: "streaming",
      timestamp: Date.now(),
    }],
    timestamp: Date.now(),
  }
  const detach = mock((_toolUseId: string) => {})
  const stop = mock((_toolUseId: string) => {})
  const stopChild = mock((_toolUseId: string) => {})
  const result = await testRender(
    () =>
      createComponent(TickPoolProvider, {
        get children() {
          return createComponent(ThemeProvider, {
            mode: "dark",
            get children() {
              return createComponent(RowWidthProvider, {
                value: { width: () => 36, report: () => {} },
                get children() {
                  return createComponent(BlockRenderer, {
                    block: terminalTranscript([block], false).timelineBlocks[0]!,
                    processControls: {
                      activeHeldToolCallIds: () => new Set([childToolUseId]),
                      activeManagedProcessToolCallIds: () => new Set([block.toolUseId]),
                      processorHeldToolCallIds: () => new Set(),
                      onDetach: detach,
                      onStop: stop,
                      onStopChild: stopChild,
                    },
                  })
                },
              })
            },
          })
        },
      }),
    { width: 36, height: 8 },
  )

  try {
    await result.renderOnce()
    const frame = result.captureCharFrame()
    expect(frame).toContain("Explorer")
    expect(frame).toContain("bun run test")
    expect(frame.match(/stop/g) ?? []).toHaveLength(1)
    expect(frame).not.toContain("detach")

    const stopRow = frame.split("\n").findIndex((line) => line.includes("stop"))
    const stopColumn = frame.split("\n")[stopRow]?.indexOf("stop") ?? -1
    expect(stopRow).toBeGreaterThanOrEqual(0)
    expect(stopColumn).toBeGreaterThanOrEqual(0)

    await result.mockMouse.click(stopColumn + 1, stopRow)
    expect(stopChild).toHaveBeenCalledWith("subagent-call")
    await result.mockMouse.click(stopColumn + "stop".length, stopRow)
    expect(stopChild).toHaveBeenCalledTimes(2)
    expect(stop).not.toHaveBeenCalled()
    expect(detach).not.toHaveBeenCalled()
  } finally {
    result.renderer.destroy()
  }
})

it("keeps an unlinked inline subagent stoppable through its parent tool", async () => {
  const [{ testRender }, { createComponent }, { BlockRenderer }, { ThemeProvider }, { TickPoolProvider }, { RowWidthProvider }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("../../../../src/tui/output-blocks/block-renderer.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
    import("../../../../src/tui/context/row-width.js"),
  ])
  const block: AgentGroupBlockType = {
    kind: "agentGroup",
    containerKind: "subagent",
    id: "inline-subagent",
    toolUseId: "inline-call",
    totalToolCount: 0,
    label: "Historical subagent",
    description: "Inline fallback",
    status: "active",
    children: [],
    timestamp: Date.now(),
  }
  const stop = mock((_toolUseId: string) => {})
  const stopChild = mock((_toolUseId: string) => {})
  const result = await testRender(
    () =>
      createComponent(TickPoolProvider, {
        get children() {
          return createComponent(ThemeProvider, {
            mode: "dark",
            get children() {
              return createComponent(RowWidthProvider, {
                value: { width: () => 36, report: () => {} },
                get children() {
                  return createComponent(BlockRenderer, {
                    block: terminalTranscript([block], false).timelineBlocks[0]!,
                    processControls: {
                      activeHeldToolCallIds: () => new Set(),
                      activeManagedProcessToolCallIds: () => new Set([block.toolUseId]),
                      processorHeldToolCallIds: () => new Set(),
                      onDetach: () => {},
                      onStop: stop,
                      onStopChild: stopChild,
                    },
                  })
                },
              })
            },
          })
        },
      }),
    { width: 36, height: 5 },
  )

  try {
    await result.renderOnce()
    const frame = result.captureCharFrame()
    const stopRow = frame.split("\n").findIndex((line) => line.includes("stop"))
    const stopColumn = frame.split("\n")[stopRow]?.indexOf("stop") ?? -1
    await result.mockMouse.click(stopColumn + 1, stopRow)
    expect(stop).toHaveBeenCalledWith(block.toolUseId)
    expect(stopChild).not.toHaveBeenCalled()
  } finally {
    result.renderer.destroy()
  }
})

it("dispatches a child's Stop as background.terminate on the parent session and the card's tool call", async () => {
  const { createSessionProcessControls } = await import("../../../../src/tui/hooks/create-session-process-controls.js")
  const dispatched: unknown[] = []
  const controls = createSessionProcessControls({
    appService: { dispatch: runtimeDispatch({ "background.terminate": async (mutation) => { dispatched.push(mutation); return { ok: true } } }) },
    signals: { statusView: () => undefined },
    showToast: () => {},
  })("parent-session")
  controls.onStopChild?.("subagent-call")
  await Promise.resolve()
  expect(dispatched).toEqual([{ type: "background.terminate", sessionId: "parent-session", toolUseId: "subagent-call" }])
})

it("labels a subagent a person stopped Stopped, and one the agent canceled Canceled", async () => {
  const [{ testRender }, { createComponent }, { BlockRenderer }, { ThemeProvider }, { TickPoolProvider }, { RowWidthProvider }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("../../../../src/tui/output-blocks/block-renderer.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
    import("../../../../src/tui/context/row-width.js"),
  ])
  for (const [status, label] of [["stopped", "Stopped"], ["cancelled", "Canceled"]] as const) {
    const block: AgentGroupBlockType = {
      kind: "agentGroup", containerKind: "subagent", id: `card-${status}`, toolUseId: `call-${status}`,
      totalToolCount: 0, label: "Explorer", description: "Trace", status, children: [], timestamp: Date.now(),
    }
    const result = await testRender(
      () =>
        createComponent(TickPoolProvider, {
          get children() {
            return createComponent(ThemeProvider, {
              mode: "dark",
              get children() {
                return createComponent(RowWidthProvider, {
                  value: { width: () => 48, report: () => {} },
                  get children() { return createComponent(BlockRenderer, { block: terminalTranscript([block], false).timelineBlocks[0]! }) },
                })
              },
            })
          },
        }),
      { width: 48, height: 4 },
    )
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain(label)
    } finally {
      result.renderer.destroy()
    }
  }
})

// A workflow outlives the turn that launched it, so a chat opened again reads
// its card from settled history while the run can still be stopped. The held
// row, not the transcript's history, decides its Stop.
it("keeps the Stop of a workflow card that the chat reads from its history", async () => {
  const [{ testRender }, { createComponent }, { WorkflowActivityBlock }, { ThemeProvider }, { TickPoolProvider }, { RowWidthProvider }, { WorkflowCardsProvider }, { noWorkflowCards }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("../../../../src/tui/modules/workflows/activity-block.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
    import("../../../../src/tui/context/row-width.js"),
    import("../../../../src/tui/modules/workflows/cards.js"),
    import("../components/_child-session-viewer-fixtures.js"),
  ])
  const block: AgentGroupBlockType = {
    kind: "agentGroup", containerKind: "workflow", id: "workflow-card", toolUseId: "workflow-call", totalToolCount: 0,
    label: "Fanout Ui", description: "Fanout UI", status: "paused", pausedBy: "person", children: [],
    linkUri: "flywheel://workflow/workflow-session", timestamp: Date.now(),
  }
  const row = workflowDetail({ workflowId: "workflow-session", admittedActions: ["workflow.resume", "workflow.stop", "workflow.delete"] })
  const stopChild = mock((_toolUseId: string) => {})
  const result = await testRender(
    () =>
      createComponent(TickPoolProvider, {
        get children() {
          return createComponent(ThemeProvider, {
            mode: "dark",
            get children() {
              return createComponent(RowWidthProvider, {
                value: { width: () => 100, report: () => {} },
                get children() {
                  return createComponent(WorkflowCardsProvider, {
                    value: { ...noWorkflowCards, row: () => row },
                    get children() {
                      return createComponent(WorkflowActivityBlock, {
                        block,
                        processControls: { activeHeldToolCallIds: () => new Set(), processorHeldToolCallIds: () => new Set(), activeManagedProcessToolCallIds: () => new Set(), onDetach: () => {}, onStop: () => {}, onStopChild: stopChild },
                      })
                    },
                  })
                },
              })
            },
          })
        },
      }),
    { width: 100, height: 8 },
  )
  try {
    await result.renderOnce()
    const frame = result.captureCharFrame()
    expect(frame).toMatch(/resume\s+stop/)
    const stopRow = frame.split("\n").findIndex((line) => line.includes("stop"))
    await result.mockMouse.click((frame.split("\n")[stopRow]?.lastIndexOf("stop") ?? 0) + 1, stopRow)
    expect(stopChild).toHaveBeenCalledWith("workflow-call")
  } finally {
    result.renderer.destroy()
  }
})
