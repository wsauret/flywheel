import type { SessionIdentity } from "../../../session/session-messaging.js";

const KIND_NAMES = {
  chat: "a root chat",
  subagent: "a subagent",
  "workflow-agent": "an agent of a workflow",
} as const satisfies { readonly [Kind in SessionIdentity["kind"]]: string };

/** The kernel section that tells a session who it is and how it reaches the
 *  sessions around it. It is built from the identity alone, so it is the same
 *  in every request of one session and keeps the prompt cache. It names only
 *  kernel tools; a module adds its own lines through its prompt fragment. */
export function renderSessionIdentity(identity: SessionIdentity): string {
  const membership = identity.workflowMembership;
  const kind = !membership ? KIND_NAMES[identity.kind]
    : membership.kind === "historical-follow-up" ? `a historical agent of workflow ${membership.workflowId}`
    : `an agent of workflow ${membership.workflowId}, attempt ${membership.attemptId}`;
  const head = `# Session identity\n\nYou are session ${identity.sessionId}, ${kind}.`;
  if (identity.parent) {
    return [
      `${head} Your parent is session ${identity.parent.sessionId} ("${identity.parent.name}").`,
      [
        "- When the design and the evidence cannot settle a choice, such as a conflict with the approved design or with an explicit prohibition of the person, message your parent with wait true. Resolve expected drift yourself. Plans, progress, check failures, and results go in your handoff, never in a message.",
        "- When your parent ends its turn without a reply, the notice gives its last words. If they say that it will reply, wait again: message_session to your parent with wait true and no text.",
        "- Where any instruction tells you to ask the user or the person, message your parent instead.",
      ].join("\n"),
    ].join("\n\n");
  }
  return [
    head,
    [
      "- Reply to the session that asked you before you end your turn, after you ask the person if you need them first.",
      "- A completion notice ends the open questions of the session that it reports. A workflow completion is not a reply from one of its agents.",
      "- Other root chats do separate work for the same person. Message one only when your person asks you to, when you need a fact that only that chat has, or when a check fails in a file that it owns. For a failed check, send one message without wait with the file, the check, and the exact error, and ask nothing. Then treat failures in that file as not yours, and do not wait for or ask about the fix.",
      "- Answer questions about commits, publication, integration, or progress from your own state and tools. Answer another root chat once, say that each chat publishes its own work, and do not take on work for it. Never ask another chat to answer your person for you.",
      "- When your person writes to you, stop any exchange with another root chat that they did not ask for.",
    ].join("\n"),
  ].join("\n\n");
}
