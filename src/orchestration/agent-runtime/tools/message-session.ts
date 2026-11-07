import type { ReplyWaitTasks } from "../../session/reply-waits.js";
import type { MessageSessionResult, SessionMessaging } from "../../session/session-messaging.js";
import type { ReplayedSession } from "../../session/schemas.js";
import type { ContentBlock, ConversationMessage } from "../llm/types.js";
import type { AdvertisedTool, RuntimeTool, ToolResult } from "./types.js";
import { parseWorkflowTargets } from "../../../protocol/client/workflow-addresses.js";

export const MESSAGE_SESSION_TOOL_NAME = "message_session";
const ASK_USER_TOOL_NAME = "ask_user";

function blockText(block: ContentBlock): string | undefined {
  if (block.type !== "text") return undefined;
  // A text file the person attached reads as its name, not its body.
  const attachment = /^<attachment name="([^"]*)"/.exec(block.text);
  return attachment ? `[Attached file: ${attachment[1]}]` : block.text;
}

function messageText(content: string | readonly ContentBlock[]): string {
  return typeof content === "string" ? content : content.flatMap((block) => blockText(block) ?? []).join("\n");
}

function isHumanEntry(message: ConversationMessage): message is Extract<ConversationMessage, { kind: "user" }> {
  return message.kind === "user" && (message.producer?.kind === "human" || message.origin === "human");
}

/** The words of the person that a sender read since its last exchange with
 *  `recipient`: each message the person sent and each `ask_user` answer, in
 *  the order the sender read them. The last exchange is the latest message
 *  between the two in either direction, or the launch of the recipient when
 *  the sender launched it. With no earlier exchange, nothing is attached:
 *  the recipient did not exist for the sender before, so it has no gap to
 *  fill. `currentToolUseId` is the call that sends the message, which is not
 *  an earlier exchange. */
function personWordsSince(
  history: readonly ConversationMessage[],
  recipient: { readonly sessionId: string; readonly launchToolUseId?: string },
  currentToolUseId: string,
): string | undefined {
  const askUserCalls = new Set<string>();
  const words: string[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) continue;
    if (message.kind === "user" && message.producer?.kind === "session" && message.producer.sessionId === recipient.sessionId) {
      return render(words);
    }
    if (isHumanEntry(message)) {
      const text = messageText(message.content).trim();
      if (text) words.push(text);
      continue;
    }
    if (message.kind === "toolResult") {
      // Results precede their calls in this backward walk, so a result is
      // kept until its call shows whether it answered `ask_user`.
      if (!message.isError) askUserCalls.add(message.toolUseId);
      continue;
    }
    if (message.kind !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_use" || block.id === currentToolUseId) continue;
      if (block.id === recipient.launchToolUseId) return render(words);
      if (block.name === MESSAGE_SESSION_TOOL_NAME && block.input.to === recipient.sessionId) return render(words);
    }
    for (const block of message.content.toReversed()) {
      if (block.type !== "tool_use" || block.name !== ASK_USER_TOOL_NAME || !askUserCalls.has(block.id)) continue;
      const answer = answerOf(history, index, block.id);
      if (answer) words.push(answer);
    }
  }
  return undefined;
}

/** The sending call of the last message that the sender read from
 *  `recipient`, which marks the current exchange between the two. */
function lastMessageFrom(history: readonly ConversationMessage[], recipient: string): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.kind === "user" && message.producer?.kind === "session" && message.producer.sessionId === recipient) return message.producer.toolUseId;
  }
  return undefined;
}

function answerOf(history: readonly ConversationMessage[], from: number, toolUseId: string): string | undefined {
  for (let index = from + 1; index < history.length; index += 1) {
    const message = history[index];
    if (message?.kind !== "toolResult" || message.toolUseId !== toolUseId) continue;
    const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
    return text || undefined;
  }
  return undefined;
}

function render(words: readonly string[]): string | undefined {
  return words.length === 0 ? undefined : words.toReversed().join("\n\n");
}

