/**
 * Resume Utilities
 *
 * Helper functions for the resume workflow. Extracted from the shell
 * for testability — no JSX, no OpenTUI, no SolidJS dependencies.
 *
 * The key function is `injectOutputBlocks`, which pushes restored
 * output blocks into the store in chunks to avoid blocking the render
 * loop with potentially thousands of blocks.
 *
 * Performance: uses `appendOutputBlocks` for async batches so each
 * batch only copies the delta slice, not the full accumulated array.
 *
 * Cancellation: returns a handle with `cancel()` that stops further
 * batches. Callers must cancel a previous injection before starting
 * a new one.
 */

import type { AnyBlock } from "../types";

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
export interface BlockStore {
  setOutputBlocks(blocks: AnyBlock[]): void;
  appendOutputBlocks(blocks: AnyBlock[]): void;
}

/** Handle returned by injectOutputBlocks for cancellation. */
export interface InjectionHandle {
  cancel(): void;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject output blocks into a store in chunks.
 *
 * Prevents UI freeze when restoring thousands of blocks from a paused session.
 * The first 100 blocks are injected synchronously via `setOutputBlocks` (so
 * the user sees content immediately and any existing blocks are replaced).
 * Remaining blocks are appended in batches of 200 via `setTimeout(0)` using
 * `appendOutputBlocks` (delta-only — O(batch) per tick, not O(n)).
 *
 * Returns an `InjectionHandle` whose `cancel()` method stops further batches.
 *
 * @param store - The UIActions store (or any object with setOutputBlocks + appendOutputBlocks)
 * @param blocks - The full array of blocks to inject
 * @returns Handle with cancel() to stop further injection batches
 */
export function injectOutputBlocks(store: BlockStore, blocks: AnyBlock[]): InjectionHandle {
  let cancelled = false;

  const handle: InjectionHandle = {
    cancel() {
      cancelled = true;
    },
  };

  if (blocks.length === 0) return handle;

  // First batch: inject up to INITIAL_BATCH_SIZE synchronously (full replace)
  const firstEnd = Math.min(INITIAL_BATCH_SIZE, blocks.length);
  store.setOutputBlocks(blocks.slice(0, firstEnd));

  // If all blocks fit in the first batch, we're done
  if (blocks.length <= INITIAL_BATCH_SIZE) return handle;

  // Remaining blocks: inject in ASYNC_BATCH_SIZE chunks via setTimeout(0)
  let offset = firstEnd;

  const injectNextBatch = () => {
    // Check cancellation at the START of each batch callback
    if (cancelled) return;

    const nextEnd = Math.min(offset + ASYNC_BATCH_SIZE, blocks.length);
    const delta = blocks.slice(offset, nextEnd);
    store.appendOutputBlocks(delta);
    offset = nextEnd;

    if (offset < blocks.length) {
      setTimeout(injectNextBatch, 0);
    }
  };

  setTimeout(injectNextBatch, 0);

  return handle;
}
