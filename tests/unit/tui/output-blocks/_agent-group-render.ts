import type { CapturedFrame } from "@opentui/core"
import type { AgentGroupBlock as AgentGroupBlockType } from "../../../../src/infra/output-blocks.js"
import type { ChildCardStatus } from "../../../../src/protocol/client/session-controls.js"
import type { RoleAssignmentView } from "../../../../src/protocol/role-protocol-types.js"
import type { WorkflowCards } from "../../../../src/tui/modules/workflows/cards.js"
import type { RowProcessControls } from "../../../../src/tui/output-blocks/stop-affordance.js"
import { noWorkflowCards } from "../components/_child-session-viewer-fixtures.js"

interface RenderToolGroupOptions {
  width?: number
  click?: { x: number; y: number }
  navigateUri?: (uri: string) => void
  /** Opens an agent's view over the chat, as the shell's workflow cards do. */
  openAgent?: WorkflowCards["openAgent"]
  /** The shell's workflow cards beyond `openAgent`, such as the held row. */
  cards?: Partial<WorkflowCards>
  processControls?: RowProcessControls
  roleView?: () => RoleAssignmentView | undefined
  childStatus?: () => ChildCardStatus
  updateAfterFirstRender?: (frame: string) => void
  block?: () => AgentGroupBlockType
  inspectSpans?: (frame: CapturedFrame) => void
}

/** Renders an agent or workflow group block inside the shell's providers,
 *  optionally clicks one cell, and returns the frame. */
export async function renderToolGroup(block: AgentGroupBlockType, options: RenderToolGroupOptions = {}): Promise<string> {
  const [{ testRender }, { createComponent }, { AgentGroupBlock }, { ThemeProvider }, { TickPoolProvider }, { RowWidthProvider }, { NavigationProvider }, { WorkflowCardsProvider }, { WorkflowActivityBlock }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("../../../../src/tui/output-blocks/agent-group-block.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
    import("../../../../src/tui/context/row-width.js"),
    import("../../../../src/tui/context/navigation.js"),
    import("../../../../src/tui/modules/workflows/cards.js"),
    import("../../../../src/tui/modules/workflows/activity-block.js"),
  ])
  const width = options.width ?? 100

  const result = await testRender(
    () =>
      createComponent(TickPoolProvider, {
        get children() {
          return createComponent(ThemeProvider, {
            mode: "dark",
            get children() {
              return createComponent(RowWidthProvider, {
                value: { width: () => width, report: () => {} },
                get children() {
                  return createComponent(NavigationProvider, {
                    value: options.navigateUri,
                    get children() {
                      const group = () => createComponent(block.containerKind === "workflow" ? WorkflowActivityBlock : AgentGroupBlock, {
                        get block() { return options.block?.() ?? block },
                        roleView: options.roleView === undefined ? undefined : () => options.roleView?.(),
                        ...(options.childStatus === undefined ? {} : { childStatus: options.childStatus }),
                        ...(options.processControls === undefined ? {} : { processControls: options.processControls }),
                      })
                      const openAgent = options.openAgent
                      if (openAgent === undefined && options.cards === undefined) return group()
                      return createComponent(WorkflowCardsProvider, { value: { ...noWorkflowCards, ...options.cards, ...(openAgent === undefined ? {} : { openAgent }) }, get children() { return group() } })
                    },
                  })
                },
              })
            },
          })
        },
      }),
    { width, height: 30 },
  )

  try {
    await result.renderOnce()
    if (options.updateAfterFirstRender) {
      options.updateAfterFirstRender(result.captureCharFrame())
      await result.renderOnce()
    }
    // A press can schedule a frame that is still presenting when the click
    // returns, and a capture during a present fails with `OutputBusy`. One
    // more frame waits for it and draws what the click left.
    if (options.click) {
      await result.mockMouse.click(options.click.x, options.click.y)
      await result.renderOnce()
    }
    options.inspectSpans?.(result.captureSpans())
    return result.captureCharFrame()
  } finally {
    result.renderer.destroy()
  }
}
