import { z } from "zod";
import { ExecutionStatusSchema } from "./execution";

const StatePhaseSchema = z.object({
  name: z.string(),
  status: ExecutionStatusSchema,
  steps: z.array(z.object({
    description: z.string().optional(),
    status: ExecutionStatusSchema.optional(),
  }).strict()),
}).strict();

export const StateFileSchema = z.object({
  schema_version: z.literal(1),
  plan_path: z.string(),
  writer: z.enum(["controller", "skill"]),
  last_written_at: z.string().datetime(),
  phases: z.array(StatePhaseSchema),
}).strict();

export type StateFile = z.infer<typeof StateFileSchema>;

/**
 * Migration helper: defaults `writer` to `'skill'` and adds `last_written_at`
 * from file mtime before Zod parse.
 */
export function migrateStateFile(
  raw: Record<string, unknown>,
  mtime?: Date,
): Record<string, unknown> {
  const migrated = { ...raw };
  if (!migrated.writer) {
    migrated.writer = "skill";
  }
  if (!migrated.last_written_at) {
    migrated.last_written_at = (mtime ?? new Date()).toISOString();
  }
  return migrated;
}
