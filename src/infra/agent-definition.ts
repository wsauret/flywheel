/** Base fields shared by every dispatchable agent type. */
interface AgentDefinitionBase {
  name: string;
  description: string;
  maxTurns: number;
  /** Persona roles this agent may dispatch as nested subagents. Empty or
   *  absent means the agent is a leaf: its runner gets no subagent registry.
   *  Grants are roles (not names) so user/project personas that register
   *  under a granted role are covered automatically. */
  subagentRoles?: readonly string[];
}

/** Markdown-authored specialist persona: its own system prompt and tool
 *  list, with the model chosen by role/tier resolution. */
interface PersonaAgentDefinition extends AgentDefinitionBase {
  kind: "persona";
  systemPrompt: string;
  tools: readonly string[];
  /** Skill package ids composed into `systemPrompt` at dispatch, in
   *  declaration order, before the persona's role instructions. */
  requiredSkills?: readonly string[];
  role: string;
  /** When false, dispatch rejects copied parent conversation history. */
  allowFork?: boolean;
  /** Set on a persona of the bundled layer, the one layer whose body may
   *  carry capability markers (ARCH-CONTEXT-033). A user or project persona
   *  body is external text that renders byte for byte. It is part of the
   *  procedure: every copy and serialization keeps it, and persona identity
   *  covers it, so a byte-identical override of a bundled persona, which
   *  renders its markers raw, reports as a different persona. */
  bundled?: true;
}

/** Built-in clone of the dispatching agent. The model and system prompt inputs
 * are inherited at dispatch. Its tools are derived from registry-marked parent
 * tools plus child-local handoff and declared nested-role grants. */
interface GeneralAgentDefinition extends AgentDefinitionBase {
  kind: "general";
}

export type AgentDefinition = PersonaAgentDefinition | GeneralAgentDefinition;
