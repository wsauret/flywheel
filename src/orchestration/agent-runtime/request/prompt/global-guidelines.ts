import type { CapabilityCheck } from "../../../../infra/definitions/capability-text.js";
import { SECRET_REPLACEMENT } from "../../../../infra/redact-secrets.js";
import { refusedCallRule } from "./model-chat-body.js";

export const GLOBAL_GUIDELINE_ID = {
  batchIndependentToolCalls: "batch-independent-tool-calls",
  savedOutputRecovery: "saved-output-recovery",
  secretRedactionMarker: "secret-redaction-marker",
  refusedToolCalls: "refused-tool-calls",
} as const;

export type GlobalGuidelineId = typeof GLOBAL_GUIDELINE_ID[keyof typeof GLOBAL_GUIDELINE_ID];

/** Each guideline's text for the capabilities `has` of the request, or undefined when it applies to none of them. */
type GlobalGuidelineText = { readonly [Id in GlobalGuidelineId]: (has: CapabilityCheck) => string | undefined };

const GLOBAL_GUIDELINES: GlobalGuidelineText = Object.freeze({
  [GLOBAL_GUIDELINE_ID.batchIndependentToolCalls]: () => "Calls in one turn run concurrently. Batch the calls you need that are independent: none of them can change state that another one reads. Put a call in a later turn when it needs an earlier result or reads state that an earlier call can change, such as a database that a client rewrites when it opens it. Never send the same call twice in a turn; repeat a call only when a failure, a state change, or a verification needs a fresh result. Put a progress update first in the same turn as its calls.",
  [GLOBAL_GUIDELINE_ID.savedOutputRecovery]: (has) => {
    const recovery = has("read") || has("bash") ? "read or search that file" : has("search") ? "search that file" : undefined;
    return recovery && `When a tool names a saved-output file, ${recovery} for the part you need instead of re-running the call.`;
  },
  [GLOBAL_GUIDELINE_ID.secretRedactionMarker]: () => `\`${SECRET_REPLACEMENT}\` in tool output usually marks a runtime redaction; the command or edit ran with the real value. Never copy the mask into a command, edit, or file. If the masked text is clearly not a secret, read the file through a transformed view, such as each line reversed; leave a real credential masked.`,
  [GLOBAL_GUIDELINE_ID.refusedToolCalls]: () => refusedCallRule("the user or a Flywheel policy"),
});


/** The texts of `ids` that apply to the capabilities `has`, in the order of `ids`. */
export function renderGlobalGuidelines(ids: readonly GlobalGuidelineId[], has: CapabilityCheck): readonly string[] {
  return ids.flatMap((id) => GLOBAL_GUIDELINES[id](has) ?? []);
}
