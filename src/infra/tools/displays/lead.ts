import { singleLine, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

/** The name of a route row that started a new chat. */
export const ROUTE_TO_NEW_CHAT = "Route to new chat";

/** A route of the person's request by the lead. A route to a chat that the
 *  lead started names that chat; a new chat is named by the title that the
 *  call's result states, because the call holds no id for it. */
export const routeRequestDisplay: ToolDisplay = {
  name: "route_request",
  action: "ui_meta",
  displayName: "Route",
  verbs: { progressive: "Routing request", past: "Routed request" },
  isOptimistic: false,
  preservesResultContent: true,
  targetSession: (input) => strField(input, "chat") || undefined,
  invocationBody: (input) => {
    const note = strField(input, "note");
    return note ? { content: note, filetype: "text", presentation: "disclosure" } : undefined;
  },
  getPresentation: (input, _executionCwd, context) => {
    const kind = strField(input, "kind");
    if (kind !== "new" && kind !== "existing") return "input_not_ready";
    const target = context?.targetDescription ?? strField(input, "chat");
    return { name: kind === "new" ? ROUTE_TO_NEW_CHAT : "Route to", detail: singleLine(target ?? "") ?? "" };
  },
};

/** The lead's read of its chats' progress: one chat, or all of them. */
export const chatProgressDisplay: ToolDisplay = {
  name: "chat_progress",
  action: "ui_meta",
  displayName: "Chat Progress",
  verbs: { progressive: "Reading chat progress", past: "Read chat progress" },
  isOptimistic: false,
  targetSession: (input) => strField(input, "chat") || undefined,
  getPresentation: (input, _executionCwd, context) => {
    const chat = strField(input, "chat");
    return { name: "Chat progress", detail: chat ? singleLine(context?.targetDescription ?? chat) ?? chat : "all chats" };
  },
};
