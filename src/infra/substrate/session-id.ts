/** Identity of one session: 12 lowercase hex characters, the shape every
 *  session id has in pickers, logs, typed lookups, and a child's process id.
 *  The shape is what tells a session id from a command's process id, which
 *  always carries a prefix, such as `bash-bg-`. */

const SESSION_ID = /^[0-9a-f]{12}$/u

/** The one allocator of session ids. */
export function generateSessionId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12)
}

/** Whether `value` has the shape of a session id. */
export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value)
}
