import { z } from "zod";

/**
 * Shell metacharacter check for string-typed config fields.
 * Blocks: ; | & ` $( ) { } < > and backticks.
 * Applied only to string fields that could be used in shell contexts.
 */
const SHELL_METACHAR_RE = /[;|&`$(){}<>]/;

function noShellMetachars(fieldName: string) {
  return z.string().refine(
    (val) => !SHELL_METACHAR_RE.test(val),
    { message: `${fieldName} must not contain shell metacharacters` }
  );
}

/**
 * ConfigSchema (.strict() — internal).
 *
 * String-typed fields that receive shell metacharacter checks:
 * - model
 * - command (if present)
 * - context_dir (if present)
 */
export const ConfigSchema = z.object({
  model: noShellMetachars("model"),
  command: noShellMetachars("command").optional(),
  context_dir: noShellMetachars("context_dir").optional(),
  max_retries: z.number().int().min(0).max(10),
  timeout_minutes: z.number().int().min(1).max(120),
  dispatcher_timeout_ms: z.number().int().min(5000).max(120000).default(30000),
}).strict();

export type Config = z.infer<typeof ConfigSchema>;
