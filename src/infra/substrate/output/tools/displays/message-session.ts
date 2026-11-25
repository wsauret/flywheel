import { singleLine, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

/** A message to another session: the row names the recipient, and its body is
 *  the message. The transcript projection names the recipient by its current
 *  display name. When the recipient's metadata is gone, the row shows the name
 *  the call's result states, or else the goal of a child the transcript knows,
 *  or else the session id. */
export const messageSessionDisplay: ToolDisplay = {
  name: "message_session",
  action: "ui_meta",
  displayName: "Message",
  verbs: { progressive: "Sending message", past: "Sent message" },
  isOptimistic: false,
  preservesResultContent: true,
  targetSession: (input) => strField(input, "to") || undefined,
  invocationBody: (input) => {
    const text = strField(input, "text");
    return text ? { content: text, filetype: "text", presentation: "disclosure" } : undefined;
  },
  getPresentation: (input, _executionCwd, context) => {
    const to = strField(input, "to");
    if (!to) return "input_not_ready";
    return { name: "Message to", detail: singleLine(context?.targetDescription ?? to) ?? to };
  },
};

/** The sessions a caller can message, read like any other listing. */
export const listSessionsDisplay: ToolDisplay = {
  name: "list_sessions",
  action: "list",
  displayName: "List Sessions",
  verbs: { progressive: "Listing sessions", past: "Listed sessions" },
  isOptimistic: false,
  getDetail: () => null,
};
