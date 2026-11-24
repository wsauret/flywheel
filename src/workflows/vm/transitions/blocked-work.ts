import { Schema } from "effect";

// Dated history, removed after 2027-04-03 with the replay arm of
// ATTEMPT_BLOCKED. A build before blocked retirement let a work or spec agent
// hand off `outcome.state: "blocked"`, and committed that handoff as the
// canonical evidence of a blocked attempt. Its registered handoff type
// validated the handoff when it was written; this reader decodes only the
// common outcome envelope that replay and the stored blocker report need.
const BlockedHandoffEnvelopeSchema = Schema.Struct({
  outcome: Schema.Struct({
    state: Schema.Literal("blocked"),
    reason: Schema.NonEmptyString,
    evidence: Schema.NonEmptyString,
  }),
  summary: Schema.optionalKey(Schema.String),
});

const decodeBlockedHandoff = Schema.decodeUnknownSync(BlockedHandoffEnvelopeSchema, { onExcessProperty: "ignore" });

export interface BlockedWork {
  readonly reason: string;
  readonly evidence: string;
}

interface HandoffPayload {
  readonly [key: string]: unknown;
}

/** Read the blocker a stored blocked attempt reported from its handoff. Every
 *  control fact and attempt state about the block derives from this envelope. */
export function blockedWork(handoff: HandoffPayload): BlockedWork {
  const decoded = decodeBlockedHandoff(handoff);
  return { reason: decoded.outcome.reason, evidence: decoded.outcome.evidence };
}

/** Render a stored blocker report for the reassessment attempt it is
 *  addressed to, with the blocker reason and evidence under their own
 *  headings. */
export function renderBlockedWork(handoff: HandoffPayload): string {
  const decoded = decodeBlockedHandoff(handoff);
  return [
    ...(decoded.summary?.trim() ? [`### Summary\n${decoded.summary}`] : []),
    `### Blocker Reason\n${decoded.outcome.reason}`,
    `### Blocker Evidence\n${decoded.outcome.evidence}`,
  ].join("\n\n");
}
