import { createHostedAgentEntries } from "../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text.js";

/** The texts of the entries that the first dispatch of a hosted agent adds to its history, whose definition prompt has
 *  the conversation tier `conversation` and no other tier that the conversation carries: the tier's entry when the tier
 *  is not empty, the engine's system text, and the dispatch wrapper. */
function firstDispatchTexts(conversation: string): readonly string[] {
  const entries = createHostedAgentEntries(() => true)({
    messages: [{ kind: "user", origin: "human", content: "Do the work." }],
    systemPrompt: { stable: "", session: "", conversation },
    tools: [],
    reasoningEffort: "medium",
  });
  return entries.flatMap((entry) => entry.kind === "user" && typeof entry.content === "string" ? [entry.content] : []);
}

/** The record of the engine's system text for a hosted agent, which history holds once per context. */
export const ENGINE_INSTRUCTIONS = firstDispatchTexts("")[0] ?? "";

/** The engine's identity line: the first paragraph of its system text. */
export const AGENT_IDENTITY = ENGINE_INSTRUCTIONS.slice(0, ENGINE_INSTRUCTIONS.indexOf("\n\n"));

/** The text that the engine adds after an agent definition's prompt: its system text after the identity line. */
export const AGENT_APPENDIX = ENGINE_INSTRUCTIONS.slice(AGENT_IDENTITY.length);

/** The entry that carries the conversation tier `tier` of a hosted agent's system prompt in its conversation. */
export function conversationTierEntry(tier: string): string {
  return firstDispatchTexts(tier)[0] ?? "";
}
