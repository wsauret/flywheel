import type { AggregateReadAllowance, AggregateReadRule } from "./aggregate-reads.ts";

// The reviewed exceptions to "derived state is advanced, never recomputed"
// (AGENTS.md section 7). Each entry names one scope and why its caller runs
// the read only once: an explicit person command, a CLI invocation, startup,
// recovery, a migration pass, or one lifecycle event. A scope on a hot path
// (per store change, per fact batch, per tick, per live subscription, or per
// member of a loop inside one of those) never belongs here: it advances from a
// position it keeps, or reads the owning live state.
//
// The check fails on an entry that no finding needs, so every retained
// allowance must name a current finding.

const FULL: AggregateReadRule = "full-aggregate-read";
const LOOP: AggregateReadRule = "durable-read-in-loop";

const MIGRATION = "a one-time store migration pass, run once per workspace when the migration first applies";

function migration(file: string, scope: string, rule: AggregateReadRule = FULL): AggregateReadAllowance {
  return { file: `src/orchestration/modules/workflows/migrations/${file}`, scope, rule, reason: MIGRATION };
}

export const AGGREGATE_READ_ALLOWLIST: readonly AggregateReadAllowance[] = [
  // Person commands and CLI invocations.
  { file: "src/cli/event-search.ts", scope: "reconstructPromptForRequest", rule: FULL, reason: "one `flywheel events` CLI invocation reconstructs one request's prompt" },
  { file: "src/orchestration/modules/development/cli/cache-report.ts", scope: "run", rule: FULL, reason: "one development `cache-report` CLI invocation" },
  { file: "src/orchestration/modules/development/cli/efficiency.ts", scope: "run", rule: FULL, reason: "one development `efficiency` CLI invocation" },
  { file: "src/orchestration/modules/workflows/cli/verify.ts", scope: "readWorkflowRunFacts", rule: FULL, reason: "one `flywheel workflows verify` CLI invocation" },
  { file: "src/orchestration/session/execution-evidence.ts", scope: "readExecutionEvidence", rule: FULL, reason: "one `flywheel events evidence --session` CLI invocation" },
  { file: "src/orchestration/session/execution-evidence.ts", scope: "readExecutionEvidence", rule: LOOP, reason: "one `flywheel events evidence --session` CLI invocation, once for the root and each descendant it names" },
  { file: "src/orchestration/modules/learning/skill-load-stats.ts", scope: "collectSkillLoadRecords", rule: FULL, reason: "one `flywheel skills why` CLI invocation" },
  { file: "src/orchestration/modules/learning/skill-load-stats.ts", scope: "collectSkillWriteRecords", rule: FULL, reason: "one `flywheel skills why` CLI invocation" },
  { file: "src/orchestration/modules/papercuts/disposition-writer.ts", scope: "dispose", rule: FULL, reason: "one papercut_dispose tool call" },
  { file: "src/orchestration/session/conversation/tool-result-meta.ts", scope: "readToolResultDisplayMeta", rule: FULL, reason: "scripts/regenerate-output-seam-corpus.ts:407 decorationFailureOutcomes reads one corpus case per regeneration; no production caller" },
  { file: "src/orchestration/workflow-host/controller.ts", scope: "terminalControl", rule: FULL, reason: "controller.ts:295,463 checks control per explicit Resume or send command; a send to a stopped host also checks again through Resume" },
  { file: "src/orchestration/session/workflow-publication.ts", scope: "adopt", rule: LOOP, reason: "one session.adopt-workflow command, once per old and new parent and per linked member" },
  { file: "src/orchestration/session/agent-input-decision.ts", scope: "voidUnclaimedDecisions", rule: LOOP, reason: "once when a person message supersedes a paused turn, per unclaimed decision" },

  // Startup, recovery, and replacement.
  { file: "src/orchestration/session/conversation/tool-result-meta.ts", scope: "replay", rule: FULL, reason: "seeds a session's tool sources once, the first time a transcript names it; later replays advance the shared cursor" },
  { file: "src/orchestration/session/child-session-reconciliation.ts", scope: "prepareLifecycleAppends", rule: LOOP, reason: "one sequence probe per child whose newest run this sweep settles and whose parent call or notification still needs a write: publishSubagentCompletions returns before it for a group with nothing to write, so a sweep that delivers nothing probes no child. The lifecycle append guard needs the child's whole aggregate sequence, which the type-filtered run owner does not see" },
  { file: "src/workflows/view/view-store.ts", scope: "readWorkflowStatees", rule: LOOP, reason: "seeds each workflow's queue status once, the first time a reader names it; later reads advance the shared cursor" },
  { file: "src/orchestration/workflow-host/recovery-commit.ts", scope: "assessRecoveryEvidence", rule: FULL, reason: "once per assessment identity of a degraded, paused workflow: the recovery fold keeps the identity until a fact other than a valid settings update reaches the aggregate (vm/recovery-fold.ts:213), and an executable run never reads it" },
  { file: "src/orchestration/app-service/project-state-recovery.ts", scope: "recoverSessionConversations", rule: FULL, reason: "crash recovery, once per owed session: the recovery gate or its background task runs it, then retires the session's owed cell" },
  { file: "src/orchestration/app-service/project-state-recovery.ts", scope: "recoverRetainedDeletions", rule: LOOP, reason: "startup recovery, once per retained deletion root" },
  { file: "src/orchestration/app-service/project-state-recovery.ts", scope: "recoverOrphanedChildRuns", rule: FULL, reason: "the deferred stale-session recovery pass, once after readiness" },
  { file: "src/orchestration/modules/project-notifications/recovery.ts", scope: "recoverProjectNotificationHistory", rule: FULL, reason: "startup recovery, once" },
  { file: "src/orchestration/modules/workflows/launch-operation.ts", scope: "initializedWorkflow", rule: FULL, reason: "recovery of one retained workflow launch operation" },
  { file: "src/orchestration/session/agent-input-reconciliation.ts", scope: "recordRecoveredToolResults", rule: FULL, reason: "session reactivation or crash recovery, once per session" },
  { file: "src/orchestration/session/file-mutation-recovery.ts", scope: "reconcileWorkspacePendingFileMutations", rule: FULL, reason: "workspace recovery at the start of one headless task" },
  { file: "src/orchestration/session/file-mutation-recovery.ts", scope: "reconcileWorkspacePendingFileMutations", rule: LOOP, reason: "workspace recovery at the start of one headless task, per session with pending mutation evidence" },
  { file: "src/orchestration/session/mutation-evidence-recovery.ts", scope: "changeIndex", rule: FULL, reason: "one historical mutation-evidence normalization pass, cached per session for the pass" },
  { file: "src/orchestration/session/session-metadata-projection.ts", scope: "recoverSessionMetadata", rule: FULL, reason: "only synchronous migration readers read fully: modules/workflows/migrations/adopt-workflow-children.ts:132,210,291,468,565, workflow-agent-session-titles.ts:52, workflow-agent-sessions.ts:42,64,96, and child-history-transfer.ts:25; live async reads at session-metadata-store.ts:122 and session-catalog-read.ts:107 share the held advancing recovery fold" },
  { file: "src/orchestration/session/planned-session-continuation.ts", scope: "plannedContinuationsWhere", rule: LOOP, reason: "one-shot reads per session that holds a continuation row: one replacement handoff, a capacity ledger's first use, an executor's capacity continuation, and a paused project's interrupt" },
  { file: "src/orchestration/session/command-handover.ts", scope: "readHandovers", rule: LOOP, reason: "the background index passes one session; every session only when a successor adopts one replacement handoff" },

  // One lifecycle event of one session or workflow.
  { file: "src/orchestration/modules/subagents/execution/session-authority.ts", scope: "publish", rule: FULL, reason: "one child-session publication verifies its prompt" },
  { file: "src/orchestration/session/manager.ts", scope: "appendChildPublication", rule: LOOP, reason: "one create, fork, or context publication, per destination and parent guard" },
  { file: "src/orchestration/workflow-host/member-totals.ts", scope: "seedWorkflowMembers", rule: FULL, reason: "the seed of the held workflow-member projection, once per held fold; later facts advance it" },
  { file: "src/orchestration/session-store/duration.ts", scope: "readEpisodeEvidenceEnd", rule: LOOP, reason: "once per cut interval: modules/workflows/duration.ts cutLength runs it once for each interval that a recovery root, a damaged row, or a damaged epoch cut (workflows/vm/control-activity.ts), and holds the result; recordCutEpisode (:71) passes one session during the startup recovery claim (project-state-recovery.ts:140)" },
  { file: "src/workflows/context-bundle/context-recovery.ts", scope: "readWorkflowInputSeed", rule: FULL, reason: "modules/workflows/run-record.ts:112 serves controller.ts:343 on each explicit Resume, including the Resume that sendWorkflow invokes for a stopped host at :447" },
  { file: "src/workflows/definition-provenance-projection.ts", scope: "readRunDefinitionLineage", rule: FULL, reason: "once when a workflow run resolves its definition" },
  { file: "src/workflows/session-fact-source.ts", scope: "holdsControlHistory", rule: FULL, reason: "once when a rootless nonempty aggregate needs its workflow-family boundary" },
  { file: "src/workflows/view/view-projection.ts", scope: "normalizeHistoricalTree", rule: FULL, reason: "one reconstruction per retained pre-v4 tree identity, shared across live row-only states (view-projection.ts normalizedWorkflowView); current companions write v4 when the tree changes (vm/companions.ts:199, view/view-diff.ts:33)" },
  { file: "src/workflows/vm/host.ts", scope: "performPreflight", rule: FULL, reason: "one workflow host preflight on launch or resume, cached for the run" },
  { file: "src/workflows/vm/host.ts", scope: "loop", rule: FULL, reason: "once when a workflow run fails and formats its terminal result" },

  { file: "src/orchestration/session/finalized-tool-result-checkpoint.ts", scope: "readSessionRecoveryEvidence", rule: FULL, reason: "checkpoint.ts:133,259 reads only when retained checkpoints exist: conversation-tree-writer.ts:154 before an idle command, :238 at a question-suspended runner end (chat/controls.ts:196-201), or project-state-recovery.ts:221 during crash recovery; :244 also retires retained legacy cells" },

  // Migrations.
  migration("adopt-workflow-children.ts", "adoptionCandidates"),
  migration("adopt-workflow-children.ts", "adoptionCandidates", LOOP),
  migration("adopt-workflow-children.ts", "adoptionCompletionContent"),
  migration("adopt-workflow-children.ts", "prepareWorkflowAdoption", LOOP),
  migration("adopt-workflow-children.ts", "readControl"),
  migration("adopt-workflow-children.ts", "readQueue"),
  migration("adopt-workflow-children.ts", "workflowConversionDeletionTargets", LOOP),
  migration("workflow-agent-generation-plan.ts", "workflowAgentGenerationPlan"),
  migration("workflow-agent-session-titles.ts", "readPlan"),
  migration("workflow-agent-sessions.ts", "convertWorkflow"),
  migration("workflow-agent-transfer.ts", "executionOwnership"),
  migration("workflow-definition-identity-handoff-revisions.ts", "planAdoption"),
  migration("workflow-definition-identity-persona-shell.ts", "planAdoption"),
  migration("workflow-definition-identity-retired-blocked.ts", "planAdoption"),
  migration("workflow-definition-identity-retired-child-ask-user.ts", "planAdoption"),
  migration("workflow-definition-identity-retired-self-review.ts", "planAdoption"),
  { file: "src/orchestration/session/child-history-transfer.ts", scope: "transferNestedChildren", rule: FULL, reason: MIGRATION },
  { file: "src/orchestration/session/child-history-transfer.ts", scope: "transferNestedChildren", rule: LOOP, reason: MIGRATION },
  { file: "src/orchestration/session/conversation/conversation-projection.ts", scope: "readConversationSnapshotSync", rule: FULL, reason: MIGRATION },
  { file: "src/orchestration/session/execution-history-transfer.ts", scope: "executionHistoryTransferPlan", rule: FULL, reason: MIGRATION },
  { file: "src/orchestration/session/message-owner-transfer.ts", scope: "closeOrchestrationReplyWaits", rule: LOOP, reason: MIGRATION },
];
