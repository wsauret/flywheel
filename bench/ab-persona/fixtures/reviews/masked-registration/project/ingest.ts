import { PRODUCTION_VALIDATORS } from "./registry.ts";
import type { IngestResult, WebhookEvent } from "./types.ts";

/** Live webhook handler. Every event on the HTTP path passes through here
 *  before it is applied to account state. */
export function ingestEvent(event: WebhookEvent): IngestResult {
  const validator = PRODUCTION_VALIDATORS.get(event.kind);
  if (!validator) {
    return { status: "rejected", eventId: event.id, reason: `no validator registered for ${event.kind}` };
  }
  const issues = validator.validate(event.payload);
  if (issues.length > 0) {
    return { status: "rejected", eventId: event.id, reason: issues.join("; ") };
  }
  return { status: "accepted", eventId: event.id };
}
