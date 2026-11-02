/**
 * The system prompt in three prompt-cache tiers.
 *
 * `stable` is byte-identical for every session that shares a project and a
 * tool surface: doctrine, tool context, communication, and repository
 * instructions. The tool definitions precede the system prompt in a provider's
 * cache prefix, so a different tool surface is a different cache line by
 * construction and the tier need not be independent of it.
 *
 * The session tier holds shared request context. For workflow agents, the conversation tier holds session identity and the agent scratch and notes paths. Sibling workflow agents with equal shared inputs have byte-identical stable and session tiers, so the prefix hold shares their cache write. Chat and subagent prompt parts keep their existing tiers.
 *
 * No tier holds a brief: an agent's brief is a turn of its conversation.
 *
 * The tiers always render in this order. A provider with explicit cache
 * breakpoints (Anthropic) marks the stable and the session tier, so every such
 * session reads the stable tier from cache, and every such conversation reads
 * the session tier too. The conversation tier carries no breakpoint of its own:
 * the breakpoint on the last message covers it. Providers without breakpoints
 * receive the tiers joined in order.
 */
export interface SystemPromptTiers {
  readonly stable: string;
  readonly session: string;
  readonly conversation: string;
}

export const SYSTEM_PROMPT_SEPARATOR = "\n\n---\n\n";

/** A prompt with no session or conversation tail, such as a literal headless prompt. */
export function stableSystemPrompt(text: string): SystemPromptTiers {
  return { stable: text, session: "", conversation: "" };
}

/** No system prompt at all; providers omit the system field. */
export const NO_SYSTEM_PROMPT: SystemPromptTiers = { stable: "", session: "", conversation: "" };

/** The tiers as one text, in prompt order, for providers, audits, and token counting. */
export function renderSystemPrompt(tiers: SystemPromptTiers): string {
  return [tiers.stable, tiers.session, tiers.conversation].filter((tier) => tier.length > 0).join(SYSTEM_PROMPT_SEPARATOR);
}
