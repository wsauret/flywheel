export type EventKind = "order.placed" | "order.cancelled" | "refund.issued";

/** One event received from the payment provider's webhook feed. */
export interface WebhookEvent {
  id: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

/** Validates the payload shape of one event kind before the event is applied. */
export interface EventValidator {
  readonly kind: EventKind;
  /** Returns one message per problem; an empty array means the payload is valid. */
  validate(payload: Record<string, unknown>): string[];
}

export type IngestResult =
  | { status: "accepted"; eventId: string }
  | { status: "rejected"; eventId: string; reason: string };

/** Outcome of one nightly backfill pass over the provider archive. */
export interface BackfillReport {
  accepted: string[];
  invalid: string[];
  /** Events whose kind the backfill job is not configured to replay. */
  skipped: string[];
}
