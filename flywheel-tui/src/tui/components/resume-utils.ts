/**
 * Resume Utilities
 *
 * Helper functions for the resume workflow. Extracted from the shell
 * for testability — no JSX, no OpenTUI, no SolidJS dependencies.
 *
 * The key function is `injectOutputBlocks`, which pushes restored
 * output blocks into the store in chunks to avoid blocking the render
 * loop with potentially thousands of blocks.
 */

import type { AnyBlock } from "../routes/work/state/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of blocks injected synchronously in the first batch. */
const INITIAL_BATCH_SIZE = 100;

/** Number of blocks per subsequent async batch. */
const ASYNC_BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal store interface needed for block injection. */
interface BlockStore {
  setOutputBlocks(blocks: AnyBlock[]): void;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject output blocks into a store in chunks.
 *
 * Prevents UI freeze when restoring thousands of blocks from a paused session.
 * The first 100 blocks are injected synchronously (so the user sees content
 * immediately). Remaining blocks are appended in batches of 200 via
 * `setTimeout(0)`, allowing the renderer to paint between batches.
 *
 * @param store - The UIActions store (or any object with setOutputBlocks)
 * @param blocks - The full array of blocks to inject
 */
export function injectOutputBlocks(store: BlockStore, blocks: AnyBlock[]): void {
  if (blocks.length === 0) return;

  // First batch: inject up to INITIAL_BATCH_SIZE synchronously
  const firstBatch = blocks.slice(0, INITIAL_BATCH_SIZE);
  store.setOutputBlocks(firstBatch);

  // If all blocks fit in the first batch, we're done
  if (blocks.length <= INITIAL_BATCH_SIZE) return;

  // Remaining blocks: inject in ASYNC_BATCH_SIZE chunks via setTimeout(0)
  let offset = INITIAL_BATCH_SIZE;

  const injectNextBatch = () => {
    const nextEnd = Math.min(offset + ASYNC_BATCH_SIZE, blocks.length);
    const accumulated = blocks.slice(0, nextEnd);
    store.setOutputBlocks(accumulated);
    offset = nextEnd;

    if (offset < blocks.length) {
      setTimeout(injectNextBatch, 0);
    }
  };

  setTimeout(injectNextBatch, 0);
}
