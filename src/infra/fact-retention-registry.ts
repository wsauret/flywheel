import type { ModuleId } from "../protocol/module-ids.js"

/** The single place that declares, for each durable fact family, who owns it
 *  and how long its rows stay reachable. `bun run lint:fact-retention` fails
 *  when a fact schema exists that this table does not classify, a non-retired
 *  declaration has no schema, or a module-owned family is defined outside its
 *  owner's fact home or carries none of the owner's declared
 *  prefixes, so a new family cannot be born without its author answering the
 *  two questions that decide whether it accumulates and who reads it.
 *
 *  The owner is `kernel` or a module id. A module's families live under its
 *  orchestration home (the workflows and learning modules define theirs in
 *  `src/workflows/`, the layer below orchestration) and carry the prefixes
 *  the module declares in its descriptor, so `bun run lint:module-locality`
 *  can fail a family literal that leaks past its owner. Kernel families that
 *  share a spelling with a module prefix (`workflow.step.started` is the
 *  runner's attempt ledger, `context.application.recorded` is the provider
 *  request audit) stay kernel because the kernel writes them.
 *
 *  The policies, from ARCH-SUBSTRATE-024 and ARCH-SUBSTRATE-025:
 *
 *  - `history`: every row is consulted after it settles (a fold, a
 *    projection, a transcript, a diagnostic read). Rows live as long as the
 *    session and are deleted only with it.
 *  - `replace-latest`: one live value per aggregate; only the newest row is
 *    reachable, and superseded rows are loss-free dead weight a prune drops
 *    (at write for snapshot families, at session close for workflow-view
 *    families).
 *  - `replace-latest-keyed`: one live value per `key` (a JSON path into the
 *    payload); the newest row per key is reachable.
 *  `flywheel events maintain --prune-superseded` drops the superseded rows of
 *  both replace policies that their owners did not prune.
 *  - `retired`: no producer writes the type anymore. Historical rows are
 *    dropped by `flywheel events maintain --prune-retired`, and the type must
 *    appear in `RETIRED_FACT_TYPES`.
 *
 *  A checkpoint - state held only so an interrupted operation can finish -
 *  must not be declared here at all: it belongs in memory or in the
 *  `in_flight` companion table, never in the log. */
export type FactRetention =
  | { readonly policy: "history" }
  | { readonly policy: "replace-latest" }
  | { readonly policy: "replace-latest-keyed"; readonly key: string }
  | { readonly policy: "retired" }

export type FactOwner = "kernel" | ModuleId

interface FactFamilyGroup {
  readonly owner: FactOwner
  readonly families: { readonly [type: string]: FactRetention }
}

const HISTORY: FactRetention = { policy: "history" }
const REPLACE_LATEST: FactRetention = { policy: "replace-latest" }
const RETIRED: FactRetention = { policy: "retired" }

