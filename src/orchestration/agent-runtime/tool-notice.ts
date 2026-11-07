import type { ConversationMessage } from "./llm/types.js";
import type { AgentLoopSeed } from "./agent-loop-types.js";
import { recordNarrowing, type CapabilityNarrowing } from "./capability-narrowing.js";
import { toolGrantRules } from "./persona-tool-rules.js";
import type { RequestToolSurfaceOwner } from "./request-tool-surface.js";
import type { RuntimeConversation } from "./runtime-conversation.js";

/** The entry id of a conversation's tool notice, so a retry or a resume
 *  commits it at most once. */
function toolNoticeEntryId(conversationId: string): string {
  return `tool-notice:${conversationId}`;
}

/** What an agent that shares its chat tree's agent host may do, from its
 *  first tool plan: every agent of the tree is advertised the same tools, so
 *  the notice names the advertised tools whose calls this agent's plan
 *  refuses, with the read-only rule that its shell enforces (`readOnly`) and
 *  the shell rule when it may call its shell (`toolGrantRules`). Undefined
 *  when the plan refuses no advertised tool. */
export function toolNotice(request: Pick<ReturnType<RequestToolSurfaceOwner["current"]>, "tools" | "usableToolNames" | "registrationIdentities">, readOnly: boolean): string | undefined {
  const advertised = [...request.tools.keys()];
  const usable = advertised.filter((name) => request.usableToolNames.has(request.registrationIdentities.get(name) ?? name));
  if (usable.length === advertised.length) return undefined;
  return toolGrantRules(usable, advertised, { readOnly, shell: request.usableToolNames.has("bash") }).join("\n\n");
}

/** Commits the notice once into a durable conversation's opening turn and
 *  returns the seed that holds it. The notice joins the user turn that the
 *  conversation ends in, which for a fresh agent is its brief or task, and
 *  consecutive user messages travel as one provider message, so the opening
 *  turn carries it. It lives only there, never in the tools or the system
 *  text, so the shared prefix of the tree stays the same; a later change of
 *  what the agent may call reaches it through each refusal's text. The
 *  append joins the running turn's buffer, and every caller flushes that
 *  buffer when an attempt fails, so a retry finds the entry committed.
 *  The entry is `tool-notice` framing: every request reads it, whatever
 *  route serves it, but it states this agent's own grants, so the transcript
 *  echo and reply debt look past it to the task, and a fork does not copy it.
 *  A due narrowing statement joins the notice, so the modules that the
 *  first plan turned off are stated once and no later statement repeats them.
 *  A conversation that holds the entry, or does not end in a user turn (a
 *  restored wait), commits nothing. */
export async function commitToolNotice(
  conversation: RuntimeConversation,
  seed: AgentLoopSeed,
  notice: string,
  narrowing: CapabilityNarrowing | undefined,
): Promise<AgentLoopSeed> {
  const tree = conversation.persistence.committedTree;
  if (seed.kind !== "resume" || !tree || !conversation.aggregateId) return seed;
  const entryId = toolNoticeEntryId(conversation.aggregateId);
  if (seed.priorMessages.at(-1)?.kind !== "user" || (await tree()).entriesById[entryId]) return seed;
  const content = narrowing === undefined ? notice : `${notice}\n\n${narrowing.statement}`;
  const message: ConversationMessage = { kind: "user", content, origin: "system", framing: "tool-notice" };
  await conversation.persistence.history.append(message, entryId);
  if (narrowing !== undefined) recordNarrowing(conversation.sessionId, narrowing.moduleIds, "tool-notice");
  return { kind: "resume", priorMessages: [...seed.priorMessages, message] };
}
