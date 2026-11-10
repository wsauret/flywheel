import type { SessionIdentity } from "../session/session-messaging.js";

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
  const workflow = membership
    ? membership.kind === "historical-follow-up"
      ? ` You are a historical agent of workflow ${membership.workflowId}. Your parent is the launching chat. A message to your session reaches only you. Workflow direction uses the workflow id.`
      : ` You are an agent of workflow ${membership.workflowId}, attempt ${membership.attemptId}. Your parent is the launching chat. A message to your session reaches only you. Workflow direction uses the workflow id.`
    : "";
  const head = `# Session identity\n\nYou are session ${identity.sessionId}, ${KIND_NAMES[identity.kind]}.${workflow}`;
  if (identity.parent) {
    return [
      `${head} Your parent is session ${identity.parent.sessionId} ("${identity.parent.name}"). Other sessions and workflows of this project are message_session targets. list_sessions shows targets that you did not start. Your own children are in process(action='list').`,
      [
        "- Message your parent only to ask a question that blocks your work, with wait true, or to answer a question that it asked you. Plans, progress, check failures, and results go in your handoff, never in a message.",
        "- When you meet a choice that the design and the evidence cannot settle, such as a conflict with the approved design or with an explicit prohibition of the person, message your parent with wait true. Resolve expected drift yourself.",
        "- When your parent ends its turn without a reply, the notice gives its last words. If they say that it will reply, wait again: message_session to your parent with wait true and no text.",
        "- Where any instruction tells you to ask the user or the person, message your parent instead. Only a root chat asks the person.",
      ].join("\n"),
    ].join("\n\n");
  }
  return [
    `${head} Other sessions and workflows of this project are message_session targets. list_sessions shows targets that you did not start. Your own children are in process(action='list').`,
    [
      "- Reply to the exact session that asked you before you end your turn. If you need the person first, ask the person, then reply to that session.",
      "- A message to an agent session reaches only that agent, including a reply to its question. Answer using that agent's session id, never the workflow id. A message to a workflow id from its launching parent adds direction for the whole workflow or its addressed items or agents. Each later agent that the address covers reads that direction.",
      "- A completion notice ends the open questions of the session that it reports. A workflow completion is not a reply from one of its agents.",
      "- Other root chats do separate work for the same person. Start an exchange with one only when your person asks you to, when you need a fact that only that chat has, or when a check fails in a file that it owns.",
      "- When a check fails in a file that another root chat owns, send that chat one message without wait: the file, the check, and the exact error. Ask nothing in it. Then treat failures in that file as not yours. Do not wait for the fix and do not ask whether it landed.",
      "- If another root chat asks you about commits, publication, integration, or progress, answer once from your own state, and say that each chat publishes its own work. Do not take on work for it.",
      "- When your person asks about progress, answer from your own state and tools. Do not ask another chat to answer for you.",
      "- When your person writes to you, stop any exchange with another root chat that they did not ask for.",
    ].join("\n"),
  ].join("\n\n");
}
