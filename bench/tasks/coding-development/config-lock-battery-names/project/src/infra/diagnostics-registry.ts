/** The one place that says how loud a diagnostic record is.
 *
 *  Two channels write to the JSONL diagnostics stream: `Log.*` level calls and
 *  the typed record families. This table decides the tier of every typed
 *  family; the level a producer passes decides the tier of a `Log` record.
 *  The five rules this table applies (no content, one record per event,
 *  repeats coalesce, decisions are recorded, a budget test) are stated in
 *  docs/guides/session-debugging.md, "Diagnostics Volume".
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
  ["model.catalog.canonical_collision", { tier: "debug" }],
  ["model.catalog.relationship_unresolved", { tier: "info" }],
  ["render.tool_result.phase", { tier: "debug" }],
  ["render.frame.summary", { tier: "debug" }],
  ["runtime.worker.allocated", { tier: "debug" }],
  ["runtime.maintenance.queued", { tier: "debug" }],
  ["runtime.maintenance.withdrawn", { tier: "debug" }],
  ["runtime.account_project.lifecycle", { tier: "debug" }],
  ["conversation.fts.write", { tier: "debug" }],
  ["session.summary.page", { tier: "debug" }],
  ["account.project.open.accepted", { tier: "debug" }],
  ["account.project.open.ready", { tier: "debug" }],

  // Runtime breadcrumb: one record per published workflow link.
  ["agent.workflow_link.published", { tier: "info" }],
  // One record per bash command that ran in a private project copy: file,
  // conflict, and unsupported-change counts plus the apply duration.
  ["agent.bash.edits.applied", { tier: "info" }],
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