const NOT_PARENT_OR_CHILD = "you can wait only on your parent or on your own child, and this session is neither"

const REASON_TEXT = {
  interrupted: "it is interrupted. It reads the message when it resumes. A child that a person interrupted continues only when a person continues it",
  no_reader: "nothing runs it now. It reads the message when it runs again",
  wake_limit: "a chain of messages between sessions reached its limit of five hops. It reads the message later, and this message starts no work",
  not_found: "no session or workflow of this project has that id for the selected target kind. Call list_sessions to find other targets, or process(action='list') to find your own work",
  deleted: "the session was deleted",
  settled: "the session has ended and reads no more messages",
  handing_off: "the agent has started its handoff and reads no more messages",
  self: "a session cannot message itself",
  waits_on_you: "it already waits on you, so a wait with no message would never end. Send it what it needs instead",
  not_parent_or_child: `${NOT_PARENT_OR_CHILD}. Continue your own work. Send the message again without wait only if the message_session description allows it`,
  duplicate: "you sent it the same text less than 30 seconds ago, so it already has this message",
} as const satisfies { readonly [Reason in Exclude<Exclude<MessageSessionResult, { status: "delivered" }>["reason"], "address" | "workflow_wait">]: string };

const WORKFLOW_WAIT_REFUSAL = "Not delivered: a workflow has no answering agent and takes no reply wait. To ask a question, target the particular agent session. To send workflow direction, omit wait. To wait for workflow completion, use process wait.";

// A sender that sends again after a held or refused result starts the loop
// that this tool exists to prevent.
const KEPT_TEXT = "Do not send the message again or send a reminder."

const WAITING_TEXT = "Your turn parks after this batch until the reply arrives as an incoming message, or until a notice says why the wait ended. Do not write the reply yourself. To end a wait that you no longer need, stop its reply_wait process.";

/** The model-visible text of one result. It never contains a reply. A wait
 *  with no text sent nothing, so a held outcome says only whether the wait
 *  opened and why. */
function messageSessionResultText(result: MessageSessionResult, sentText: boolean, wait: boolean, target: "session" | "workflow"): string {
  if (target === "workflow") {
    if (result.status === "delivered") return `Delivered to workflow ${result.to} for its addressed readers. A workflow target takes no reply wait. Continue your own work.`;
    if (result.status === "held") return `Held for workflow ${result.to} until an addressed agent can read it. Do not send the message again or send a reminder. Continue your own work.`;
  }
  switch (result.status) {
    case "delivered": return result.waiting
      ? `Waiting on ${result.to} for a reply. ${WAITING_TEXT}`
      : `Delivered to ${result.to}. A reply, if one comes, arrives later as an incoming message; do not write it yourself.`;
    case "held":
      if (!result.waiting) return sentText ? `Held for ${result.to}: ${REASON_TEXT[result.reason]}. ${KEPT_TEXT} Continue your own work.` : `Not waiting on ${result.to}: it cannot answer now (${result.reason}). It reads a message only when it runs again. Do not wait for it or send it a reminder. Continue your own work on your own judgment.`;
      // Only an interrupt holds a message that carries a wait.
      return sentText
        ? `Held for ${result.to}: ${REASON_TEXT[result.reason]}. ${KEPT_TEXT} Waiting on ${result.to} for a reply after it resumes. ${WAITING_TEXT}`
        : `Waiting on ${result.to} for a reply. It is interrupted, so it answers only after it resumes. ${WAITING_TEXT}`;
    case "refused":
      if (result.reason === "workflow_wait") return WORKFLOW_WAIT_REFUSAL;
      // The address is checked before anything is written, so the sender
      // chooses again from the valid targets that the refusal lists.
      if (result.reason === "address") return `Not delivered to ${result.to}: ${result.detail}`;
      // A refused wait with no text had no message, so its result never
      // asks for one: a sender told to send a message writes a check-in.
      if (!sentText && result.reason === "not_parent_or_child") return `Not waiting on ${result.to}: ${NOT_PARENT_OR_CHILD}. Do not wait for it or check on it. Continue your own work on your own judgment.`;
      // A refused wait states its own next step: the message can go again
      // without the wait. Every other refused message is final.
      if (!sentText || result.reason === "not_parent_or_child") return `Not delivered to ${result.to}: ${REASON_TEXT[result.reason]}.`;
      // A refused copy carries no wait, so the sender that wanted one learns
      // how to wait without sending the text again.
      return `Not delivered to ${result.to}: ${REASON_TEXT[result.reason]}. This refusal is final: do not send this message to ${result.to} again or send a reminder. ${result.reason === "duplicate" && wait ? "To wait for its reply, call message_session with wait true and no text." : "Continue your own work."}`;
  }
}

