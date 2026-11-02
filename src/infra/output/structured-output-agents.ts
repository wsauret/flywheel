import { type AgentFailureDisplay, type AgentGroupBlock, isAgentInFlight, type PausedBy } from "../output-blocks.js";
import { INITIALIZING_DESCRIPTION } from "./deferred-agent-meta.js";
import { insertOutputBlock, type OutputBuilderIndexes, resolveUnresolvedChildren } from "./structured-output-state.js";

// agentIndexById maps an agent id to the index of its agentGroup block; the
// kind guard turns that invariant into a narrowed type so callers need no cast.
function agentBlockAt(state: OutputBuilderIndexes, id: string): { idx: number; agent: AgentGroupBlock } | undefined {
  const idx = state.agentIndexById.get(id);
  if (idx === undefined) return undefined;
  const block = state.blocks[idx];
  if (block?.kind !== "agentGroup") return undefined;
  return { idx, agent: block };
}

/** Who an agent row names, decided once from the launching tool call. */
export type AgentBlockIdentity = Pick<AgentGroupBlock, "containerKind" | "label" | "description" | "agentType" | "sentence">;

export function startAgentBlock(
  state: OutputBuilderIndexes,
  id: string,
  identity: AgentBlockIdentity,
  timestamp: number,
  toolUseId: string,
  replaceIndex?: number,
): void {
  const agent: AgentGroupBlock = {
    kind: "agentGroup",
    id,
    ...identity,
    status: "pending",
    children: [],
    totalToolCount: 0,
    timestamp,
    toolUseId,
  };
  const idx = replaceIndex ?? insertOutputBlock(state, agent);
  if (replaceIndex !== undefined) state.blocks[replaceIndex] = agent;
  state.agentIndexById.set(id, idx);
}

export interface CompleteAgentMeta {
  description?: string;
  label?: string;
  totalTokens?: number;
  summary?: string;
  /** The run stopped at its turn budget; the block reads `partial`. */
  partial?: true;
}

export function completeAgentBlock(
  state: OutputBuilderIndexes,
  id: string,
  duration: number,
  meta: CompleteAgentMeta = {},
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  if (!isAgentInFlight(agent.status)) return null;
  state.blocks[idx] = {
    ...agent,
    status: meta.partial ? "partial" : "completed",
    duration,
    children: resolveUnresolvedChildren(agent.children),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.label !== undefined ? { label: meta.label } : {}),
    ...(meta.totalTokens !== undefined ? { totalTokens: meta.totalTokens } : {}),
    ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
  };
  return idx;
}

export function interruptAgentBlock(
  state: OutputBuilderIndexes,
  id: string,
  duration: number,
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  if (!isAgentInFlight(agent.status)) return null;
  // Interrupted status carries the "Interrupted" label in the renderer; the
  // description keeps the goal text. Only the initializing placeholder is
  // dropped - a dead block must not keep claiming to initialize.
  state.blocks[idx] = {
    ...agent,
    status: "interrupted",
    duration,
    description: agent.description === INITIALIZING_DESCRIPTION ? "" : agent.description,
  };
  return idx;
}

/** A pause keeps the goal text: the run resumes from where it stopped, so
 *  the block reads as held work, not as dead work. It states no time: the
 *  wall time since launch is not the child's active time, which only the
 *  child's own clock records and the card's join reads. The pause fact is the
 *  authority over the block: it lands on an in-flight block and on one a
 *  teardown sweep or a stale seed marked interrupted, because the run it
 *  describes was still running when the person or the runtime paused it. */
export function pauseAgentBlock(
  state: OutputBuilderIndexes,
  id: string,
  pausedBy: PausedBy,
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  if (!isAgentInFlight(agent.status) && agent.status !== "interrupted") return null;
  const { duration: _wallTime, ...held } = agent;
  state.blocks[idx] = { ...held, status: "paused", pausedBy };
  return idx;
}

/** Ends an in-flight run for its parent: `cancelled` by the requesting
 *  agent, `stopped` by a person. */
export function cancelAgentBlock(
  state: OutputBuilderIndexes,
  id: string,
  duration: number,
  status: "cancelled" | "stopped",
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  if (!isAgentInFlight(agent.status)) return null;
  state.blocks[idx] = {
    ...agent,
    status,
    duration,
    description: agent.description === INITIALIZING_DESCRIPTION ? "" : agent.description,
  };
  return idx;
}

