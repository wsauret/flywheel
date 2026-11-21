import type { GuardedEventStoreAppend } from "../../infra/event-store-types.js"
import { recordedExecutionCwd } from "./session-execution-directory.js"
import {
  buildSessionAuthProfileSelectedFact,
  buildSessionChildLinkedFact,
  buildSessionCreatedFact,
  buildSessionRolesSnapshottedFact,
} from "./session-metadata-facts.js"
import { buildSessionMetadataAppend } from "./session-metadata-store.js"
import type { ReplayedSession, Session } from "./schemas.js"
import { forkSessionTitles } from "./session-title.js"
import { parseConversationCheckpointFact, type ConversationCheckpoint } from "./conversation-checkpoint-facts.js"
import { conversationPromptFixedFact, type ConversationPromptBaseline } from "./conversation-prompt-baseline.js"

/** Prepares an inactive independent chat and its ancestry links. The caller
 * validates the destination conversation before atomically publishing these
 * facts; no source conversation or lifecycle is changed. The branch starts
 * with the source's `checkpoint` (ARCH-SESSIONS-042); a source without one
 * gives the branch none. It also starts with the source's fixed system prompt
 * (`promptBaseline`, ARCH-CONTEXT-044), so it sends the bytes that its source sent. */
export function prepareChatBranchPublication(input: {
  sourceSessionId: string
  source: Extract<ReplayedSession, { kind: "chat" }>
  checkpoint: ConversationCheckpoint | undefined
  promptBaseline: ConversationPromptBaseline | undefined
  targetSessionId: string
  targetConversationId: string
  projectRoot: string
  now: string
}): GuardedEventStoreAppend[] {
  const { sourceSessionId, source, checkpoint, promptBaseline, targetSessionId, targetConversationId, projectRoot, now } = input
  const titles = forkSessionTitles(source)
  const timestamp = Date.parse(now)
  const target: Session = {
    kind: "chat",
    command: "chat",
    conversationId: targetConversationId,
    label: titles.full,
    shortLabel: titles.short,
    name: titles.full,
    lifecycleState: "inactive",
    executionCwd: recordedExecutionCwd(source, projectRoot),
    lastUpdated: now,
    createdAt: now,
    launchedFrom: { parentSessionId: sourceSessionId },
    ...(source.authProfileId !== undefined ? { authProfileId: source.authProfileId } : {}),
  }
  return [
    { ...buildSessionMetadataAppend(targetSessionId, buildSessionCreatedFact(target), timestamp), expectedSeq: 0 },
    ...(source.authProfileId !== undefined
      ? [buildSessionMetadataAppend(targetSessionId, buildSessionAuthProfileSelectedFact(source.authProfileId), timestamp)]
      : []),
    ...(source.roleAssignments
      ? [buildSessionMetadataAppend(
          targetSessionId,
          buildSessionRolesSnapshottedFact(source.roleAssignments.defaults, now, source.roleAssignments.overrides),
          timestamp,
        )]
      : []),
    ...(checkpoint ? [{
      aggregateId: `session:${targetSessionId}`,
      sessionId: targetSessionId,
      timestamp,
      ...parseConversationCheckpointFact({ type: "conversation.checkpoint.updated", version: 1, actor: "flywheel", payload: { conversationId: targetConversationId, checkpoint } }),
    }] : []),
    ...(promptBaseline ? [{
      aggregateId: `session:${targetSessionId}`,
      sessionId: targetSessionId,
      timestamp,
      ...conversationPromptFixedFact(targetConversationId, promptBaseline),
    }] : []),
    buildSessionMetadataAppend(sourceSessionId, buildSessionChildLinkedFact(targetSessionId, now), timestamp),
  ]
}
