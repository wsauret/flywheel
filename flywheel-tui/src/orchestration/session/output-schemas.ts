import { z } from "zod";
import {
  TextBlockSchema,
  ToolEntrySchema,
  AgentBlockSchema,
  SystemBlockSchema,
  ThinkingBlockSchema,
  UserMessageBlockSchema,
  TodoListBlockSchema,
  type AnyBlock,
} from "../../infra/output-blocks.js";

const ToolSnapshotSchema = ToolEntrySchema;

const AgentSnapshotSchema = AgentBlockSchema
  .omit({ status: true })
  .extend({
    status: z.enum(["paused", "completed", "error"]),
  });

// Exported for tests — direct schema validation catches shape regressions
// that toSnapshot/fromSnapshot would silently swallow (they skip invalid items).
export const OutputSnapshotSchema = z.discriminatedUnion("kind", [
  TextBlockSchema,
  ToolSnapshotSchema,
  AgentSnapshotSchema,
  SystemBlockSchema,
  ThinkingBlockSchema,
  UserMessageBlockSchema,
  TodoListBlockSchema,
]);

export type OutputSnapshot = z.infer<typeof OutputSnapshotSchema>;

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
