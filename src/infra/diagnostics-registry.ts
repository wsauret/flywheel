/** The one place that says how loud a diagnostic record is.
 *
 *  Two channels write to the JSONL diagnostics stream: `Log.*` level calls and
 *  the typed record families. This table decides the tier of every typed
 *  family; the level a producer passes decides the tier of a `Log` record.
 *  The rules this table applies are ARCH-RUNTIME-075 through ARCH-RUNTIME-078
 *  (no content, one record per decision, repeats coalesce, one registry
 *  decides each tier).
 *
 *  The policy is default-deny. An unregistered type records at DEBUG, so a new
 *  family is quiet until someone declares that it is worth INFO. Nothing can be
 *  born loud by omission; `bun run lint:diagnostics` reports types that reach
 *  the sink without an entry here. INFO is for one record per decision, state
 *  change, or finished unit of work. A family that records per call, per
 *  request, per stream event, per read, or per store change is DEBUG, however
 *  useful one of its records looks alone. A family whose records matter only
 *  when the work failed or ran slow is "notable": its producer marks those
 *  records, and only they reach the default level. */

export type DiagnosticTier = "info" | "notable" | "debug"

interface DiagnosticDeclaration {
  readonly tier: DiagnosticTier
  /** Schema version the producer writes, for families whose records decode
   *  back into typed facts. Declared beside the tier so the reader and the
   *  writer cannot drift onto different versions of the same family. */
  readonly version?: number
}

