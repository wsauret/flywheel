/**
 * Output Snapshot Schema
 *
 * Persistence layer for structured output blocks. Derives snapshot schemas
 * from the canonical Zod schemas in infra/output-blocks.ts — there is no
 * second definition of block shapes here.
 *
 * Persistence-specific constraints:
 * - ToolBlock: strips runtime-only fields (filePath, diff, content, filetype)
 * - AgentBlock: normalizes "active" → "paused"
 * - ContextGroupBlock: children use the narrowed ToolBlock persistence shape
 * - All others: persisted as-is
 */

import { z } from "zod";
import {
  TextBlockSchema,
  ToolBlockSchema,
  AgentBlockSchema,
  ContextGroupBlockSchema,
  SystemBlockSchema,
  ThinkingBlockSchema,
  UserMessageBlockSchema,
  TodoListBlockSchema,
  type AnyBlock,
} from "../../infra/output-blocks";

// Persistence variants — derived from canonical schemas

/** ToolBlock on disk: core fields only, runtime rendering state stripped. */
const ToolSnapshotSchema = ToolBlockSchema.pick({
  kind: true,
  name: true,
  detail: true,
  timestamp: true,
});

/**
 * AgentBlock on disk: "active" status normalized to "paused" before writing,
 * Children use persistence ToolBlock shape.
 */
const AgentSnapshotSchema = AgentBlockSchema
  .omit({ status: true, children: true })
  .extend({
    status: z.enum(["paused", "completed", "error"]),
    children: z.array(ToolSnapshotSchema),
  });

/** ContextGroupBlock on disk: children use persistence ToolBlock shape. */
const ContextGroupSnapshotSchema = ContextGroupBlockSchema
  .omit({ tools: true })
  .extend({ tools: z.array(ToolSnapshotSchema) });

// Discriminated union

export const OutputSnapshotSchema = z.discriminatedUnion("kind", [
  TextBlockSchema,
  ToolSnapshotSchema,
  AgentSnapshotSchema,
  ContextGroupSnapshotSchema,
  SystemBlockSchema,
  ThinkingBlockSchema,
  UserMessageBlockSchema,
  TodoListBlockSchema,
]);

export type OutputSnapshot = z.infer<typeof OutputSnapshotSchema>;

// Converters

/**
 * Convert runtime blocks to serializable snapshots.
 *
 * - AgentBlock with status "active" is normalized to "paused"
 * - Runtime-only fields are stripped by Zod's default parse behavior
 * - Unknown block kinds are silently skipped
 */
export function toSnapshot(blocks: readonly AnyBlock[]): OutputSnapshot[] {
  const snapshots: OutputSnapshot[] = [];

  for (const block of blocks) {
    let candidate: unknown = block;

    // Normalize active agents to paused
    if (block.kind === "agent" && block.status === "active") {
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
