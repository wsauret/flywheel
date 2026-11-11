import type { AnyBlock, TextBlock, ThinkingBlock } from "../output-blocks.js";
import { contentKey } from "./structured-output-helpers.js";

export interface KeyedDeltaResult {
  readonly index: number;
  /** True when this call minted a new block; false when it appended to one
   *  already tracked under `blockKey`. Callers use this to decide whether to
   *  record a wire `upsert` (new block) or `append-content` (suffix) change. */
  readonly created: boolean;
}

/** Streams keyed content deltas (thinking/text) into the block list: the first
 *  delta for a row mints a block via `makeNewBlock`, later deltas append to
 *  the block of that kind already tracked under `blockKey`. */
export function appendKeyedDelta<Kind extends "thinking" | "text">(
  blocks: AnyBlock[],
  indexByKey: Map<string, number>,
  kind: Kind,
  blockKey: string,
  text: string,
  makeNewBlock: (blockKey: string, text: string) => Extract<ThinkingBlock | TextBlock, { kind: Kind }>,
  insertBlock: (block: ThinkingBlock | TextBlock) => number,
): KeyedDeltaResult | null {
  if (text === "") return null;

  const key = contentKey(kind, blockKey);
  const existingIndex = indexByKey.get(key);
  if (existingIndex !== undefined) {
    const existing = blocks[existingIndex];
    // indexByKey only ever holds indices of blocks of the kind its key names,
    // so anything else is a corrupted index.
    if (existing?.kind !== kind) {
      throw new Error(`appendKeyedDelta index for ${key} does not point at a ${kind} block`);
    }
    blocks[existingIndex] = { ...existing, content: existing.content + text };
    return { index: existingIndex, created: false };
  }

  const index = insertBlock(makeNewBlock(blockKey, text));
  indexByKey.set(key, index);
  return { index, created: true };
}