/** Every record type that reaches the diagnostics sink. */
const DIAGNOSTICS: ReadonlyMap<string, DiagnosticDeclaration> = new Map([
  // Log level calls. Log gates these before the sink sees them; they are
  // declared so the registry is a complete account of the stream.
  ["log.error", { tier: "info" }],
  ["log.warn", { tier: "info" }],
  ["log.info", { tier: "info" }],
  ["log.debug", { tier: "debug" }],
  // One summary per startup owner. The start and the first-frame checkpoint
  // ride inside it; the start alone is evidence only of a startup that never
  // finished, which the owner's shutdown records as incomplete.
  ["startup.started", { tier: "debug" }],
  ["startup.finished", { tier: "info" }],

  // One completion record per provider request. The durable request audit and
  // the aggregate stream summary are session facts; this record reaches the
  // default level only when the stream failed, stalled, or ran slow.
  ["model.stream.started", { tier: "debug", version: 2 }],
  ["model.stream.completed", { tier: "notable", version: 3 }],
  ["model.stream.event_observed", { tier: "debug", version: 2 }],
  // One record per prompt prefix hold that held a sibling request: how the
  // leader released its followers, how many waited, and how long. A hash
  // prefix names the cached prompt prefix; no content.
  ["model.prefix_hold.settled", { tier: "info" }],
  // One record per response that the admitted request stopped because its
  // reasoning repeated itself: the model, the provider, the attempt, the
  // compression ratio, and the char counts. No content.
  ["model.reasoning.repetition_detected", { tier: "info" }],
  ["model.catalog.canonical_collision", { tier: "debug" }],
  ["model.catalog.relationship_unresolved", { tier: "info" }],
  // One record per published definition revision of a project: its number,
  // the skills it installs, and whether a watched change or a write in this
  // process caused it. A kept revision is a warning from the registry instead.
  ["definitions.revision.published", { tier: "info" }],
  // One record per fact a served request proved about a model for one exact
  // account generation: a refused model, or a narrower granted window.
  ["model.refusal.recorded", { tier: "info" }],
  // One content-free record per account login episode decision, never per waiter or repeated refusal.
  ["provider.claude_sdk.login.condition", { tier: "info" }],
  // One record per login location that a login again retired because another location of the profile holds the
  // same account: the kind of the retired location, the entry names of both locations, and whether it ended or
  // failed and stays.
  ["provider.claude_sdk.login.retired", { tier: "info" }],
  ["render.tool_result.phase", { tier: "debug" }],
  ["render.frame.summary", { tier: "debug" }],
  // Transcript scroll states that must not happen: the reading position moving
  // against the person's input, the extent swinging without input, and a row
  // that keeps unmounting before its height reaches the index. Steady-state
  // scrolling writes none. One record per episode with its evidence, a repeat
  // count every 10 seconds while it lasts, and one closing record with the
  // total count and duration.
  ["tui.scroll.fight.detected", { tier: "info" }],
  ["tui.scroll.fight.repeated", { tier: "info" }],
  ["tui.scroll.fight.ended", { tier: "info" }],
  ["tui.row.mount_churn.detected", { tier: "info" }],
  ["tui.row.mount_churn.repeated", { tier: "info" }],
  ["tui.row.mount_churn.ended", { tier: "info" }],
  ["chat.submission.feedback", { tier: "notable" }],
  ["runtime.worker.allocated", { tier: "debug" }],
  ["runtime.worker.retired", { tier: "notable" }],
  ["runtime.state.operation", { tier: "debug" }],
  ["runtime.persistence_write.refused", { tier: "info" }],
  ["runtime.maintenance.queued", { tier: "debug" }],
  ["runtime.maintenance.withdrawn", { tier: "debug" }],
  ["runtime.account_project.lifecycle", { tier: "debug" }],
  // One record per processor admission decision of the account's governor: a
  // container held, a container released with its reason, and a hold that
  // failed, whose repeats coalesce into one count. The token, the measured
  // cores, the budget, and how many containers wait. A tick that changes
  // nothing records nothing.
  ["runtime.processor_admission.held", { tier: "info" }],
  ["runtime.processor_admission.released", { tier: "info" }],
  ["runtime.processor_admission.hold_failed", { tier: "info" }],
  ["conversation.fts.write", { tier: "debug" }],
  ["session.summary.page", { tier: "debug" }],
  ["account.project.open.accepted", { tier: "debug" }],
  ["account.project.open.ready", { tier: "debug" }],
  // One record per lane a client opens, as that client reports it: how the
  // previous lane ended and where the time to this one went.
  ["runtime.client.lane_attached", { tier: "info" }],
  // One local record when the event subscription reaches its socket, even if the service never answers.
  ["runtime.client.socket_attached", { tier: "info" }],
  // Healthy input is quiet. A mounted client sends the first anomaly and at most one repeat summary per minute.
  ["runtime.client.input_responsiveness", { tier: "notable" }],
  // One failure and one terminal count per reader failure episode, coalesced by the client.
  ["runtime.client.background_read", { tier: "notable" }],

  // Runtime breadcrumb: one record per published workflow link.
  ["agent.workflow_link.published", { tier: "info" }],
  // One record per request addendum that a workflow commit recorded: a
  // message that a step read from its parent, with its ids and byte counts.
  ["workflow.request_addendum.recorded", { tier: "info" }],
  // One record per addressed message that a workflow commit recorded: a
  // message that a sender addressed to items or agents, with its key, its
  // address count, and its byte count.
  ["workflow.addressed_message.recorded", { tier: "info" }],
  // One record per workflow file that a `workflow` call or an approval
  // question saved from content: its path, byte count, and hash, and whether
  // it replaced a file of that name. No content.
  ["workflow.file.saved", { tier: "info" }],
  // One record per admission decision of a workflow host: how many attempts
  // it started together, how many run, how many ready attempts wait on the
  // author's max_parallel, and that cap. Ids and counts only.
  ["workflow.attempts.admitted", { tier: "info" }],
  // One record per recovery decision of an unattended run (an agent of a
  // workflow, a subagent child, a headless task, or a chat's capacity wait)
  // after a run failed: a wait
  // for provider capacity or for the model's access audit, a wait that an
  // interrupt ended, a restart after its pause, and the failure that stands.
  // It fires once per failed run, which the six-attempt rule bounds. Ids,
  // kinds, and counts only.
  ["agent.unattended.recovery", { tier: "info" }],
  // One record per change of a capacity wait's continuation authority: armed
  // before an agent waits, re-armed by the account after a restart, fired
  // when its time came and the account continued it, and withdrawn. Ids and
  // times only; it fires once per wait, not per check of the clock.
  ["agent.capacity_wait", { tier: "info" }],
  // One record per bash command that ran in a private project copy: file,
  // conflict, and unsupported-change counts plus the apply duration.
  ["agent.bash.mutation.applied", { tier: "info" }],
  // One record per `mutates` command whose private copy could not be taken, so
  // it ran in the real project without capture. Beside the record above, it
  // gives the rate at which mutation capture fails.
  ["agent.bash.mutation.uncaptured", { tier: "info" }],
  // One content-free record per command refused by static write-target analysis.
  ["agent.shell.write_refused", { tier: "info" }],
  // One record per narrowing statement that a tree-hosted agent's history
  // gains, alone or in its tool notice: the session, the turned-off module
  // ids, and their count. It fires only when the turned-off set gains a
  // module that the history had not named.
  ["agent.capabilities.narrowed", { tier: "info" }],
  // One record per fresh context whose size is not below the configured
  // automatic compaction trigger, so that trigger is skipped: the session,
  // the fresh-context tokens, both triggers, and the window. Token counts only.
  ["agent.compaction.deferred", { tier: "info" }],
  // One record per message_session refusal of a text that repeats the last
  // text of the sender to the same recipient less than 30 seconds before;
  // repeats coalesce into a count.
  ["session.message.duplicate_refused", { tier: "info" }],
  // One record per refused answer or skip of a question, with the session,
  // the question's tool call, and the reason; no content. A refusal follows a
  // person's tap, so it fires at most once per tap.
  ["question.settlement.refused", { tier: "info" }],
  // One record per deleted chat; passes without deletions stay at DEBUG.
  ["session.auto_delete.deleted", { tier: "info" }],
  ["session.auto_delete.swept", { tier: "debug" }],
  ["session.auto_delete.failed", { tier: "notable" }],
  // The Claude Agent SDK bridge. One record per query start and
  // stop, with the trigger or the reason and the stop procedure's outcome; one
  // per in-place rotation; one per CLI version's in-place decision; one
  // per stop of a CLI that a model listing started; one
  // per request that the CLI sent by itself; one per handled-input defect.
  // A rate limit event reaches the default level only when it is not
  // "allowed", and a rotation's cache read only when it fell below half of the
  // previous request's prompt.
  ["provider.claude_sdk.query.started", { tier: "info" }],
  ["provider.claude_sdk.query.stopped", { tier: "info" }],
  ["provider.claude_sdk.query.reloaded", { tier: "info" }],
  ["provider.claude_sdk.in_place.checked", { tier: "info" }],
  ["provider.claude_sdk.debug_output.silent", { tier: "info" }],
  ["provider.claude_sdk.idle_cli.stopped", { tier: "info" }],
  // One per access probe of an audit; only a probe engine that did not stop cleanly reaches the default level.
  ["provider.claude_sdk.access_probe.stopped", { tier: "notable" }],
  ["provider.claude_sdk.request.hidden", { tier: "info" }],
  ["provider.claude_sdk.step.refused", { tier: "info" }],
  // Per request that the gate cannot read; the stop that the gate decides carries the count at INFO.
  ["provider.claude_sdk.step_gate.rejected", { tier: "debug" }],
  ["provider.claude_sdk.api_error.unattributed", { tier: "info" }],
  ["provider.claude_sdk.response_log.unread", { tier: "info" }],
  ["provider.claude_sdk.bridge.defect", { tier: "info" }],
  ["provider.claude_sdk.rate_limit", { tier: "notable" }],
  ["provider.claude_sdk.rotation.cache", { tier: "notable" }],
  // One record per engine launch, chat or host, with its role and session id. One record when the bridge starts the
  // engine of an anticipated request, and one when that engine ends without serving it, with the rule: abort,
  // unmatched (with the field), replaced, engine-ended (with the error class), module-off, or bridge-closed. A query
  // that takes the engine states how long it waited on its start record. An anticipation that starts no engine
  // records why at DEBUG.
  ["provider.claude_sdk.engine.launched", { tier: "info" }],
  ["provider.claude_sdk.engine.reserved", { tier: "info" }],
  ["provider.claude_sdk.engine.reservation_ended", { tier: "info" }],
  ["provider.claude_sdk.engine.reservation_skipped", { tier: "debug" }],
  // One record per bridge session whose artifacts a sweep deleted, with its proof: its owner's lock was left by a
  // process that is gone, or an earlier build without locks last wrote it before this boot.
  ["provider.claude_sdk.engine.artifacts_reclaimed", { tier: "info" }],
  // A shared agent host: one record when it closes, because its engine's launch record states its open; one per
  // dispatch frame whose delivery missed an agent, with the count; one per agent step that its gate refused; one per
  // stop of an agent's task that Flywheel decided, with its cause. A delivered frame and a dispatcher message that the
  // host denied are DEBUG.
  // One record when a tree opens a host while it has another open, naming the place fields that differ. One record
  // when a frame's dispatcher made no progress within its deadline, with its admitted steps and messages, before the
  // host closes as `dispatcher-stalled`.
  ["provider.claude_sdk.host.split", { tier: "info" }],
  ["provider.claude_sdk.host.closed", { tier: "info" }],
  ["provider.claude_sdk.host.dispatcher_stalled", { tier: "info" }],
  ["provider.claude_sdk.host.delivery_missed", { tier: "info" }],
  ["provider.claude_sdk.host.frame", { tier: "debug" }],
  ["provider.claude_sdk.host.step_refused", { tier: "info" }],
  ["provider.claude_sdk.host.agent_failed", { tier: "info" }],
  // Once per engine version: a hosted agent's stream ended by an SSE error that the engine reports without a key.
  ["provider.claude_sdk.host.stream_error.unattributed", { tier: "info" }],
  ["provider.claude_sdk.host.agent_dispatched", { tier: "info" }],
  ["provider.claude_sdk.host.task_stopped", { tier: "info" }],
  ["provider.claude_sdk.host.dispatch_denied", { tier: "debug" }],
  ["provider.claude_sdk.host.plugins_reloaded", { tier: "info" }],
  ["provider.claude_sdk.host.rewind_refused", { tier: "info" }],
  ["provider.claude_sdk.host.coordinator_demoted", { tier: "info" }],
  ["provider.claude_sdk.host.coordinator_exhausted", { tier: "info" }],
  ["provider.claude_sdk.host_gate.rejected", { tier: "debug" }],
])

/** Tier for a record type. An unregistered type is DEBUG: a family nobody
 *  declared must not reintroduce the flood this table exists to prevent. */
export function diagnosticTier(type: string): DiagnosticTier {
  return DIAGNOSTICS.get(type)?.tier ?? "debug"
}

/** Whether the type carries an entry. The lint check reports the ones that
 *  reach the sink without one. */
export function isRegisteredDiagnostic(type: string): boolean {
  return DIAGNOSTICS.has(type)
}

/** Schema version the producer writes for a decodable family. */
export function diagnosticVersion(type: string): number | undefined {
  return DIAGNOSTICS.get(type)?.version
}

/** Registered types, for the lint check and for readers that decode families
 *  back into typed facts. */
export function registeredDiagnosticTypes(): readonly string[] {
  return [...DIAGNOSTICS.keys()]
}
