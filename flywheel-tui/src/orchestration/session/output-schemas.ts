/**
 * Output Snapshot Schema
 *
 * Zod schemas for serializing structured output blocks to disk.
 * Uses AnyBlock from infra/output-blocks.ts for the canonical block shapes.
 *
 * Key behavior:
 * - `toSnapshot()` normalizes runtime state (e.g., active → paused)
 * - `fromSnapshot()` validates with Zod and filters out corrupt items
 */

import { z } from "zod";
import type { AnyBlock } from "../../infra/output-blocks";

// ---------------------------------------------------------------------------
// Zod schemas for each block variant
// ---------------------------------------------------------------------------

const TextSnapshotSchema = z
  .object({
    kind: z.literal("text"),
    content: z.string(),
    timestamp: z.number(),
  })
  .strict();

const ToolSnapshotSchema = z
  .object({
    kind: z.literal("tool"),
    name: z.string(),
    detail: z.string(),
    timestamp: z.number(),
  })
  .strict();

/**
 * Agent status on disk. "active" is normalized to "paused" on serialize,
 * so the persisted schema accepts "paused" | "completed" | "error".
 */
const AgentSnapshotSchema = z
  .object({
    kind: z.literal("agent"),
    id: z.string(),
    agentLabel: z.string(),
    description: z.string(),
    status: z.enum(["paused", "completed", "error"]),
    children: z.array(ToolSnapshotSchema),
    latestChild: z.string().optional(),
    duration: z.number().optional(),
    errorMessage: z.string().optional(),
    timestamp: z.number(),
  })
  .strict();

const ContextGroupSnapshotSchema = z
  .object({
    kind: z.literal("contextGroup"),
    tools: z.array(ToolSnapshotSchema),
    timestamp: z.number(),
  })
  .strict();

const SystemSnapshotSchema = z
  .object({
    kind: z.literal("system"),
    message: z.string(),
    timestamp: z.number(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const OutputSnapshotSchema = z.discriminatedUnion("kind", [
  TextSnapshotSchema,
  ToolSnapshotSchema,
  AgentSnapshotSchema,
  ContextGroupSnapshotSchema,
  SystemSnapshotSchema,
]);

export type OutputSnapshot = z.infer<typeof OutputSnapshotSchema>;

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------


/**
 * Convert runtime blocks to serializable snapshots.
 *
 * - AgentBlock with status "active" is normalized to "paused"
 * - Unknown block kinds are silently skipped
 */
export function toSnapshot(blocks: AnyBlock[]): OutputSnapshot[] {
  const snapshots: OutputSnapshot[] = [];

  for (const block of blocks) {
    let candidate: unknown = block;

    // Normalize active agents to paused
    if (block.kind === "agent" && (block as any).status === "active") {
      candidate = { ...block, status: "paused" };
    }

    const result = OutputSnapshotSchema.safeParse(candidate);
    if (result.success) {
      snapshots.push(result.data);
    }
  }

  return snapshots;
}

/**
 * Convert persisted snapshots back to block shapes.
 *
 * - Validates each item with Zod
 * - Invalid items are silently filtered out (graceful degradation)
 */
export function fromSnapshot(snapshots: unknown[]): OutputSnapshot[] {
  const blocks: OutputSnapshot[] = [];

  for (const item of snapshots) {
    const result = OutputSnapshotSchema.safeParse(item);
    if (result.success) {
      blocks.push(result.data);
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Type-safe conversion to AnyBlock
// ---------------------------------------------------------------------------