function launchToolUseIdOf(recipient: Pick<ReplayedSession, "launchedFrom">, senderSessionId: string): string | undefined {
  return recipient.launchedFrom?.parentSessionId === senderSessionId ? recipient.launchedFrom.toolUseId : undefined;
}

/** The advertised form of the message_session tool. It names no messaging
 *  authority, so an agent without one advertises the same bytes. */
export const MESSAGE_SESSION_TOOL_DEFINITION: AdvertisedTool = {
  name: MESSAGE_SESSION_TOOL_NAME,
  action: "ui_meta",
  description: "Send one message to another session or a workflow of this project. Name whether the target is a session or a workflow. Use it only to: ask a question that blocks your work and that your own tools cannot answer; answer a question that a session asked you; revise the instructions of your own child; deliver what your person asked you to send; or tell another root chat once that a check fails in a file that it owns. A message is not a conversation. Put everything the recipient needs in one message. A question gets one answer, and an answer ends the exchange: do not reply to it unless it asks you a new question. Do not send acknowledgements, thanks, confirmations, status or progress reports, promises such as \"I will notify you when\", requests such as \"tell me when it lands\", or \"are you done?\" checks. Do not pass on a message to a session that already has it. Your person sees every message that you send or receive, so do not quote or restate one to your person unless your person asks. When a message needs a decision from your person, ask only that question, in your own words. When your own child asks a question that you cannot answer, ask your parent in your own words. Do not send the same message to several sessions other than your own children. Peers are not your workers: never ask a session that is not your own child to fix, commit, publish, or revert its files for you. A message to your own interrupted child continues its work, unless a person made its latest interrupt. To direct a workflow that you launched, target its workflow id. Omit targets for the whole workflow, or name item keys or named-agent ids from process status. Each later agent that the address covers reads the direction. A message to an agent session reaches only that agent, including a reply to its question, and never adds workflow direction. A peer message to a workflow is information for one agent, not direction. A workflow target takes no reply wait. With wait true toward your parent session or your own child session, your turn parks until its reply arrives or a notice ends the wait. With wait true and no text, you wait without sending anything. A child that you or the runtime interrupted takes no reply wait; a child that a person interrupted can keep one until it resumes. The result says only whether the message was delivered, held, or refused, and returns at once. A session that does not reply has not agreed to anything, so do not act as if it had. Never write a reply for another session yourself.",
  promptSnippet: "Ask a blocking question, answer one, or revise your own child's instructions",
  promptGuidelines: [
    "One message is one question, one answer, one revision of your own child's instructions, or one thing your person asked you to send. Never acknowledge, confirm, promise a later update, or report status. A completion notice tells a parent when its child finishes; no session tells another that it finished. Return delegated results through handoff, not message_session.",
  ],
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["session", "workflow"], description: "Whether to names a session or a workflow. A session receives private input. A workflow receives direction from its launching parent, or information from a peer." },
      to: { type: "string", description: "The id of the target selected by target: a session id for one session, or a workflow id for a workflow. Use process(action='list') for your own work and list_sessions for other targets. To answer an agent's question, use that agent's session id." },
      text: { type: "string", description: "A question that blocks your work, your answer to a question that a session asked you, revised instructions for your own child, what your person asked you to send, or the file, the check, and the exact error of a check that fails in another chat's file. Its first sentence says what the message is about and what you need from the recipient, if anything. Write complete sentences in plain English, with a space between all words and numbers. Do not start with a greeting or a preamble. It must make sense on its own: the recipient does not see your conversation. Required unless wait is true." },
      targets: { type: "array", items: { type: "string" }, description: "Only with a workflow target that you launched: item keys or named-agent ids from process status. Omit targets for the whole workflow. Each addressed agent reads the direction, including later agents that the address covers. Unknown, ambiguous, or finished targets refuse the whole message and list valid targets. An agent-session target takes no targets. A workflow target takes no reply wait." },
      wait: { type: "boolean", description: "Wait for a reply from your parent session or your own child session, only when you cannot continue without it. A workflow target takes no reply wait. To wait for workflow completion, use process wait instead." },
    },
    required: ["target", "to"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  // A crash never leaves a delivered message without its call in the
  // sender's history.
  deferUntilAssistantCommitted: true,
};