export function errorAgentBlock(
  state: OutputBuilderIndexes,
  id: string,
  failure: AgentFailureDisplay,
  duration?: number,
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  if (!isAgentInFlight(agent.status)) return null;
  state.blocks[idx] = {
    ...agent,
    status: "error",
    failure,
    ...(duration !== undefined ? { duration } : {}),
    children: resolveUnresolvedChildren(agent.children),
  };
  return idx;
}

export function updateAgentMetaBlock(
  state: OutputBuilderIndexes,
  id: string,
  label?: string,
  description?: string,
  agentType?: string,
  sentence?: AgentGroupBlock["sentence"],
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  state.blocks[idx] = {
    ...agent,
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(sentence === undefined ? {} : { sentence }),
  };
  return idx;
}

export function setAgentModelBlock(
  state: OutputBuilderIndexes,
  id: string,
  model: string,
): number | null {
  const located = agentBlockAt(state, id);
  if (!located || located.agent.containerKind !== "subagent") return null;
  const { idx, agent } = located;
  state.blocks[idx] = { ...agent, model };
  return idx;
}

export function setAgentLinkBlock(
  state: OutputBuilderIndexes,
  id: string,
  linkUri: string,
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  state.blocks[idx] = { ...agent, linkUri };
  return idx;
}

export function updateAgentLatestChildBlock(
  state: OutputBuilderIndexes,
  id: string,
  childDisplay: string,
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  if (!isAgentInFlight(agent.status)) return null;
  state.blocks[idx] = { ...agent, latestChild: childDisplay };
  return idx;
}

/** Marks a dispatch that is waiting for a subagent slot; the dispatched
 *  transition follows automatically when the slot registry grants it. */
export function queueAgentBlock(
  state: OutputBuilderIndexes,
  id: string,
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  if (agent.status !== "pending") return null;
  state.blocks[idx] = { ...agent, status: "queued" };
  return idx;
}

export function dispatchAgentBlock(
  state: OutputBuilderIndexes,
  id: string,
): number | null {
  const located = agentBlockAt(state, id);
  if (!located) return null;
  const { idx, agent } = located;
  // A paused or crash-interrupted run re-dispatches on resume and becomes
  // active again: a dispatch for a settled block's tool use can only be its
  // resume. The goal text stays. The settled figure goes: a running card's
  // time is the child's active time, which the card's join reads from the
  // child, and the settle path that follows records the whole duration.
  if (agent.status === "paused") {
    const { pausedBy: _pausedBy, duration: _settled, ...resumed } = agent;
    state.blocks[idx] = { ...resumed, status: "active" };
    return idx;
  }
  if (agent.status === "interrupted") {
    const { duration: _settled, ...resumed } = agent;
    state.blocks[idx] = { ...resumed, status: "active" };
    return idx;
  }
  if (agent.status !== "pending" && agent.status !== "queued") return null;
  state.blocks[idx] = { ...agent, status: "active" };
  return idx;
}

export function transitionOpenAgentBlocks(
  state: OutputBuilderIndexes,
  currentAgentId: string | null,
  timestamp: number,
  transition: "complete" | "pause" | "teardown",
): number[] {
  const changed: number[] = [];
  for (const [id, idx] of state.agentIndexById) {
    if (id === currentAgentId) continue;
    const block = state.blocks[idx];
    if (block?.kind !== "agentGroup") continue;
    // Complete and pause are turn boundaries: a dispatched (active) subagent
    // stays owned by its background task, which settles the block itself when
    // the subagent finishes (subagents survive ESC and keep running). Only
    // never-dispatched pending blocks are orphans there.
    // Teardown means the session's runners are dying and no settle path will
    // reach this projector, so every in-flight block is dead: mark interrupted.
    const sweepable = transition === "teardown" ? isAgentInFlight(block.status) : block.status === "pending";
    if (!sweepable) continue;
    const duration = timestamp - block.timestamp;
    const result = transition === "complete" ? completeAgentBlock(state, id, duration) : interruptAgentBlock(state, id, duration);
    if (result !== null) changed.push(result);
  }
  return changed;
}
