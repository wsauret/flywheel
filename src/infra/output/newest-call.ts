import { truncateUtf8Prefix } from "./truncate-output.js"
import type { AnyBlock, ToolPresentation } from "../output-blocks.js"
import type { MutationEvidence } from "../mutation-evidence.js"
import { formatFileSamples, mutationEvidenceItems } from "../not-applied-files.js"
import { fileSubject } from "../tools/detail-helpers.js"

/** A line draws at most 100 columns. Bound long shell commands before they
 *  travel with every activity update. */
const ACTIVITY_DETAIL_BYTES = 256

/** The newest tool or subagent call, with settled mutations named by their files.
 *  A tool whose input still streams has only a partial sentence, so the call
 *  before it stays shown until that input completes. */
export function newestCall(blocks: readonly AnyBlock[]): ToolPresentation | undefined {
  const call = blocks.findLast((block): block is Extract<AnyBlock, { kind: "tool" | "agentGroup" | "question" }> =>
    block.kind === "tool" ? block.status !== "streaming" : block.kind === "agentGroup" || block.kind === "question")
  if (call === undefined) return undefined
  const changed = call.kind === "tool" && call.declaresMutation === true && call.mutationEvidence !== undefined ? changedFiles(call.mutationEvidence) : undefined
  const sentence = changed ?? call.sentence
  if (sentence === undefined) return undefined
  const { name, detail } = sentence
  return { name, detail: truncateUtf8Prefix(detail, ACTIVITY_DETAIL_BYTES) }
}

/** A command that changed no files keeps its own sentence. */
function changedFiles(evidence: MutationEvidence): ToolPresentation | undefined {
  if (evidence.applied + evidence.notApplied + (evidence.unknownChanges ?? 0) === 0) return undefined
  const only = (count: number) => count === evidence.added + evidence.modified + evidence.removed && count > 0
  const name = only(evidence.added) ? "Wrote" : only(evidence.removed) ? "Removed" : "Edited"
  return { name, detail: formatFileSamples(mutationEvidenceItems(evidence, fileSubject)) }
}
