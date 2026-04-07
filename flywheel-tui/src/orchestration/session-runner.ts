/**
 * SessionRunner — minimal interface shared by all session types (workflow, chat).
 *
 * Contains only the common subset of lifecycle operations. Registry will
 * type-narrow to WorkflowRunner or ChatRunner for session-specific methods
 * (pause, cancelShutdown, etc.).
 */

export interface SessionRunner {
  /** Unique identifier for this session. */
  readonly sessionId: string
  /** Force abort — kill subprocess immediately. */
  abort(): void
  /** Clean up all resources. */
  dispose(): Promise<void>
  /** Inject a user message into the running session. Returns true if delivered or queued. */
  injectMessage(text: string): boolean
}
