import { TOOL_PREVIEW_LINE_LIMIT } from "../../infra/output-blocks.js"
import { getToolDisplay } from "../../infra/tools/tool-display-registry.js"
import { toolRunCategoryFor } from "../../protocol/client/tool-run-category.js"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../protocol/app-service-types.js"

export interface OutputHeightEstimate {
  readonly blockIndex: number
  readonly rows: number
}

// Estimates should track rendered rows closely: every row of error surfaces as
// a scroll-compensation jump when the block mounts and measures. Unknowable
// terms (wrap width) stay biased low - underestimates only mount a little
// extra content - but line breaks are counted at face value because each one
// is a real rendered row.
export const DEFAULT_ESTIMATE = 3

const TEXT_BYTES_PER_ROW = 800
const THINKING_ESTIMATE = 4
const TOOL_ESTIMATE = 3
const METADATA_ESTIMATE = 3
// Header row plus the CollapsibleBox's vertical padding around an open tool body.
const TOOL_BODY_CHROME_ROWS = 3

const estimatedRowsByBlock = new WeakMap<FrontendOutputBlock, { readonly text: string; readonly lineBreaks: number; readonly rows: number }>()

export function estimateFrontendOutputBlockRows(block: FrontendOutputBlock, toolContentVisible: boolean): number {
  switch (block.kind) {
    case "text":
      return estimateContentRows(block, block.content).rows
    case "userMessage":
      return block.pending ? 0 : estimateContentRows(block, block.content).rows
    case "thinking":
      return THINKING_ESTIMATE
    case "tool":
      return estimateToolEntryRows(block, toolContentVisible)
    case "system":
    case "degraded":
      return METADATA_ESTIMATE
    case "divider":
    case "agentGroup":
      return METADATA_ESTIMATE
    case "question":
      // Answered questions render one detail line per question; each line is
      // a real rendered row before any width-based wrapping.
      return Math.max(METADATA_ESTIMATE, block.questions.length)
  }
}

export function estimateAppendedBlockRows(prior: FrontendOutputBlock, next: FrontendOutputBlock, appendedText: string, toolContentVisible: boolean): number {
  if (prior.kind !== "text" || next.kind !== "text" || next.content !== prior.content + appendedText) return estimateFrontendOutputBlockRows(next, toolContentVisible)
  const priorEstimate = estimateContentRows(prior, prior.content)
  let lineBreaks = priorEstimate.lineBreaks
  for (let i = 0; i < appendedText.length; i += 1) if (appendedText.charCodeAt(i) === 10) lineBreaks += 1
  const rows = textRows(next.content.length, lineBreaks)
  estimatedRowsByBlock.set(next, { text: next.content, lineBreaks, rows })
  return rows
}

export function heightEstimatesFromBlocks(blocks: readonly FrontendOutputBlock[], startBlockIndex: number, toolContentVisible: boolean): OutputHeightEstimate[] {
  return blocks.map((block, offset) => ({
    blockIndex: startBlockIndex + offset,
    rows: estimateFrontendOutputBlockRows(block, toolContentVisible),
  }))
}

function estimateContentRows(block: FrontendOutputBlock, text: string) {
  const cached = estimatedRowsByBlock.get(block)
  if (cached && cached.text === text) return cached
  let lineBreaks = 0
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lineBreaks += 1
  const rows = textRows(text.length, lineBreaks)
  const estimate = { text, lineBreaks, rows }
  estimatedRowsByBlock.set(block, estimate)
  return estimate
}

function textRows(byteLikeLength: number, lineBreaks: number): number {
  return Math.max(DEFAULT_ESTIMATE, Math.ceil(byteLikeLength / TEXT_BYTES_PER_ROW), lineBreaks + 1)
}

// Mirrors the visible projection and ToolEntry's collapsed rendering. Tools in
// a run category (exec/explore) fold into a "Tools" group as one-line children
// whose bodies mount only on user expand, so their content never counts.
// Standalone entries keep a mounted body for normal file diff and content
// previews. Mutation artifacts and handoffs mount only on user expansion.
function estimateToolEntryRows(block: FrontendToolEntry, toolContentVisible: boolean): number {
  // Invocation bodies (code scripts) render inline: the first source line
  // shares the header row, so the body contributes its line count, not +1.
  const invocationRows = block.invocationBody ? countLines(block.invocationBody.content) : 0
  if (block.status === "error") return Math.max(TOOL_ESTIMATE, invocationRows)
  if (toolRunCategoryFor(block) !== null) return Math.max(TOOL_ESTIMATE, invocationRows)
  if (block.mutationEvidence !== undefined) return TOOL_ESTIMATE
  const action = getToolDisplay(block.name).action
  const diffLines = block.diff ? previewLines(block.diff) : 0
  const showsContent = action === "file_write" || (toolContentVisible && action !== "handoff_write")
  const contentLines = showsContent && block.content ? previewLines(block.content) : 0
  const bodyLines = diffLines + contentLines
  return Math.max(invocationRows, 1, bodyLines === 0 ? TOOL_ESTIMATE : bodyLines + TOOL_BODY_CHROME_ROWS)
}


function previewLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let i = 0; i < text.length && lines < TOOL_PREVIEW_LINE_LIMIT; i += 1) if (text.charCodeAt(i) === 10) lines += 1
  return lines
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1
  return lines
}
