import { AnyBlockSchema, type AnyBlock } from "../../infra/output-blocks.js";

/**
 * Persisted output blocks use the same schema as in-memory ones — the block
 * union (`AnyBlockSchema`) is the single source of truth. Adding a new block
 * kind auto-includes it in save/load.
 *
 * `toSnapshot` normalizes runtime-only states to their terminal equivalents
 * before writing: a session's engine conversation is gone on restart, so
 * in-flight states (active agents, pending questions) can't resume.
 */
export const OutputSnapshotSchema = AnyBlockSchema;
export type OutputSnapshot = AnyBlock;

function normalizeForPersistence(block: AnyBlock): AnyBlock {
  if (block.kind === "toolGroup" && block.status === "active") {
    return { ...block, status: "paused" };
  }
  if (block.kind === "question" && !block.answers && !block.cancelled) {
    return { ...block, cancelled: true };
  }
  return block;
}

export function toSnapshot(blocks: readonly AnyBlock[]): OutputSnapshot[] {
  const snapshots: OutputSnapshot[] = [];
  for (const block of blocks) {
    const normalized = normalizeForPersistence(block);
    const result = OutputSnapshotSchema.safeParse(normalized);
    if (result.success) snapshots.push(result.data);
  }
  return snapshots;
}

export function fromSnapshot(snapshots: unknown[]): OutputSnapshot[] {
  const blocks: OutputSnapshot[] = [];
  for (const item of snapshots) {
    const result = OutputSnapshotSchema.safeParse(item);
    if (result.success) blocks.push(result.data);
  }
  return blocks;
}
