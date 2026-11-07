import type { CapabilityCheck } from "../../infra/capability-text.js";
import { SECRET_REPLACEMENT } from "../../infra/redact-secrets.js";

export const GLOBAL_GUIDELINE_ID = {
  batchIndependentToolCalls: "batch-independent-tool-calls",
  savedOutputRecovery: "saved-output-recovery",
  secretRedactionMarker: "secret-redaction-marker",
} as const;

export type GlobalGuidelineId = typeof GLOBAL_GUIDELINE_ID[keyof typeof GLOBAL_GUIDELINE_ID];

/** Each guideline's text for the capabilities `has` of the request, or undefined when it applies to none of them. */
type GlobalGuidelineText = { readonly [Id in GlobalGuidelineId]: (has: CapabilityCheck) => string | undefined };

const GLOBAL_GUIDELINES: GlobalGuidelineText = Object.freeze({
  [GLOBAL_GUIDELINE_ID.batchIndependentToolCalls]: () => "Independent tool calls in one turn run concurrently and return together, so batch independent calls with distinct inputs into a single turn. Before submitting, remove duplicate calls with the same tool name and arguments. Repeat a call only when a failure, changed state, or verification requirement makes a fresh result necessary. A turn carries both text and tool calls: when a progress update is due, put the text first and issue the batched calls in that same turn. Serialize across turns only when a later call depends on an earlier call's output, such as reading a file before editing it. This is about grouping calls you already need, not making unnecessary ones.",
  [GLOBAL_GUIDELINE_ID.savedOutputRecovery]: (has) => {
    const recovery = has("read") || has("bash") ? "read that file or search inside it" : has("search") ? "search inside that file" : undefined;
    return recovery && `When a tool truncates its output and names a saved-output file, ${recovery} for the part you need instead of re-running a broader call; it holds the complete result the truncated view came from.`;
  },
  [GLOBAL_GUIDELINE_ID.secretRedactionMarker]: () => `\`${SECRET_REPLACEMENT}\` in tool output usually marks a runtime redaction, not the true bytes; the command or edit itself ran with the real value. Never copy the mask into a command, edit, or file. If the masked text is clearly not a secret (over-matched code), recover the bytes through a transformed view of the file, such as each line reversed; if it is a real credential, leave it masked.`,
});


/** The texts of `ids` that apply to the capabilities `has`, in the order of `ids`. */
export function renderGlobalGuidelines(ids: readonly GlobalGuidelineId[], has: CapabilityCheck): readonly string[] {
  return ids.flatMap((id) => GLOBAL_GUIDELINES[id](has) ?? []);
}
