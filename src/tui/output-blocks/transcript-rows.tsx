/** @jsxImportSource @opentui/solid */

import { Key } from "@solid-primitives/keyed"
import { createMemo, Show, type Accessor, type JSX } from "solid-js"
import type { FrontendOutputBlock } from "../../protocol/app-service-types.js"
import { BlockRenderer, type BlockRendererProps } from "./block-renderer.js"
import { Divider } from "./system-block.js"
import { terminalTranscript, visibleBlockIdentity, type PresentedTerminalRow } from "./visible-output-blocks.js"

type FullRowsProps = Omit<BlockRendererProps, "block"> & {
  /** A resident viewport can measure each keyed row without owning presentation. */
  frameRow?: (block: Accessor<PresentedTerminalRow>, children: JSX.Element) => JSX.Element
}
/** Render raw transcript blocks through the terminal's fold and presentation. */
export function TranscriptRows(props: FullRowsProps & {
  blocks: readonly FrontendOutputBlock[]
  showThinking?: boolean
}) {
  const transcript = createMemo(() => terminalTranscript(props.blocks, props.showThinking))
  return <>
      <Key each={transcript().timelineBlocks} by={visibleBlockIdentity}>{(block, index) => {
        const row = <>
        <Show when={transcript().hasBoundaryBefore[index()]}><Divider /></Show>
        <BlockRenderer {...props} block={block()} />
        </>
        return props.frameRow?.(block, row) ?? row
      }}</Key>
      <Key each={transcript().pendingBlocks} by={visibleBlockIdentity}>
        {block => {
          const row = <BlockRenderer {...props} block={block()} />
          return props.frameRow?.(block, row) ?? row
        }}
      </Key>
  </>
}
