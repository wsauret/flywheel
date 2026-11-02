import { ConversationTreeStorage } from "./conversation-tree-storage.js";
import { ConversationTree } from "./conversation-tree.js";
import { isSessionOwnerGone } from "../pid-lock.js";
import type { ConversationTreeProjectionState, ConversationTreeTranscriptEntry } from "./conversation-projection.js";
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../../infra/event-store-types.js";
import { InvariantViolation } from "../../../infra/invariant.js";
import type { ConversationMessage, ContentBlock } from "../../agent-runtime/llm/types.js";
import { interruptedToolResult } from "../../agent-runtime/llm/heal-messages.js";
import type { ConversationEntry } from "./conversation-entry-types.js";

interface OpenConversationTreeOptions {
  /** Aggregate key for the conversation tree (`conversation:<conversationId>`). */
  conversationId: string;
  /** Owning session id, denormalized onto the event row's `session_id` column so
   *  `events:search --session <sessionId>` surfaces every tree a session owns. */
  sessionId: string;
  /** The workflow whose agent this conversation is (`StorageOptions.workflowId`). */
  workflowId?: string;
  now?: () => string;
  /** Borrowed owner-supplied store; the handle never closes it. */
  store: AsyncEventStateReadSurface;
  writer?: AsyncEventWriter;
}

export async function createConversationTree(options: OpenConversationTreeOptions): Promise<ConversationTree> {
  const storage = await ConversationTreeStorage.create(options);
  return new ConversationTree(storage);
}


/** Open a conversation tree, returning null when no tree has been written yet
 *  for this conversationId. Corruption (malformed event payloads, schema
 *  mismatches) propagates as an exception. */
export async function tryOpenConversationTree(options: OpenConversationTreeOptions): Promise<ConversationTree | null> {
  const storage = await ConversationTreeStorage.tryOpen(options);
  return storage ? new ConversationTree(storage) : null;
}


/** Read the selected branch for transcript display, including safe degraded notices. */
export async function readTranscript(options: Omit<OpenConversationTreeOptions, "writer">): Promise<ConversationTreeTranscriptEntry[] | null> {
  const tree = await tryOpenConversationTree(options);
  if (!tree) return null;
  try {
    return await tree.getStorage().getTranscriptToRoot(await tree.getLeafId());
  } finally {
    tree.getStorage().dispose();
  }
}

/** Reconcile the branch, then read it. The name carries Reconciled
 *  deliberately: unlike a plain read, this call may append a fact - a tool
 *  result the crashed turn never recorded - before returning. */
export async function readReconciledBranch(
  options: OpenConversationTreeOptions & { writer: AsyncEventWriter; projectRoot: string; protectedToolUseIds?: ReadonlySet<string> },
): Promise<ConversationEntry[] | null> {
  const tree = await tryOpenConversationTree(options);
  if (!tree) return null;
  try {
    await reconcileConversationTree(tree, options);
    return await tree.getBranch();
  } finally {
    tree.getStorage().dispose();
  }
}

/** Reconcile crash-surviving entries and read the degraded-aware transcript from
 *  the same refreshed storage handle. The handle is disposed exactly once. */
export async function readReconciledTranscript(
  options: OpenConversationTreeOptions & { writer: AsyncEventWriter; projectRoot: string; protectedToolUseIds?: ReadonlySet<string> },
): Promise<ConversationTreeTranscriptEntry[] | null> {
  const tree = await tryOpenConversationTree(options);
  if (!tree) return null;
  try {
    await reconcileConversationTree(tree, options);
    return await tree.getStorage().getTranscriptToRoot(await tree.getLeafId());
  } finally {
    tree.getStorage().dispose();
  }
}

async function reconcileConversationTree(
  tree: ConversationTree,
  options: { readonly sessionId: string; readonly projectRoot: string; readonly protectedToolUseIds?: ReadonlySet<string> },
): Promise<void> {
  if (!isSessionOwnerGone(options.sessionId, options.projectRoot)) return;
  // An interrupted turn is reported at context-build time from the facts its
  // actions already wrote, so reconciliation no longer promotes a chain into
  // the branch. Deriving instead of adopting is what removes the cross-process
  // adoption race this function used to arbitrate.
  await persistDanglingToolResults(tree, options.protectedToolUseIds);
}


/** Crash repair, persisted: a process that died between save points can leave
 *  the durable branch ending in an assistant message whose tool_use blocks
 *  never received results. Append the interrupted tombstones once at adoption
 *  time so the durable record reflects reality, instead of every reader
 *  re-repairing the same gap in memory forever. Runs only when the owning
 *  process is proven gone: a live owner's in-flight results must not be raced. */
async function persistDanglingToolResults(tree: ConversationTree, protectedToolUseIds?: ReadonlySet<string>): Promise<void> {
  const dangling = trailingUnansweredToolUses(await tree.getBranch());
  const repairable = dangling.filter((use) => !protectedToolUseIds?.has(use.id));
  if (repairable.length === 0) return;
  const tombstones: ConversationMessage[] = repairable.map((use) => interruptedToolResult(use));
  const outcome = await tree.appendMessages(tombstones);
  if (outcome.kind === "notCommitted") {
    // A concurrent ownerless reader may have repaired first; re-read and
    // require the gap to be closed before treating the race as benign.
    const remaining = trailingUnansweredToolUses(await tree.getBranch())
      .filter((use) => !protectedToolUseIds?.has(use.id));
    if (remaining.length > 0) throw outcome.cause;
  }
}

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

/** Unanswered tool_use blocks on the branch's trailing assistant message.
 *  Only the tail is durably repairable: results must immediately follow their
 *  assistant message, so an append can close the gap only there. */
function trailingUnansweredToolUses(entries: readonly ConversationEntry[]): ToolUseBlock[] {
  const answered = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "message") continue;
    const message = entry.message;
    if (message.kind === "toolResult") {
      answered.add(message.toolUseId);
      continue;
    }
    if (message.kind === "assistant" && Array.isArray(message.content)) {
      return message.content.filter(
        (block): block is ToolUseBlock => block.type === "tool_use" && !answered.has(block.id),
      );
    }
    return [];
  }
  return [];
}

export async function durableBranchHasUserMessage(options: OpenConversationTreeOptions): Promise<boolean> {
  const tree = await tryOpenConversationTree(options);
  if (!tree) return false;
  try {
    return branchHasUserMessage(tree.getStorage().openedState());
  } finally {
    tree.getStorage().dispose();
  }
}

/** Does the current branch contain any user turn? Walks the immutable parent
 *  chain from the leaf over the already-loaded projection snapshot, returning as
 *  soon as it sees a user message. The snapshot is taken once at the call site
 *  (`tree.getState()`), so the walk is pure in-memory pointer-chasing - a deep
 *  branch costs no per-hop SQLite round-trip, and an early hit near the leaf stops
 *  short of the root. This is the durable authority for tombstone decisions: a
 *  committed user turn is visible here even when no in-memory cache remembers it. */
function branchHasUserMessage(state: Pick<ConversationTreeProjectionState, "leafId" | "entriesById">): boolean {
  let currentId = state.leafId;
  while (currentId !== null) {
    const entry = state.entriesById[currentId];
    if (!entry) {
      throw new InvariantViolation({
        kind: "missing-producer-event",
        eventType: "chat.branch.read",
        eventPosition: -1,
        aggregateId: state.leafId ?? "",
        detail: `active branch references missing entry ${currentId}`,
      });
    }
    if (entry.kind === "message" && entry.message.kind === "user") return true;
    currentId = entry.parentId;
  }
  return false;
}
