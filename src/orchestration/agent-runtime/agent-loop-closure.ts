import type { AgentLoopTerminal } from "./agent-loop-types.js";
import type { BackgroundWorkRegistry } from "./background-work.js";
import type { ConversationMessage } from "./llm/types.js";
import { handoffNudge } from "../../workflows/shared/handoff-observer.js";
import { MESSAGE_SESSION_TOOL_NAME } from "./tools/message-session.js";

export type AgentLoopClosureMode = "handoff" | "park" | "oneshot";

export function resolveAgentLoopClosureMode(handoffRequired: boolean, completeOnIdle: boolean | undefined, canWaitForInput: boolean): AgentLoopClosureMode {
  if (handoffRequired) return "handoff";
  return completeOnIdle || !canWaitForInput ? "oneshot" : "park";
}

/** Decides the reminder for an agent that owes a handoff and ended a turn without one, with no input queued. It is
 *  reminded at every such end, unless work it owns still runs and the loop can wait for it. Undefined means park. */
export function missingHandoffReminder(mode: AgentLoopClosureMode, canWaitForInput: boolean, liveWork: boolean, tools: { has(name: string): boolean }): string | undefined {
  if (mode !== "handoff") return undefined;
  return liveWork && canWaitForInput ? undefined : handoffNudge(tools.has(MESSAGE_SESSION_TOOL_NAME));
}

/** The text of the latest assistant message: the result of a run that completes on idle, as `claude -p` returns
 *  its final message. Thinking and tool calls are not part of it. */
export function finalReplyText(messages: readonly ConversationMessage[]): string {
  const reply = messages.findLast((message) => message.kind === "assistant");
  if (reply?.kind !== "assistant") return "";
  if (typeof reply.content === "string") return reply.content;
  return reply.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");
}

/** Services hold an explicit wait, but do not hold automatic completion.
 * Awaited work owes a result notification; reply waits retain reply ownership. */
export function hasLiveBackgroundWork(tasks: BackgroundWorkRegistry | undefined, waitRequested: boolean): boolean {
  return ((waitRequested ? tasks?.waitableTaskCount() : tasks?.awaitedTaskCount()) ?? 0) > 0;
}

/** A closed input source is an abort only when teardown requested it. */
export function inputClosedTerminal(aborted: boolean | undefined): AgentLoopTerminal {
  return aborted ? { kind: "aborted" } : { kind: "input_closed" };
}
