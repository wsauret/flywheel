import type { AnyBlock, ToolEntry } from "../../infra/output-blocks.js"
import type { FrontendOutputBlock } from "../../protocol/app-service-types.js"
import { fileChangeDetail, isShellMutationEntry } from "../../protocol/client/file-change-body.js"
import { newestCall } from "../../infra/output/newest-call.js"

/** The largest live tool body a row carries inline. A larger body leaves the
 *  row with only its line count, and a client reads it through the
 *  `outputBlockBody` query, as it reads an omitted historical body. */
const LIVE_TOOL_BODY_BYTES = 2048

export function projectFrontendOutputBlocks(blocks: readonly AnyBlock[]): FrontendOutputBlock[] {
  return blocks.map(projectFrontendOutputBlock)
}

export function projectFrontendOutputBlock(block: AnyBlock): FrontendOutputBlock {
  if (block.kind === "tool") return frontendToolEntry(block)
  if (block.kind === "userMessage" && block.images !== undefined) {
    const { images, ...row } = block
    return { ...row, ...(images.length ? { imageCount: images.length } : {}) }
  }
  if (block.kind === "agentGroup") {
    // A workflow card draws its plan, never the tool calls inside it.
    if (block.containerKind === "workflow") return { ...block, children: [] }
    const activity = newestCall(block.children) ?? block.activity
    return { ...block, children: [], ...(activity === undefined ? {} : { activity }) }
  }
  return block
}

/** A tool row as a client holds it. Line counts do not bound shell output:
 *  one unterminated line can fill a patch. Keep small live bodies inline;
 *  disclose larger ones through the same outputBlockBody query used by
 *  historical rows. The session a row names reaches a client only as the name
 *  the transcript projection gave it. */
function frontendToolEntry(tool: ToolEntry): ToolEntry {
  const row = tool.targetSessionId === undefined ? tool : withoutTarget(tool)
  if (row.content === undefined || Buffer.byteLength(row.content, "utf8") <= LIVE_TOOL_BODY_BYTES) return row
  const { content, ...bodiless } = row
  return { ...bodiless, contentOmittedLines: content.split("\n").length }
}

function withoutTarget(tool: ToolEntry): ToolEntry {
  const { targetSessionId: _targetSessionId, ...row } = tool
  return row
}

/** A subagent's operation as its parent's card shows it: what ran, never its
 *  output. Both clients render group children as compact rows, and the
 *  subagent's own session keeps every body, so the bodies here would only be
 *  re-sent on every change to the card. A row whose name came from its
 *  mutation's files keeps that name, stated once, and its bounded evidence
 *  metadata lets each client select Write or Edit. */
export function compactGroupChild(child: ToolEntry): ToolEntry {
  // Most operations carry no body and keep their own name; those stay the
  // same object. A shell mutation is renamed even before it has a body. The
  // session a row names reaches a client only as the name it shows.
  if (!hasBody(child) && !isShellMutationEntry(child) && child.targetSessionId === undefined) return child
  const {
    invocationBody: _invocationBody, diff: _diff, content: _content, filetype: _filetype, proposedDiff: _proposedDiff,
    diffOmission: _diffOmission, invocationBodyOmittedBytes: _invocationBodyOmittedBytes, contentOmittedLines: _contentOmittedLines,
    targetSessionId: _targetSessionId, ...row
  } = child
  // Only landed files are baked: they never change once stated. Each client
  // names the row from them, or from the call's activity, through rowPresentation.
  const detail = child.mutationEvidence !== undefined && (child.presentation.detail === "" || isShellMutationEntry(child))
    ? fileChangeDetail({ kind: "actual", mutationEvidence: child.mutationEvidence }) : undefined
  return {
    ...row,
    presentation: detail === undefined ? child.presentation : { ...child.presentation, detail },
  }
}

function hasBody(child: ToolEntry): boolean {
  return child.invocationBody !== undefined || child.diff !== undefined || child.content !== undefined || child.filetype !== undefined
    || child.proposedDiff !== undefined || child.mutationEvidence !== undefined || child.diffOmission !== undefined
    || child.invocationBodyOmittedBytes !== undefined || child.contentOmittedLines !== undefined
}
