/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"
import type { ToolEntry as ToolEntryType, ToolStreamingText } from "../../../../src/infra/output-blocks.js"
import type { RuntimeConfigView } from "../../../../src/protocol/runtime-config-protocol-types.js"
import type { BlockDisclosureChannel } from "../../../../src/tui/context/block-disclosure.js"
import type { RowProcessControls } from "../../../../src/tui/output-blocks/stop-affordance.js"
import type { ToolRun } from "../../../../src/tui/output-blocks/visible-output-blocks.js"
import type { MutationEvidenceReader } from "../../../../src/protocol/client/mutation-evidence.js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { processStatus } from "../../../helpers/runtime-views.js"

interface StreamingToolTextById {
  readonly [toolUseId: string]: ToolStreamingText
}

export interface RenderToolEntryOptions {
  interrupted?: boolean
  streamingToolText?: Readonly<StreamingToolTextById>
  height?: number
  width?: number
  managed?: () => ReadonlySet<string>
  held?: () => ReadonlySet<string>
  processorHeld?: () => ReadonlySet<string>
  onStop?: (toolUseId: string) => void
  onDetach?: (toolUseId: string) => void
  onHydrateBody?: (blockId: string) => void
  disclosure?: BlockDisclosureChannel
  config?: () => RuntimeConfigView | undefined
  evidenceReader?: MutationEvidenceReader
  scroll?: boolean
}

/** Render one ToolEntry under the providers the real transcript gives it. The
 *  block may be a signal accessor so a test can repave it mid-render. */
export async function renderToolEntry(block: ToolEntryType | (() => ToolEntryType), opts?: RenderToolEntryOptions) {
  const { ToolEntry } = await import("../../../../src/tui/output-blocks/tool-entry.js")
  return renderInTranscript((createComponent) => createComponent(ToolEntry, {
    get block() { return typeof block === "function" ? block() : block },
    interrupted: opts?.interrupted,
    streamingToolText: opts?.streamingToolText,
    rowControls: rowControls(opts),
    onHydrateBody: opts?.onHydrateBody,
  }), opts)
}

/** Render several ToolEntry rows in one column, each owning its own evidence, so a
 *  test can observe one row's work or height against its neighbours. */
export async function renderToolEntries(blocks: readonly ToolEntryType[], opts?: RenderToolEntryOptions) {
  const { ToolEntry } = await import("../../../../src/tui/output-blocks/tool-entry.js")
  return renderInTranscript(() => <box>
    {blocks.map(block => <ToolEntry block={block} rowControls={rowControls(opts)} />)}
  </box>, opts)
}

/** Render one run of folded tool calls the way the transcript folds them, so
 *  each row takes the presentation the run routes it to. */
export async function renderToolRun(run: ToolRun | (() => ToolRun), opts?: RenderToolEntryOptions) {
  const { ToolRunBlock } = await import("../../../../src/tui/output-blocks/tool-run-block.js")
  return renderInTranscript((createComponent) => createComponent(ToolRunBlock, {
    get block() { return typeof run === "function" ? run() : run },
    streamingToolText: opts?.streamingToolText,
    processControls: rowControls(opts),
    onHydrateBody: opts?.onHydrateBody,
  }), opts)
}

function rowControls(opts: RenderToolEntryOptions | undefined): RowProcessControls {
  return {
    status: () => processStatus({ held: opts?.held?.(), managed: opts?.managed?.(), processorHeld: opts?.processorHeld?.() }),
    onDetach: opts?.onDetach ?? (() => {}),
    onStop: opts?.onStop ?? (() => {}),
  }
}

async function renderInTranscript(content: (create: typeof import("solid-js/web").createComponent) => JSX.Element, opts: RenderToolEntryOptions | undefined) {
  const [{ testRender }, { createComponent }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
  ])
  const [{ ThemeProvider }, { ScrollPreserveProvider }, { TickPoolProvider }, { BlockDisclosureProvider, createBlockDisclosureChannel }, { RowWidthProvider }, { MutationEvidenceProvider }] = await Promise.all([
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/scroll-preserve.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
    import("../../../../src/tui/context/block-disclosure.js"),
    import("../../../../src/tui/context/row-width.js"),
    import("../../../../src/tui/context/mutation-evidence.js"),
  ])

  let viewport: ScrollBoxRenderable | undefined
  const result = await testRender(
    // A fresh disclosure channel per render unless a remount test supplies the
    // transcript-owned channel whose state must survive row virtualization.
    () => createComponent(BlockDisclosureProvider, {
      value: opts?.disclosure ?? createBlockDisclosureChannel(),
      get children() {
        return createComponent(TickPoolProvider, {
          get children() {
            return createComponent(ScrollPreserveProvider, {
              value: (fn: () => void) => fn(),
              get children() {
                return createComponent(ThemeProvider, {
                  mode: "dark",
                  config: opts?.config,
                  get children() {
                    return createComponent(RowWidthProvider, {
                      value: { width: () => opts?.width ?? 80, report: () => {} },
                      get children() {
                        return createComponent(MutationEvidenceProvider, {
                          reader: () => opts?.evidenceReader,
                          get children() {
                            if (!opts?.scroll) return content(createComponent)
                            return <scrollbox ref={(node) => { viewport = node }} height={opts.height ?? 32} width={opts.width ?? 80}>
                              {content(createComponent)}
                            </scrollbox>
                          },
                        })
                      },
                    })
                  },
                })
              },
            })
          },
        })
      },
    }),
    { width: opts?.width ?? 80, height: opts?.height ?? 32 },
  )
  return { ...result, scrollTo: (row: number) => viewport?.scrollTo(row) }
}

/** Resting frame of a 64-row render, as its non-blank lines: the mouse parks
 *  below the entry so the hover rail in the body gutter never enters the
 *  captured frame. */
export async function restingFrameLines(result: Awaited<ReturnType<typeof renderToolEntry>>): Promise<string[]> {
  await result.mockMouse.moveTo(79, 63)
  await result.renderOnce()
  return result.captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

/** An expanded file reads its patch after the click, so its bytes settle before the resting frame. */
export async function settledFrameLines(result: Awaited<ReturnType<typeof renderToolEntry>>, fixture: { settle(): Promise<void> }): Promise<string[]> {
  for (let frame = 0; frame < 3; frame++) { await result.renderOnce(); await fixture.settle() }
  return restingFrameLines(result)
}
