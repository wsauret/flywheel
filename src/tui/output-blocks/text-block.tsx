/** @jsxImportSource @opentui/solid */

import type { TextBlock as TextBlockType } from "@infra/output-blocks"
import { useLandingBackground } from "@tui/context/landing-highlight.js"
import { blockEntryKeys, blockIdentity } from "../../protocol/block-identity.js"
import { BlockFrame } from "./block-frame.js"
import { MarkdownBody } from "./markdown/markdown-body.js"

interface TextBlockProps {
  block: TextBlockType
  /** True once this block can no longer receive streaming appends: settled
   *  content takes the cached full lex (cheap scroll remounts); the volatile
   *  tail block takes the incremental streaming path. A wrong `false` only
   *  costs the cache, never correctness. */
  settled?: boolean
}

export function assistantDisplayContent(content: string): string {
  return content.replace(/\n+$/, "")
}

export function TextBlock(props: TextBlockProps) {
  // A landing on the message's entry marks it for a while, as a landing on a card does.
  const landingBackground = useLandingBackground(() => blockEntryKeys(blockIdentity(props.block)))
  return (
    <box backgroundColor={landingBackground()}>
      <BlockFrame>
        <MarkdownBody unwrapFences cache={props.settled === true}>{assistantDisplayContent(props.block.content)}</MarkdownBody>
      </BlockFrame>
    </box>
  )
}