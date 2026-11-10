import { SESSION_RELATIONS } from "../../../infra/chat-input-schema.js";
import type { SessionListing, SessionMessaging } from "../../session/session-messaging.js";
import type { AdvertisedTool, RuntimeTool, ToolResult } from "./types.js";

export const LIST_SESSIONS_TOOL_NAME = "list_sessions";

function row(listing: SessionListing): string {
  const membership = listing.workflowMembership;
  const workflow = membership ? ` | workflow ${membership.workflowId}${membership.kind === "historical-follow-up" ? ` follow-up ${membership.followUpId}` : ` attempt ${membership.attemptId}`}` : "";
  return `- ${listing.id} | ${listing.target} | ${listing.kind} | ${listing.owningChat ? `chat ${listing.owningChat}` : listing.relation} | ${listing.state} | ${listing.name}${workflow}`;
}

/** The advertised form of the list_sessions tool. It names no messaging
 *  authority, so an agent without one advertises the same bytes. */
export const LIST_SESSIONS_TOOL_DEFINITION: AdvertisedTool = {
  name: LIST_SESSIONS_TOOL_NAME,
  action: "ui_meta",
  description: "List message targets that you did not start: your parent session, sibling sessions, other sessions of this project that run now, and discoverable workflows. Your own child sessions and workflows are in process(action='list'). Each row names whether its id is a session id or a workflow id, its name and state, and its session relation or owning chat. Agent-session rows also name their workflow membership. Use the row's target kind and id with message_session. A message to an agent session reaches only that agent; a workflow target is distinct.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  isConcurrencySafe: true,
};

export function createListSessionsTool(sessions: SessionMessaging): RuntimeTool {
  return {
    ...LIST_SESSIONS_TOOL_DEFINITION,
    async execute(_input, context): Promise<ToolResult> {
      if (!context.sessionId) return { content: "list_sessions runs only in a session.", outcome: "error" };
      const rows = [...await sessions.list(context.sessionId)]
        .sort((left, right) => SESSION_RELATIONS.indexOf(left.relation) - SESSION_RELATIONS.indexOf(right.relation) || left.id.localeCompare(right.id));
      if (rows.length === 0) return { content: "No other session or workflow of this project is reachable.", outcome: "ok" };
      return { content: ["id | target | kind | relation or owning chat | state | name | membership", ...rows.map(row)].join("\n"), outcome: "ok" };
    },
  };
}
