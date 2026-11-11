import type { AnyBlock, ToolEntry } from "../output-blocks.js";

// Index of the first block in the pinned tail. New timeline content inserts at
// this index, landing above queued user messages.
function pinnedTailIndex(blocks: AnyBlock[]): number {
  let idx = blocks.length;
  while (idx > 0) {
    const block = blocks[idx - 1];
    if (block?.kind === "userMessage" && block.pending) {
      idx--;
      continue;
    }
    break;
  }
  return idx;
}

export function insertBlockBeforePinnedTail(
  blocks: AnyBlock[],
  block: AnyBlock,
  agentIndexById: Map<string, number>,
  contentIndexById: Map<string, number>,
): number {
  const idx = pinnedTailIndex(blocks);
  if (idx < blocks.length) {
    blocks.splice(idx, 0, block);
    for (const [id, agentIdx] of agentIndexById) {
      if (agentIdx >= idx) agentIndexById.set(id, agentIdx + 1);
    }
    for (const [id, contentIdx] of contentIndexById) {
      if (contentIdx >= idx) contentIndexById.set(id, contentIdx + 1);
    }
    return idx;
  }
  blocks.push(block);
  return blocks.length - 1;
}

/** Drop undefined values so a spread patches only the fields the caller provided. */
export function definedProps<T extends object>(props: T): Partial<T> {
  // SAFETY: The filter removes only undefined values, while Object.fromEntries erases the generic key correlation.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Object.fromEntries erases generic key and value correlation
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** The key of a text or thinking row in the content index: the row's kind and
 *  id, the identity every client keys it by. A thought that streamed under a
 *  coordinate that a text run later took is a different row from that run. */
export function contentKey(kind: "text" | "thinking", id: string): string {
  return `${kind}:${id}`;
}

export function rebuildBlockIndexes(
  blocks: AnyBlock[],
  agentIndexById: Map<string, number>,
  contentIndexById: Map<string, number>,
): void {
  agentIndexById.clear();
  contentIndexById.clear();
  for (const [i, block] of blocks.entries()) {
    if (block.kind === "agentGroup") agentIndexById.set(block.id, i);
    if (block.kind === "text" || block.kind === "thinking") contentIndexById.set(contentKey(block.kind, block.id), i);
  }
}

export function appendToolToAgentChildren(
  blocks: AnyBlock[],
  agentIndexById: Map<string, number>,
  agentId: string,
  tool: ToolEntry,
): number {
  const agentIdx = agentIndexById.get(agentId);
  if (agentIdx === undefined) return -1;

  const agent = blocks[agentIdx];
  if (agent?.kind !== "agentGroup") return -1;
  const children = [...agent.children, tool];
  const latestChild = `${tool.presentation.name}: ${tool.presentation.detail}`;
  const totalToolCount = agent.totalToolCount + 1;

  // Reactivate: if an agent was prematurely completed but new child events
  // arrive, reopen it. The authoritative close signal is the tool_result for
  // the subagent's tool_use_id, not the absence of activity.
  const reactivate = agent.status === "completed";

  blocks[agentIdx] = {
    ...agent,
    children,
    totalToolCount,
    latestChild,
    ...(reactivate && { status: "active" as const, duration: undefined, totalTokens: undefined }),
  };
  return children.length - 1;
}
