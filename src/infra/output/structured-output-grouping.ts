import type { AnyBlock, TextBlock, ThinkingBlock } from "../output-blocks.js";

export interface KeyedDeltaResult {
  readonly index: number;
  /** True when this call minted a new block; false when it appended to one
   *  already tracked under `blockKey`. Callers use this to decide whether to
   *  record a wire `upsert` (new block) or `append-content` (suffix) change. */
  readonly created: boolean;
}

/** Streams keyed content deltas (thinking/text) into the block list: the first
 *  delta for a key mints a block via `makeNewBlock`, later deltas append to
 *  the block already tracked under that key. */
export function appendKeyedDelta(
  blocks: AnyBlock[],
  indexByKey: Map<string, number>,
  blockKey: string,
  text: string,
  makeNewBlock: (blockKey: string, text: string) => ThinkingBlock | TextBlock,
  insertBlock: (block: ThinkingBlock | TextBlock) => number,
): KeyedDeltaResult | null {
  if (text === "") return null;

  const existingIndex = indexByKey.get(blockKey);
  if (existingIndex !== undefined) {
    const existing = blocks[existingIndex];
    // indexByKey only ever holds indices of blocks this function inserted via
    // makeNewBlock, so anything else is a corrupted index.
    if (existing?.kind !== "thinking" && existing?.kind !== "text") {
      throw new Error(`appendKeyedDelta index for ${blockKey} does not point at a thinking/text block`);
    }
    blocks[existingIndex] = { ...existing, content: existing.content + text };
    return { index: existingIndex, created: false };
  }

  const index = insertBlock(makeNewBlock(blockKey, text));
  indexByKey.set(blockKey, index);
  return { index, created: true };
}
