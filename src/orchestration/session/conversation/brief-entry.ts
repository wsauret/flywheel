import type { ConversationEntry } from "./conversation-entry-types.js"
import type { CommittedTree } from "./conversation-projection.js"

const BRIEF_ENTRY_PREFIX = "workflow-step-task:"

/** The entry id of an agent's brief in its conversation. The opening turn of
 *  a fresh attempt carries it, so a resume can tell whether the tree holds the
 *  brief, and the agent view opens with it. The stored prefix keeps its
 *  spelling from before the agent lexicon. */
export function briefEntryId(attemptId: string): string {
  return `${BRIEF_ENTRY_PREFIX}${attemptId}`
}

export function isBriefEntry(entryId: string): boolean {
  return entryId.startsWith(BRIEF_ENTRY_PREFIX)
}

function userText(entry: ConversationEntry | undefined): string | undefined {
  if (entry?.kind !== "message" || entry.message.kind !== "user") return undefined
  const { content } = entry.message
  return typeof content === "string" ? content : content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")
}

/** The text of the user message that the entry `entryId` holds, or
 *  undefined when the tree has no such entry. */
export function recordedEntryText(tree: CommittedTree, entryId: string): string | undefined {
  return userText(tree.entriesById[entryId])
}

/** The assignment that `parentSessionId` gave a child at launch. A forked
 *  child also holds the launch entries of its parent's history, which name
 *  other parents, so the parent identifies the child's own assignment. */
export function launchAssignmentText(tree: CommittedTree, parentSessionId: string): string | undefined {
  return userText(Object.values(tree.entriesById).find((entry) =>
    entry.kind === "message" && entry.message.kind === "user"
    && entry.message.producer?.kind === "launch" && entry.message.producer.sessionId === parentSessionId))
}
