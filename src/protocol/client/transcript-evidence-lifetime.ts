import type { FrontendOutputBlock } from "../app-service-types.js"
import { blockIdentity } from "../block-identity.js"
import type { MutationEvidenceReader } from "./mutation-evidence.js"
import { bodyId } from "./transcript-store-paging.js"
import type { BlockReplacement, TranscriptView } from "./transcript-store.js"

function ownerRoots(view: TranscriptView, blocks: readonly FrontendOutputBlock[]): Map<string, string | undefined> {
  const roots = new Map<string, string | undefined>()
  const add = (block: FrontendOutputBlock): void => {
    const root = block.kind === "tool" || block.kind === "system" ? block.mutationEvidence?.manifest.root : undefined
    roots.set(bodyId(block), root)
    roots.set(blockIdentity(block), root)
  }
  for (const block of blocks) {
    add(block)
    if (block.kind === "agentGroup") {
      for (const child of view.groups[block.id]?.children ?? block.children) add(child)
    }
  }
  return roots
}

/** Release evidence whose resident transcript owner was removed or changed its manifest.
 * Slot rewrites visit only affected owners; whole-window changes also retire absent owners. */
export function retainTranscriptEvidence(reader: MutationEvidenceReader, previous: TranscriptView, next: TranscriptView, rewrites?: readonly BlockReplacement[]): void {
  if (!reader.hasOwners) return
  const priorBlocks = rewrites ? rewrites.flatMap(({ prior }) => prior ? [prior] : []) : previous.blocks
  const nextBlocks = rewrites ? rewrites.flatMap(({ localIndex }) => next.blocks[localIndex] ?? []) : next.blocks
  const roots = ownerRoots(next, nextBlocks)
  for (const [owner, root] of ownerRoots(previous, priorBlocks)) {
    if (roots.get(owner) !== root) reader.release(owner)
  }
  if (!rewrites) reader.retainOwners(new Set(roots.keys()))
}
