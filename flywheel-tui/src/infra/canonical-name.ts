/**
 * Normalize an external identifier (tool name, model ID, provider ID) to its
 * canonical internal form. Apply once at each entry boundary so downstream
 * code never needs to worry about casing.
 *
 * Canonical form: lowercase, trimmed.
 */
export function canonicalize(name: string): string {
  return name.toLowerCase().trim();
}
