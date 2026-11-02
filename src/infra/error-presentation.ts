/** Central registry for unsolicited user-facing presentation. */

export type PresentationChannel = "transcript" | "toast" | "status";

export const ERROR_PRESENTATIONS = {
  // Terminal turn failures: the turn is over, the story belongs in the
  // conversation history where it happened, complete with guidance.
  "provider.auth_failed": "transcript",
  "provider.out_of_credits": "transcript",
  "provider.unavailable": "transcript",
  "provider.rate_limited": "transcript",
  "provider.content_declined": "transcript",
  "provider.server_error": "transcript",
  "provider.request_failed": "transcript",
  "provider.overloaded": "transcript",
  "provider.connection_lost": "transcript",
  "provider.output_overflow": "transcript",
  "provider.context_overflow": "transcript",
  "provider.request_aborted": "transcript",
  // Mid-turn observations worth durable history but no standing surface.
  "provider.rate_limit_warning": "transcript",
  "runtime.tree_flush_failed": "transcript",
  "runtime.persistence_write_refused": "transcript",
  // Live recovery progress while a turn is still being retried.
  "provider.reconnect_progress": "status",
  // Provider conditions with durable journal entries retain only operational
  // status presentation here. The journal owns their lasting user surface.
  "provider.status_alert": "status",
  "provider.status_progress": "status",
  "provider.copilot_sign_in": "status",
  "provider.chatgpt_sign_in": "status",
  // A parent whose finished children cannot report back. It stands in place
  // of the wait on them until a completion sweep succeeds.
  "session.child_results_blocked": "status",
  // The writer cannot durably record its own failure. Show that emergency and
  // transcript availability failures once, without adding notification history.
  "runtime.fact_persistence_drop": "toast",
  "transcript.unavailable": "toast",
  // Unsolicited TUI-local degradations: worth a glance, self-healing or
  // already fallen back, nothing standing for the user to act on.
  "provider.quota_rollover": "toast",
  "session.load_failed": "toast",
  "transcript.load_failed": "toast",
  "auth.status_warning": "toast",
  "runtime.capability_warning": "toast",
  "config.invalid": "toast",
} as const satisfies { readonly [id: string]: PresentationChannel };

export type ErrorPresentationId = keyof typeof ERROR_PRESENTATIONS;

/** The ids registered on one of the given channels. */
export type PresentationIdOn<Channel extends PresentationChannel> = {
  [Id in ErrorPresentationId]: (typeof ERROR_PRESENTATIONS)[Id] extends Channel ? Id : never;
}[ErrorPresentationId];

export function presentationChannel<Id extends ErrorPresentationId>(id: Id): (typeof ERROR_PRESENTATIONS)[Id] {
  return ERROR_PRESENTATIONS[id];
}

/** Narrows an id to one registered off the transcript - the shape a session
 *  notice may carry - or undefined for a transcript-registered id. */
export function asNoticePresentation(id: ErrorPresentationId): PresentationIdOn<Exclude<PresentationChannel, "transcript">> | undefined {
  // SAFETY: the guard just proved this id's registry row is not "transcript",
  // which is exactly what PresentationIdOn<Exclude<..., "transcript">> means;
  // TypeScript cannot connect a value lookup back to the key union.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the registry row proves the narrowing the type system cannot derive
  return ERROR_PRESENTATIONS[id] === "transcript" ? undefined : (id as PresentationIdOn<Exclude<PresentationChannel, "transcript">>);
}

/** Runtime id list for the wire schemas: every id registered off the
 *  transcript, in registry order. */
export const SESSION_NOTICE_PRESENTATION_IDS = Object.keys(ERROR_PRESENTATIONS)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Object.keys erases the closed literal key union
  .flatMap((id) => asNoticePresentation(id as ErrorPresentationId) ?? []); // SAFETY: ERROR_PRESENTATIONS is a closed literal object, so its keys are exactly ErrorPresentationId.
