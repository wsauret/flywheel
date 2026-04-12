/**
 * Helper functions for StructuredOutputBuilder.
 *
 * Extracted for SRP: the builder owns block accumulation and dirty tracking;
 * these helpers own the pinned-zone insertion algorithm and index maintenance.
 */

import type { AnyBlock, ToolBlock, AgentBlock } from "../output-blocks.js";

/**
 * Index where new content should be inserted — before the pinned zone.
 * Pinned zone (tail of the array): [...pending user messages, todo list].
 */
export function contentInsertionIndex(blocks: AnyBlock[]): number {
  let idx = blocks.length;
  while (idx > 0) {
    const block = blocks[idx - 1]!;
    if (block.kind === "todoList" || (block.kind === "userMessage" && block.pending)) {
      idx--;
    } else {
      break;
    }
  }
  return idx;
}

/** Insert a content block before the pinned zone. Returns the insertion index. */
export function insertBlockBeforePinned(
  blocks: AnyBlock[],
  block: AnyBlock,
  agentIndexById: Map<string, number>,
  todoBlockIndex: number,
): { index: number; todoBlockIndex: number } {
  const idx = contentInsertionIndex(blocks);
  if (idx < blocks.length) {
    blocks.splice(idx, 0, block);
    for (const [id, agentIdx] of agentIndexById) {
      if (agentIdx >= idx) agentIndexById.set(id, agentIdx + 1);
    }
    return { index: idx, todoBlockIndex: todoBlockIndex >= idx ? todoBlockIndex + 1 : todoBlockIndex };
  }
  blocks.push(block);
  return { index: blocks.length - 1, todoBlockIndex };
}

/** Rebuild the agent ID → index map from scratch. */
export function rebuildAgentIndex(blocks: AnyBlock[], agentIndexById: Map<string, number>): void {
  agentIndexById.clear();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "agent") agentIndexById.set(block.id, i);
  }
}

/** Find the index of the TodoListBlock, or -1 if absent. */
export function findTodoIndex(blocks: AnyBlock[]): number {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.kind === "todoList") return i;
  }
  return -1;
}

/** Append a tool to a specific agent's children, capping at maxChildren. Returns true if successful. */
export function appendToolToAgentChildren(
  blocks: AnyBlock[],
  agentIndexById: Map<string, number>,
  agentId: string,
  tool: ToolBlock,
  maxChildren: number,
): boolean {
  const agentIdx = agentIndexById.get(agentId);
  if (agentIdx === undefined) return false;

  const agent = blocks[agentIdx] as AgentBlock;
  let children = [...agent.children, tool];
  if (children.length > maxChildren) children = children.slice(-maxChildren);
  const latestChild = `${tool.name}: ${tool.detail}`;

  blocks[agentIdx] = { ...agent, children, latestChild };
  return true;
}
