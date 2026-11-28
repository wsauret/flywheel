import type { RuntimeConnection } from "../../../../../src/protocol/client/runtime/connection.js"
import { createHeldView } from "../../../../../src/protocol/client/runtime/held-view.js"
import { gitAiAttributionCursor, type GitAiAttributionStatus } from "../../../../../src/protocol/git/git-ai-attribution-protocol-types.js"
import { updatesCursor, type UpdateStatusView } from "../../../../../src/protocol/runtime/update-protocol-types.js"
import { waitingSessionsCursor, type WaitingSessionsView } from "../../../../../src/protocol/session/question-protocol-types.js"
import type { ListedTurns } from "../../../../../src/protocol/client/session/session-list-groups.js"
import { foldUnreadChatsPatch, unreadChatsCursor, type UnreadChatsView } from "../../../../../src/protocol/session/unread-protocol-types.js"

/** The workspace status views that read themselves: each one holds its own
 *  cursor, reads its snapshot, and adopts its own patches, so the session
 *  routes no patch of these domains anywhere else. */
export interface WorkspaceStatusViews {
  /** The runtime's update view (ARCH-PROTOCOL-043), or undefined before the first read. */
  readonly update: UpdateStatusView | undefined
  /** Whether Git AI attribution can record in this runtime, or undefined
   *  before the first read. */
  readonly gitAiAttribution: GitAiAttributionStatus | undefined
  /** Every session of the project that waits on a question, closed ones
   *  included (ARCH-PROTOCOL-068), with the time its docked question opened,
   *  or undefined before the first read. Every waiting mark of a listed row
   *  reads this set, never a question read for the row. */
  readonly waitingSessions: WaitingSessionsView | undefined
  /** The stopped chats the person has not read and the working chats with
   *  unread messages (ARCH-PROTOCOL-072), or undefined before the first read
   *  and from a runtime that refuses it. */
  readonly unreadChats: UnreadChatsView | undefined
  /** The latest turn times of `unreadChats`, or undefined while
   *  `unreadChats` is undefined. */
  readonly chatTurns: ListedTurns
  dispose(): void
}

/** The workspace domains these views own. */
export const WORKSPACE_STATUS_DOMAINS: ReadonlySet<string> = new Set([updatesCursor().domain, gitAiAttributionCursor().domain, waitingSessionsCursor().domain, unreadChatsCursor().domain])

export function createWorkspaceStatusViews(input: {
  readonly connection: RuntimeConnection
  readonly changed: () => void
}): WorkspaceStatusViews {
  const { connection } = input
  const updates = createHeldView<UpdateStatusView>({
    client: connection,
    cursor: updatesCursor(),
    read: async () => {
      const snapshot = await connection.query({ type: "updateSnapshot" })
      return { view: snapshot.update, position: snapshot.snapshotPosition }
    },
    adopt: (payload) => (payload.kind === "update.changed" ? payload.update : undefined),
    changed: input.changed,
    label: "update status",
  })
  const gitAiAttribution = createHeldView<GitAiAttributionStatus>({
    client: connection,
    cursor: gitAiAttributionCursor(),
    read: async () => {
      const snapshot = await connection.query({ type: "gitAiAttributionSnapshot" })
      return { view: snapshot.status, position: snapshot.snapshotPosition }
    },
    adopt: (payload) => (payload.kind === "gitAiAttribution.changed" ? payload.status : undefined),
    changed: input.changed,
    label: "Git AI attribution status",
  })
  // A patch of either set carries the whole set, so it replaces the held one without a read.
  const waiting = createHeldView<WaitingSessionsView>({
    client: connection,
    cursor: waitingSessionsCursor(),
    read: async () => {
      const snapshot = await connection.query({ type: "waitingSessionsSnapshot" })
      return { view: snapshot, position: snapshot.snapshotPosition }
    },
    adopt: (payload) => (payload.kind === "waitingSessions.changed" ? payload : undefined),
    changed: input.changed,
    label: "waiting sessions",
  })
  const unread = createHeldView<UnreadChatsView>({
    client: connection,
    cursor: unreadChatsCursor(),
    read: async () => {
      const snapshot = await connection.query({ type: "unreadChatsSnapshot" })
      return { view: snapshot, position: snapshot.snapshotPosition }
    },
    // A patch folds into the view that the snapshot read, which it follows.
    adopt: (payload, _position, current) => (payload.kind === "unreadChats.changed" && current !== undefined ? foldUnreadChatsPatch(current, payload) : undefined),
    changed: input.changed,
    label: "unread chats",
  })
  return {
    get update() { return updates.view },
    get gitAiAttribution() { return gitAiAttribution.view },
    get waitingSessions() { return waiting.view },
    get unreadChats() { return unread.view },
    get chatTurns() { return unread.view?.turns },
    dispose() {
      updates.dispose()
      gitAiAttribution.dispose()
      waiting.dispose()
      unread.dispose()
    },
  }
}
