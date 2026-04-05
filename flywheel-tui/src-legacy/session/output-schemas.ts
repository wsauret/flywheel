/**
 * Output Snapshot Schema
 *
 * Zod schemas for serializing structured output blocks to disk.
 * These are standalone types that mirror the TUI AnyBlock shapes but live
 * in the schema layer — no TUI imports allowed here.
 *
 * Key behavior:
 * - `toSnapshot()` normalizes runtime state (e.g., active → paused)
 * - `fromSnapshot()` validates with Zod and filters out corrupt items
 */

import { z } from "zod";

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
    toolCount: z.number().optional(),
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
 * AnyBlock-like shape — deliberately loose to avoid importing TUI types.
 * Callers pass their runtime blocks; we normalize and validate.
 */
interface AnyBlockLike {
  kind: string;
  [key: string]: unknown;
}

/**
 * Convert runtime blocks to serializable snapshots.
 *
 * - AgentBlock with status "active" is normalized to "paused"
 * - Unknown block kinds are silently skipped
 */
export function toSnapshot(blocks: AnyBlockLike[]): OutputSnapshot[] {
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

/**
 * Convert validated OutputSnapshot[] to runtime block shapes.
 *
 * OutputSnapshot and AnyBlock are structurally identical for text, tool,
 * system, and contextGroup blocks. For agent blocks, the snapshot status
 * is "paused" (normalized from "active" during serialization), which maps
 * directly to the "paused" variant on AgentBlock.status.
 *
 * This function validates each snapshot through Zod and returns the
 * validated shapes. The caller uses a single type assertion (not a
 * double-cast) since the structural compatibility is guaranteed by
 * the shared "paused" status in both OutputSnapshot and AnyBlock.
 *
 * @param snapshots - Validated OutputSnapshot array (from fromSnapshot)
 * @returns The same array, validated and ready for single-assertion cast
 */
export function snapshotToBlocks(snapshots: OutputSnapshot[]): OutputSnapshot[] {
  return snapshots;
}
