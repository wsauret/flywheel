/** @jsxImportSource @opentui/solid */

import type { TextBlock as TextBlockType } from "@infra/output-blocks"
import { useLandingBackground } from "@tui/context/transcript/landing-highlight.js"
import { blockEntryKeys, blockIdentity } from "../../../protocol/block-identity.js"
import { BlockFrame } from "../block-frame.js"
import { MarkdownBody } from "../markdown/markdown-body.js"

interface TextBlockProps {
  block: TextBlockType
  /** True once this block can no longer receive streaming appends: settled
   *  content takes the cached full lex (cheap scroll remounts); the volatile
   *  tail block takes the incremental streaming path. A wrong `false` only
   *  costs the cache, never correctness. */
  settled?: boolean
}

function assistantDisplayContent(content: string): string {
  return content.replace(/\n+$/, "")
}

export function TextBlock(props: TextBlockProps) {
  // A landing names the chat entry, which every text part of the reply holds.
  const landingBackground = useLandingBackground(() => blockEntryKeys(blockIdentity(props.block)))
  return (
    <BlockFrame background={landingBackground()}>
      <MarkdownBody unwrapFences cache={props.settled === true}>{assistantDisplayContent(props.block.content)}</MarkdownBody>
    </BlockFrame>
  )
}
