/** Names an API key without showing it. A `!command` reference reads
 *  "!command", and a literal key shows only its last 4 characters behind a
 *  mask. The terminal login prompt and the stored-key status both use this
 *  one form, so a person can match a key that they entered to a stored key.
 *  This module imports nothing, so the startup path can load the prompt that
 *  uses it without the auth store. */
export function apiKeyHint(key: string): string {
  return key.startsWith("!") ? "!command" : `••••${key.slice(-4)}`
}
