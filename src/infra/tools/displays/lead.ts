import { singleLine, strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

/** The name of a route row that started a new session. */
export const ROUTE_TO_NEW_SESSION = "Route to new session";
/** The name of a route row that sent the request to a session that exists. */
export const ROUTE_TO_SESSION = "Route to";

/** The first line of each passage of a split request, as the route's input names them. */
function partLines(input: ToolInput): string[] {
  const parts = input["parts"];
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => typeof part === "string" ? [`- ${part.trim().split("\n", 1)[0] ?? ""}`] : []);
}

/** A route of the person's request by the lead. The row names the chat that
 *  it routed to by that chat's title now: a route to a chat in the list names
 *  the chat of its input, and a new chat is the one that the call's result
 *  states in `details.targetSessionId`, because the call holds no id for it.
 *  Its disclosure shows the first line of each passage of a split request,
 *  then the lead's note. */
export const routeRequestDisplay: ToolDisplay = {
  name: "route_request",
  action: "ui_meta",
  displayName: "Route",
  verbs: { progressive: "Routing request", past: "Routed request" },
  isOptimistic: false,
  preservesResultContent: true,
  targetSession: (input) => strField(input, "chat") || undefined,
  targetTitleOnly: true,
  invocationBody: (input) => {
    const content = [partLines(input).join("\n"), strField(input, "note") ?? ""].filter(Boolean).join("\n\n");
    return content ? { content, filetype: "text", presentation: "disclosure" } : undefined;
  },
  getPresentation: (input, _executionCwd, context) => {
    const kind = strField(input, "kind");
    if (kind !== "new" && kind !== "existing") return "input_not_ready";
    const target = context?.targetDescription ?? strField(input, "chat");
    return { name: kind === "new" ? ROUTE_TO_NEW_SESSION : ROUTE_TO_SESSION, detail: singleLine(target ?? "") ?? "" };
  },
};

/** The lead's read of its chats' progress: one chat, or all of them. */
export const chatProgressDisplay: ToolDisplay = {
  name: "chat_progress",
  action: "ui_meta",
  displayName: "Session Progress",
  verbs: { progressive: "Reading session progress", past: "Read session progress" },
  isOptimistic: false,
  targetSession: (input) => strField(input, "chat") || undefined,
  getPresentation: (input, _executionCwd, context) => {
    const chat = strField(input, "chat");
    return { name: "Session progress", detail: chat ? singleLine(context?.targetDescription ?? chat) ?? chat : "all sessions" };
  },
};
