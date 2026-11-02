import type { AnyBlock, ToolStreamingText } from "../output-blocks.js";

/** One semantic change to the live block array, minted at the exact write
 *  site that made it (StructuredOutputBuilder) instead of reconstructed later
 *  by diffing two full snapshots. `index` is absolute into the builder's own
 *  `blocks` array; the app-service output projection shifts it into wire
 *  coordinates and filters anything still inside the seeded durable prefix.
 *  `insert` creates a block at `index` and shifts every later block up one
 *  slot (a tail insert is a plain append); `upsert` replaces the block already
 *  at `index` and never changes its identity. */
export type OutputBlockChange =
  | { readonly kind: "insert"; readonly index: number; readonly block: AnyBlock }
  | { readonly kind: "upsert"; readonly index: number; readonly block: AnyBlock }
  | {
      readonly kind: "append-content";
      readonly index: number;
      readonly identity: { readonly kind: "text" | "thinking"; readonly id: string };
      readonly contentOffset: number;
      readonly text: string;
    };

/** A JSON value that an edit changes: one tool's live streaming entry, or one
 *  output block. An object key whose value is undefined is absent, as an
 *  optional field is. */
export type EditableValue = string | number | boolean | null | readonly EditableValue[] | { readonly [key: string]: EditableValue | undefined };

/** Where an edit lands inside an editable value: object keys and array
 *  indexes from the value's root. */
export type ValuePath = readonly (string | number)[];

/** The smallest true change to one value inside a streaming entry or a block.
 *  Growing values change at their end, so most edits are an `append` to a
 *  string or a `push` onto an array; a bounded output tail that slides is a
 *  `window` (drop a prefix, append a suffix). `append`, `window`, and `push`
 *  name the base they apply to (`offset`, `length`), so a client holding
 *  another version can tell, and a redelivery is idempotent. `assign` and
 *  `delete` carry no base: they apply to any copy that has the path. */
export type ValueEdit =
  | { readonly kind: "append"; readonly path: ValuePath; readonly offset: number; readonly text: string }
  | { readonly kind: "window"; readonly path: ValuePath; readonly offset: number; readonly drop: number; readonly text: string }
  | { readonly kind: "push"; readonly path: ValuePath; readonly length: number; readonly items: readonly EditableValue[] }
  | { readonly kind: "assign"; readonly path: ValuePath; readonly value: EditableValue }
  | { readonly kind: "delete"; readonly path: ValuePath };

/** One change to the live streaming map, keyed by the provider toolUseId. An
 *  entry ships whole only when it first appears or changes kind (tool input
 *  text, execution output, proposed diff, preview advice); every later change
 *  is the edits against the version last shipped. */
export type StreamingToolTextOp =
  | { readonly toolUseId: string; readonly kind: "set"; readonly entry: ToolStreamingText }
  | { readonly toolUseId: string; readonly kind: "remove" }
  | { readonly toolUseId: string; readonly kind: "edit"; readonly edits: readonly ValueEdit[] };

export const NO_CHANGED_TOOLS: ReadonlySet<string> = new Set();

/** One drain's worth of changes since the last drain. `changedTools` names
 *  every tool whose live streaming entry changed; the publisher measures each
 *  against the copy it last shipped. `fullResync` covers the rare structural
 *  rewrites (block-cap eviction, stream-retry retraction, queued-message
 *  recall) where reindexing every already-queued change is not worth the
 *  complexity: the consumer re-reads the current block array and streaming
 *  text from the session's base offset instead. */
export interface OutputChangeBatch {
  readonly changes: readonly OutputBlockChange[];
  readonly fullResync: boolean;
  readonly changedTools: ReadonlySet<string>;
}

export const EMPTY_OUTPUT_CHANGE_BATCH: OutputChangeBatch = { changes: [], fullResync: false, changedTools: NO_CHANGED_TOOLS };

export const FULL_RESYNC_OUTPUT_CHANGE_BATCH: OutputChangeBatch = { changes: [], fullResync: true, changedTools: NO_CHANGED_TOOLS };

/** Order-preserving merge of two queued batches. A `fullResync` supersedes
 *  every queued change (the consumer re-reads the block array and the whole
 *  streaming map), so the merged batch drops them; otherwise changes
 *  concatenate (indexes and content offsets are absolute, so replay order is
 *  the only invariant and `[...a, ...b]` preserves it) and the changed tools
 *  unite. */
export function mergeOutputChangeBatches(a: OutputChangeBatch, b: OutputChangeBatch): OutputChangeBatch {
  if (a.fullResync || b.fullResync) return FULL_RESYNC_OUTPUT_CHANGE_BATCH;
  return {
    changes: [...a.changes, ...b.changes],
    fullResync: false,
    changedTools: a.changedTools.size === 0 ? b.changedTools : b.changedTools.size === 0 ? a.changedTools : new Set([...a.changedTools, ...b.changedTools]),
  };
}