/** `tasks` is the background work of the caller's run, which holds each
 *  reply wait; a run without one cannot wait. */
export function createMessageSessionTool(sessions: SessionMessaging, tasks?: ReplyWaitTasks): RuntimeTool {
  return {
    ...MESSAGE_SESSION_TOOL_DEFINITION,
    async execute(input, context): Promise<ToolResult> {
      const to = typeof input.to === "string" ? input.to.trim() : "";
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const wait = input.wait === true;
      const target = input.target;
      if (target !== "session" && target !== "workflow") return { content: 'message_session requires target "session" or "workflow".', outcome: "error" };
      if (target === "workflow" && wait) return { content: WORKFLOW_WAIT_REFUSAL, outcome: "error" };
      if (target === "session" && input.targets !== undefined) return { content: "An agent-session target takes no targets. Select a workflow target for direction.", outcome: "error" };
      const targets = parseWorkflowTargets(input.targets);
      if (!to) return { content: "message_session requires to, the id of the selected session or workflow target.", outcome: "error" };
      if (!text && !wait) return { content: "message_session requires a non-empty `text`, or `wait: true` to wait without a message.", outcome: "error" };
      if (targets === null) return { content: "message_session `targets` must be a list of item keys or agent ids, each a non-empty string.", outcome: "error" };
      if (targets !== undefined && !text) return { content: "message_session `targets` needs a `text` for those items or agents.", outcome: "error" };
      if (wait && !tasks) return { content: "This session cannot wait for a reply. Send the message without `wait`.", outcome: "error" };
      const { sessionId, conversationId, toolUseId } = context;
      if (!sessionId || !conversationId || !toolUseId) return { content: "message_session runs only in a session conversation.", outcome: "error" };
      const history = context.conversationHistory?.() ?? [];
      const exchange = text ? lastMessageFrom(history, to) : undefined;
      const result = await sessions.send({
        sender: { sessionId, conversationId, toolUseId, hop: context.turnHop?.() ?? 0 },
        target,
        to,
        ...(text ? { text } : {}),
        ...(targets ? { targets } : {}),
        ...(exchange ? { exchange } : {}),
        ...(wait && tasks ? { wait: tasks } : {}),
        handBack: true,
        personWords: (recipient) => personWordsSince(history, { sessionId: to, launchToolUseId: launchToolUseIdOf(recipient, sessionId) }, toolUseId),
      });
      // The call carries only the id; the result names the recipient for its
      // row, and the row of a held message states why it waits.
      const details = {
        ...(result.name !== undefined ? { targetName: result.name } : {}),
        ...(result.status === "held" && text ? { statusMessage: `Held: ${REASON_TEXT[result.reason]}.` } : {}),
      };
      return {
        content: messageSessionResultText(result, text.length > 0, wait, target),
        outcome: result.status === "refused" ? "error" : "ok",
        ...(Object.keys(details).length > 0 ? { details } : {}),
      };
    },
  };
}
