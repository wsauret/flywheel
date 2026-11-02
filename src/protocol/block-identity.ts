import type { AnyBlock } from "../infra/output-blocks.js"

/** The shape `blockIdentity` reads: any block kind with its natural or minted
 *  id. Both the runtime's `AnyBlock` and the projected `FrontendOutputBlock`
 *  satisfy it, so code that only needs identity (paging, keyed rendering, a
 *  test double) can be written once over either. */
export type IdentifiedBlock =
  | { readonly kind: "question"; readonly toolUseId: string }
  | { readonly kind: Exclude<AnyBlock["kind"], "question">; readonly id: string }

/** The single stable, position-independent identity for an output block - the key
 *  the unified transcript list, the render `<Index>`, the expansion set, the durable
 *  content/chunk address, and the page cursor all share. Every block carries a
 *  natural or builder-minted id, so identity never falls back to array position
 *  (which a prepend or generation bump would invalidate). Both the orchestration
 *  `AnyBlock` and the projected `FrontendOutputBlock` satisfy this shape, so the
 *  runtime and every client compute the SAME id for the same block - which is why
 *  this rule lives in the protocol package rather than either side.
 *
 *  Questions and agent groups are refined forms of tool calls, not second blocks:
 *  the provisional tool row and the block that replaces it are one tool use, so
 *  they share the `tool:` identity. That is what lets the runtime publish the
 *  swap as an in-place upsert and lets every client keep the row mounted
 *  (disclosure, measured height, page cursor) across it. */
export function blockIdentity(block: IdentifiedBlock): string {
  if (block.kind === "question") return `tool:${block.toolUseId}`
  return `${block.kind === "agentGroup" ? "tool" : block.kind}:${block.id}`
}

/** The provider tool use a tool or agentGroup block id names, without the
 *  suffix that keeps the id unique in a transcript: a duplicate occurrence
 *  (`T#2`) or an operation that a subagent card lists (`T#<card>`). Durable
 *  facts join on it, and a client matches a card's row to its child's running
 *  process by it. Provider ids never contain `#`, so a block identity
 *  (`tool:T#<card>`) cuts to the identity of its tool use (`tool:T`). */
export function rawToolUseId(blockId: string): string {
  const cut = blockId.indexOf("#")
  return cut === -1 ? blockId : blockId.slice(0, cut)
}

/** The chat entries (or tool uses) an identity can descend from: the block id
 *  and each of its prefixes that ends before a `:` or a `#`. `text:E:2` and
 *  `userMessage:E` both belong to entry `E`, and `tool:T#2` to tool use `T`.
 *  An entry id can hold colons of its own, as the delivery key
 *  `msg:<sender>:<call>` of a message from another session does, so the
 *  entry is not read from the id: every prefix is a candidate, and a search
 *  hit, which names the entry exactly, matches one of them. */
export function blockEntryKeys(identity: string): readonly string[] {
  const id = identity.slice(identity.indexOf(":") + 1)
  const keys: string[] = []
  for (let index = 1; index < id.length; index += 1) {
    if (id[index] === ":" || id[index] === "#") keys.push(id.slice(0, index))
  }
  keys.push(id)
  return keys
}
