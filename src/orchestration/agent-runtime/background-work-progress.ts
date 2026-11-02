/** Work that can wake its owner, independent of its process-list presentation. */
export type WorkReference =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "workflow"; readonly workflowId: string }
  | { readonly kind: "command"; readonly processId: string };

/** Live task counts and dependency changes of one agent run. */
export interface BackgroundWorkProgress {
  /** Subagent tasks still owned by the parent, including person-interrupted work. */
  activeSubagentCount(): number;
  /** Whether the call still owns a reply wait. */
  holdsWait(toolUseId: string): boolean;
  /** Tasks whose completion notification has not been published. */
  activeTaskCount(): number;
  /** Tasks an explicit wait includes, including services. */
  waitableTaskCount(): number;
  /** Work a bounded run must await, excluding services and agent/runtime-interrupted children. */
  awaitedTaskCount(): number;
  /** Awaited work other than reply waits, including pending result delivery. */
  liveWorkReferences(): WorkReference[];
  /** Observes admission, settlement, and interruption, including non-command work. */
  observeWorkChanges(listener: () => void): () => void;
}
