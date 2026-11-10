import type { AgentDefinition } from "../../infra/agent-definition.js";
import { CHECKPOINT_TOOL_NAMES } from "../../infra/agent-assets/session-notes.js";

/** Resolves a definition's `subagentRoles` grant against a registry: the names
 *  of persona agents whose role is granted. The general agent has no role, so
 *  it is never a grantee - nesting cannot recurse through it. Self-grants are
 *  always dropped: a persona granting its own role must not be able to respawn
 *  itself indefinitely.
 *
 *  Dispatch resolves the grant here, and workflow definition identity walks the
 *  same function, so the personas a run can reach and the personas its contract
 *  pins are one set by construction. */
export function grantedSubagentTypes(
  agent: AgentDefinition,
  registry: ReadonlyMap<string, AgentDefinition>,
): ReadonlySet<string> {
  const roles = agent.subagentRoles;
  if (!roles || roles.length === 0) return new Set();
  const granted = new Set<string>();
  for (const [name, candidate] of registry) {
    if (name === agent.name) continue;
    if (candidate.kind === "persona" && roles.includes(candidate.role)) granted.add(name);
  }
  return granted;
}

/** The agents of `registry` that `available` also holds: a dispatcher's scope of the installed agents, narrowed to
 *  the ones that can run, which a grant may reach and an unknown-name refusal may list. The caller passes the
 *  available personas of its definition availability. */
export function dispatchableAgents(
  registry: ReadonlyMap<string, AgentDefinition>,
  available: ReadonlyMap<string, AgentDefinition>,
): ReadonlyMap<string, AgentDefinition> {
  return new Map([...registry].filter(([name]) => available.has(name)));
}

const ADVISOR_PERSONA = "advisor";

/** The personas an agent of a workflow may dispatch by its record: its
 *  authored `subagents` and the advisor persona. On trial since 2026-11-01,
 *  every agent of a workflow can ask the advisor for a second opinion without
 *  a grant while the advisor is on (PI-AGENT-044). An agent that itself runs
 *  as the advisor does not get it, so the advisor dispatches no advisor, as
 *  the self-grant rule above keeps it.
 *
 *  Dispatch passes `available`, the personas the agent's availability admits,
 *  so the set keeps only the authored names among them, and the default joins
 *  only while the advisor is among them. Definition
 *  identity passes none, because identity never depends on a preference: it
 *  pins what the run can reach with every type on. Launch authority and
 *  definition availability read only the authored `subagents`, so the default
 *  never refuses a launch from a chat without the subagent tool and never
 *  makes a workflow require the Subagents module. */
export function workflowAgentSubagents(
  agent: { readonly subagents: readonly string[]; readonly persona?: string },
  available?: ReadonlyMap<string, AgentDefinition>,
): readonly string[] {
  const authored = available === undefined ? agent.subagents : agent.subagents.filter((name) => available.has(name));
  return agent.persona === ADVISOR_PERSONA || (available !== undefined && !available.has(ADVISOR_PERSONA))
    ? authored
    : [...authored, ADVISOR_PERSONA];
}

/** Canonical dispatch tool surface for a persona: its declared tools, the
 *  nested-dispatch pair when any role grant resolves, the child-local
 *  handoff every subagent settles through, and the checkpoint tools every
 *  execution compacts with. Subagent dispatch and benchmark persona runs
 *  share this one derivation. */
export function personaToolNames(
  agent: Extract<AgentDefinition, { kind: "persona" }>,
  registry: ReadonlyMap<string, AgentDefinition>,
): string[] {
  const granted = grantedSubagentTypes(agent, registry);
  return [...new Set([...agent.tools, ...(granted.size > 0 ? ["subagent", "process"] : []), "handoff", ...CHECKPOINT_TOOL_NAMES])];
}

/** Every agent name a dispatch that starts at `roots` can reach, roots
 *  included, sorted. A name with no definition in the registry is retained so
 *  the caller can report it as unresolved; grants are followed only through
 *  definitions that exist. Mutual grants are a cycle, so a name already
 *  admitted is never expanded twice. */
export function reachableAgentNames(
  roots: Iterable<string>,
  registry: ReadonlyMap<string, AgentDefinition>,
): readonly string[] {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || reached.has(name)) continue;
    reached.add(name);
    const agent = registry.get(name);
    if (!agent) continue;
    for (const granted of grantedSubagentTypes(agent, registry)) pending.push(granted);
  }
  return [...reached].sort();
}