const FACT_FAMILY_GROUPS: readonly FactFamilyGroup[] = [
  { owner: "kernel", families: {
    // Account project registry: one current registration state per canonical root.
    "account.project.registration.updated": { policy: "replace-latest-keyed", key: "$.projectRoot" },

    // Agent input (questions): the request text survives into the terminal entry.
    "agent_input.requested": HISTORY,
    "agent_input.answered": HISTORY,
    "agent_input.cancelled": HISTORY,
    "agent_input.withdrawn": HISTORY,
    "agent_input.consumed": HISTORY,

    // Conversation trees (ARCH-SESSIONS-047): append-only by design.
    "session.representation.retired": HISTORY,
    "chat.tree.created": HISTORY,
    "chat.entries.appended": HISTORY,
    "chat.follow_up_turn.completed": HISTORY,
    "chat.reasoning.reported": HISTORY,
    // Earlier intent and decisions remain inspectable after every revision.
    "conversation.checkpoint.updated": HISTORY,
    // Written once at a subagent's publication.
    "session.intent.inherited": HISTORY,

    // File mutations: publication evidence, read by recovery and diff views.
    "file.changed": HISTORY,
    "file.reviewed": { policy: "replace-latest-keyed", key: "$.fileId" },
    "file.artifact.recorded": HISTORY,
    "file.mutation.settled": HISTORY,
    "file.mutation.recovery_warned": HISTORY,
    // Preparations moved to the in_flight table; the schema stays readable for
    // stores written before that change, whose recovery still folds both homes.
    "file.mutation.prepared": HISTORY,

    // Session metadata: low-frequency revisions with transition-log semantics.
    "session.created": HISTORY,
    "session.deleted": HISTORY,
    "session.forked": HISTORY,
    "session.lifecycle.changed": HISTORY,
    "session.label.updated": HISTORY,
    "session.chat_metadata.updated": HISTORY,
    "session.execution_cwd.updated": HISTORY,
    "session.auth.profile.selected": HISTORY,
    "session.roles.snapshotted": HISTORY,
    "session.roles.updated": HISTORY,
    "session.roles.removed": HISTORY,
    "session.child.linked": HISTORY,
    "session.child.unlinked": HISTORY,
    "session.ownership.adopted": HISTORY,
    "workspace.facts.migrated": HISTORY,
    // One watermark per migration pass: how far it has looked, replaced each open.
    "workspace.facts.checked": { policy: "replace-latest-keyed", key: "$.migrationId" },
    // The kernel's one statement of how far every stored-fact pass has looked.
    "workspace.facts.settled": REPLACE_LATEST,

    // Runtime session facts: the tool timeline and turn ledger.
    "tool.input.completed": HISTORY,
    "tool.runtime_invocation.recorded": HISTORY,
    "tool.result.recorded": HISTORY,
    "workflow.tool_result.corrected": HISTORY,
    "tool.result.acknowledged": HISTORY,
    "tool.validation.failed": HISTORY,
    // One settled output per tool call. Builds before 2026-09-22 also recorded
    // each running tail; readers fold only the newest row per call, so those
    // rows are dead weight `flywheel events maintain --prune-superseded` drops.
    "tool.execution_output.recorded": { policy: "replace-latest-keyed", key: "$.toolUseId" },
    // One row per background command: `running` until its `settled` row replaces it.
    "tool.background_command.recorded": { policy: "replace-latest-keyed", key: "$.toolUseId" },
    "model.turn.completed": HISTORY,
    "model.context.measured": HISTORY,
    // Request audit facts remain kernel: settlement writes them even when usage inspection is off.
    "model.usage.measured": HISTORY,
    "budget.invocation.recorded": HISTORY,
    "budget.process.started": HISTORY,
    "budget.stream.completed": HISTORY,
    "agent.error.observed": HISTORY,
    "agent.rate_limit.observed": HISTORY,
    // No current emitter, but the workflow history builder folds its
    // historical rows into transcripts, so it is history, not retired.
    "workflow.step.started": HISTORY,
    "workflow.worker_boundary.recorded": HISTORY,

    // Replace-only cells in the log: one live value, superseded rows pruned.
    "session.duration.recorded": REPLACE_LATEST,
    // Disposable prefix cache retired by the shared background summary index.
    "session.stats.snapshotted": RETIRED,
    // Historical families removed from current schemas remain explicitly
    // classified so pruning and retention have one retirement authority.
    "span.started": RETIRED,
    "span.completed": RETIRED,
    "trace.finalized": RETIRED,
    "file.read": RETIRED,
    "chat.entry.provisional": RETIRED,
    "chat.provisionals.discarded": RETIRED,

    // Durable provider-request audit projections live for the session lifespan.
    "prompt.assembled": HISTORY,
    "tool_surface.selected": HISTORY,
    "model.requested": HISTORY,
    "model.request.dispatched": HISTORY,
    "model.response_received": HISTORY,
    "model.usage.recorded": HISTORY,
    "model.stream.summary.recorded": HISTORY,
    "context.application.recorded": HISTORY,
    "context.transformer.applied": HISTORY,

    // Raw stream milestones and deltas remain bounded diagnostics only. The
    // retired subagent dispatch breadcrumbs stay here with the runner ledger
    // that defines them; their spellings live on as debug-log record types.
    "model.stream.started": RETIRED,
    "model.stream.completed": RETIRED,
    "model.stream.event_observed": RETIRED,
    "model.assistant_message.recorded": RETIRED,
    "model.user_message.recorded": RETIRED,
    "agent.wait_placeholder.dropped": RETIRED,
    "agent.subagent.dispatched": RETIRED,
    "agent.subagent.queued": RETIRED,
    "agent.subagent_model.selected": RETIRED,
    "agent.workflow_link.published": RETIRED,
    "agent.waiting_on_subagents.recorded": RETIRED,
  } },

  { owner: "workflows", families: {
    "workflow.run.registered": HISTORY,
    "workflow.run.cut.updated": HISTORY,
    "workflow.run.settings.updated": HISTORY,
    "workflow.run.adopted": HISTORY,
    "workflow.run.deleted": HISTORY,
    // Workflow VM control ledger (ARCH-WORKFLOWS-032): the raw XState oracle replays the
    // exact fact stream, attempt rows included.
    "attempt.started": HISTORY,
    "attempt.succeeded": HISTORY,
    "attempt.blocked": HISTORY,
    "attempt.reverted": HISTORY,
    "attempt.retry_inserted": HISTORY,
    "attempt.insertion_rejected": HISTORY,
    "attempt.resume_cap_exceeded": HISTORY,
    "attempt.resume_recovered": HISTORY,
    "attempt.recovered": HISTORY,
    "attempt.failed": HISTORY,
    "workflow.control.initialized": HISTORY,
    "workflow.control.recovered": HISTORY,
    "workflow.control.committed": HISTORY,
    "workflow.compiled": HISTORY,
    "workflow.completed": HISTORY,
    "workflow.failed": HISTORY,
    "workflow.aborted": HISTORY,
    "workflow.paused": HISTORY,
    "workflow.resumed": HISTORY,
    "workflow.reassessed": HISTORY,
    "workflow.definition_identity.migrated": HISTORY,
    "workflow.definition_identity.adopted": HISTORY,
    "for.expanded": HISTORY,
    "for.expansion_rejected": HISTORY,
    "group.expanded": HISTORY,
    "group.expansion_rejected": HISTORY,
    "group.settled": HISTORY,

    // Workflow context bundles, definitions, handoffs, and follow-ups.
    "context.accumulated": HISTORY,
    "context.input.seeded": HISTORY,
    "step_context.input.added": HISTORY,
    "definition.loaded": HISTORY,
    "definition.hash_recorded": HISTORY,
    "definition.drift_rejected": HISTORY,
    "handoff.written": HISTORY,
    "handoff.validated": HISTORY,
    "follow_up.requested": HISTORY,
    "follow_up.succeeded": HISTORY,
    "follow_up.failed": HISTORY,
    "follow_up.transferred": HISTORY,

    // Workflow view: the queue rebuild folds the incremental families in full,
    // and the step-efficiency projection reads every resume-state row to map
    // each historical conversation to its step.
    "queue.created": HISTORY,
    "queue.deleted": HISTORY,
    "queue.mutated": HISTORY,
    "step.status.changed": HISTORY,
    "step.resume_state.recorded": HISTORY,

    // Replace-only cells in the log: one live value, superseded rows pruned.
    "queue.state.changed": REPLACE_LATEST,
    "queue.plan.changed": REPLACE_LATEST,
    "queue.tree.changed": REPLACE_LATEST,
    // A reader folds the newest change of each node after the newest whole tree.
    "queue.tree.node.changed": { policy: "replace-latest-keyed", key: "$.node.id" },
    "follow_up.resume_state.recorded": REPLACE_LATEST,
    "step.resume_revert.recorded": { policy: "replace-latest-keyed", key: "$.attemptId" },
  } },

  { owner: "learning", families: {
    // Memory, skills, and improvements.
    "memory.written": HISTORY,
    "skill.written": HISTORY,
    "skill.loaded": HISTORY,
    "skill.operation.transitioned": HISTORY,
    "skill.recommendation.recorded": HISTORY,
    "skill.review.completed": HISTORY,
    "skill.cleanup.completed": HISTORY,
    "improvement.proposed": HISTORY,
    "improvement.vetted": HISTORY,
    "improvement.committed": HISTORY,
    "improvement.inspiration.recorded": HISTORY,
    "skill.loads.snapshotted": REPLACE_LATEST,
    // The core-cleanup lease and its cooldowns moved to the in_flight table.
    "skill.cleanup.claimed": RETIRED,
    "skill.cleanup.renewed": RETIRED,
    "skill.cleanup.deferred": RETIRED,
  } },

  { owner: "papercuts", families: {
    "papercut.recorded": HISTORY,
    "papercut.disposed": HISTORY,
  } },

  { owner: "project-notifications", families: {
    // Episodes keep their disposal record.
    "project.notification.raised": HISTORY,
    "project.notification.dismissed": HISTORY,
    "project.notification.resolved": HISTORY,
  } },

  { owner: "experiments", families: {
    // Experiment mode, configuration, run, and continuation history.
    "experiment.mode.changed": HISTORY,
    "experiment.initialized": HISTORY,
    "experiment.run.recorded": HISTORY,
    "experiment.resumed": HISTORY,
  } },

  { owner: "subagents", families: {
    // Subagent runs: launch inputs fold into the terminal entry.
    "child_run.created": HISTORY,
    "child_run.ownership.recovered": HISTORY,
    "subagent.prompted": HISTORY,
    "subagent.completed": HISTORY,
    "subagent.interrupted": HISTORY,
    "subagent.paused": HISTORY,
    "subagent.resumed": HISTORY,
  } },
]

interface FactFamily {
  readonly owner: FactOwner
  readonly retention: FactRetention
}

function indexFactFamilies(groups: readonly FactFamilyGroup[]): ReadonlyMap<string, FactFamily> {
  const families = new Map<string, FactFamily>()
  for (const group of groups) {
    for (const [type, retention] of Object.entries(group.families)) {
      const claimed = families.get(type)
      if (claimed) throw new Error(`Fact family ${type} is owned by both ${claimed.owner} and ${group.owner}`)
      families.set(type, { owner: group.owner, retention })
    }
  }
  return families
}

const FACT_FAMILIES = indexFactFamilies(FACT_FAMILY_GROUPS)

export function factRetention(type: string): FactRetention | undefined {
  return FACT_FAMILIES.get(type)?.retention
}

export function factOwner(type: string): FactOwner | undefined {
  return FACT_FAMILIES.get(type)?.owner
}

export function declaredFactRetentionTypes(): readonly string[] {
  return [...FACT_FAMILIES.keys()]
}

export function declaredRetiredFactTypes(): readonly string[] {
  return [...FACT_FAMILIES.entries()].filter(([, family]) => family.retention.policy === "retired").map(([type]) => type)
}
