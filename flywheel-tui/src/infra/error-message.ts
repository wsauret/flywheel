/**
 * Extract a human-readable message from an unknown error value.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
