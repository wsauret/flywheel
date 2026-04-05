/**
 * Orchestration — public API surface.
 *
 * Re-exports from all orchestration modules so consumers can import
 * from `src/orchestration` (or `../orchestration`) instead of reaching
 * into individual files.
 */

export {
  createWorkflowRunner,
  type WorkflowRunner,
  type WorkflowCallbacks,
  type WorkflowResult,
  type StepState,
} from "./workflow-runner"

export {
  loadSessionOutput,
  loadResumeData,
  findResumableSession,
  archiveSession,
  deleteSession,
  type SessionActionDeps,
  type ResumeData,
} from "./session-actions"

export {
  createSessionOrchestrator,
  type SessionOrchestrator,
  type SessionOrchestratorDeps,
  type ResumeResult,
} from "./session-orchestrator"

export {
  createWorkflowSession,
  destroyWorkflowSession,
  type WorkflowSession,
} from "./workflow-session"

export {
  resolveTransports,
  buildExecutorDeps,
  type BuildExecutorDepsOpts,
} from "./queue-orchestrator"

export {
  buildQueue,
  buildQueueForSlashCommand,
  buildQueueFromPlan,
  formatQueueProgress,
  createEndOfSessionGate,
  type QueueProgressInfo,
} from "./queue-builder"

export {
  createSessionRegistry,
  type SessionRegistry,
  type SessionEntry,
} from "./session-registry"
