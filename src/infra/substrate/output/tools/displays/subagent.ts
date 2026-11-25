import { agentDetail, singleLine, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

export const subagentDisplay: ToolDisplay = {
  name: "subagent",
  action: "task_subagent",
  displayName: "Subagent",
  verbs: { progressive: "Running subagent", past: "Ran subagent" },
  isOptimistic: false,
  getSentence: (input) => ({ name: "Dispatched", detail: strField(input, "persona") ?? "" }),
  streamingInput: {
    bodyFields: {},
    presentationFields: ["kind", "description", "persona", "session_id"],
  },
  // A recorded resume or retry addressed its child by `session_id`.
  targetSession: (input) => strField(input, "kind") !== undefined && strField(input, "kind") !== "dispatch" ? strField(input, "session_id") || undefined : undefined,
  rendersAsAgentBlock: (input) => input.kind === "dispatch"
    || (input.kind === undefined && (typeof input.description === "string" || typeof input.persona === "string")),
  getPresentation: (input, _executionCwd, context) => {
    const kind = strField(input, "kind");
    if (kind === "dispatch" || (kind === undefined && (typeof input.description === "string" || typeof input.persona === "string"))) {
      return { name: "Subagent", detail: agentDetail(input, "") ?? "" };
    }
    // `steer` is history only: message_session replaced it, and recorded
    // calls still render. Remove `steer` here after 2027-04-03. `resume`
    // and `retry` are history too: `process` replaced them. Remove them
    // here after 2027-04-08.
    if (kind === "steer" || kind === "resume" || kind === "retry") {
      return {
        name: `Subagent ${kind}`,
        detail: singleLine(context?.targetDescription) ?? "",
      };
    }
    return kind === undefined ? "input_not_ready" : { name: "Subagent", detail: "" };
  },
};
