/**
 * ID generation utility.
 *
 * Generates unique identifiers for tasks using a combination
 * of timestamp and random components.
 */

let counter = 0;

/**
 * Generate a unique task ID.
 *
 * Format: `task-{timestamp}-{counter}-{random}`
 * The counter ensures uniqueness even for IDs generated in the same millisecond.
 */
export function generateId(): string {
  counter++;
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `task-${timestamp}-${counter}-${random}`;
}

/**
 * Reset the counter (for testing).
 */
export function resetIdCounter(): void {
  counter = 0;
}
