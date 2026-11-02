import type { AnyBlock, QuestionBlock, QuestionEntry, ToolEntry, UserMessageBlock } from "../output-blocks.js";
import { appendToolToAgentChildren, insertBlockBeforePinnedTail, rebuildBlockIndexes } from "./structured-output-helpers.js";

const CAP_EVICTION_HEADROOM = 512;

export interface OutputBuilderIndexes {
  blocks: AnyBlock[];
  agentIndexById: Map<string, number>;
  contentIndexById: Map<string, number>;
}

type QuestionAnswers = { [questionId in string]: string };

export function insertOutputBlock(state: OutputBuilderIndexes, block: AnyBlock): number {
  if (block.kind === "userMessage" && block.pending) {
    state.blocks.push(block);
    return state.blocks.length - 1;
  }
  return insertBlockBeforePinnedTail(state.blocks, block, state.agentIndexById, state.contentIndexById);
}

export function hasQueuedUserMessage(state: OutputBuilderIndexes): boolean {
  for (const block of state.blocks) if (block.kind === "userMessage" && block.pending) return true;
  return false;
}

export interface DrainedUserMessage {
  readonly text: string;
  readonly index: number;
  /** True for the person's row; false for a message from another session. */
  readonly person: boolean;
}

/** Marks queued rows sent, restricted to matching identities when supplied. */
export function drainQueuedUserMessages(state: OutputBuilderIndexes, identity?: Pick<UserMessageBlock, "submissionIds" | "dispatchIds">): DrainedUserMessage[] {
  const drained: DrainedUserMessage[] = [];
  for (const [i, block] of state.blocks.entries()) {
    if (block.kind === "userMessage" && block.pending) {
      if (identity !== undefined && !block.submissionIds?.some((id) => identity.submissionIds?.includes(id)) && !block.dispatchIds?.some((id) => identity.dispatchIds?.includes(id))) continue;
      state.blocks[i] = { ...block, pending: false };
      drained.push({ text: block.content, index: i, person: block.from === undefined });
    }
  }
  return drained;
}

/** Removes the person's last queued row. A message from another session never
 *  returns to the person's editor, so its row stays. */
export function popQueuedUserMessage(state: OutputBuilderIndexes): string | null {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (!block || block.kind !== "userMessage" || !block.pending || block.from) continue;
    state.blocks.splice(i, 1);
    rebuildBlockIndexes(state.blocks, state.agentIndexById, state.contentIndexById);
    return block.content;
  }
  return null;
}

export function updateQuestionBlock(
  blocks: AnyBlock[],
  toolUseId: string,
  patch: { answers?: QuestionAnswers; cancelled?: true },
): number | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!block || block.kind !== "question" || block.toolUseId !== toolUseId) continue;
    if (block.answers !== undefined || block.cancelled) return null;
    blocks[i] = { ...block, ...patch } satisfies QuestionBlock;
    return i;
  }
  return null;
}

export function pushQuestionBlock(
  state: OutputBuilderIndexes,
  toolUseId: string,
  questions: QuestionEntry[],
  timestamp: number,
): number {
  return insertOutputBlock(state, {
    kind: "question",
    toolUseId,
    questions,
    timestamp,
  });
}

export function enforceOutputBlockCap(state: OutputBuilderIndexes, blockCap: number): AnyBlock[] {
  if (state.blocks.length <= blockCap) return [];
  const overflow = state.blocks.length - blockCap;
  const evicted = overflow + Math.min(CAP_EVICTION_HEADROOM, blockCap);
  const removed = state.blocks.splice(0, evicted);
  rebuildBlockIndexes(state.blocks, state.agentIndexById, state.contentIndexById);
  return removed;
}

// Child entries are referenced by absolute index from trackedTools, so we never
// evict them; slicing the array would shift those indices and corrupt the
// status updates that arrive later. Total children per agent is bounded by the
// subagent's maxTurns × tools-per-turn (typically <500); the render layer caps
// what's visible.
export function appendAgentChild(
  state: OutputBuilderIndexes,
  agentId: string,
  tool: ToolEntry,
): number {
  return appendToolToAgentChildren(state.blocks, state.agentIndexById, agentId, tool);
}

export function resolveUnresolvedChildren(children: ToolEntry[]): ToolEntry[] {
  return children.map((child) => (
    child.status === "completed" || child.status === "error" || child.status === "interrupted" || child.status === "blocked" ? child : { ...child, status: "completed" }
  ));
}

function applyToolPatch(tool: ToolEntry, patch: Partial<ToolEntry>): ToolEntry {
  const updated = { ...tool };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) Reflect.deleteProperty(updated, key);
    else Object.assign(updated, { [key]: value });
  }
  return updated;
}

export function patchAgentChildTool(
  blocks: AnyBlock[],
  agentIndexById: Map<string, number>,
  agentId: string,
  childIndex: number,
  patch: Partial<ToolEntry>,
): number | null {
  const idx = agentIndexById.get(agentId);
  if (idx === undefined) return null;
  const agent = blocks[idx];
  if (!agent || agent.kind !== "agentGroup") return null;
  const child = agent.children[childIndex];
  if (!child) return null;
  const updatedChildren = [...agent.children];
  updatedChildren[childIndex] = applyToolPatch(child, patch);
  blocks[idx] = { ...agent, children: updatedChildren };
  return idx;
}

export function patchStandaloneTool(
  blocks: AnyBlock[],
  blockIndex: number,
  patch: Partial<ToolEntry>,
): number | null {
  const block = blocks[blockIndex];
  if (!block || block.kind !== "tool") return null;
  blocks[blockIndex] = applyToolPatch(block, patch);
  return blockIndex;
}
