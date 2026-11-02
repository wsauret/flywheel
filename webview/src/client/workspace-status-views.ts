import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createHeldView } from "../../../src/protocol/client/held-view.js"
import { gitAiAttributionCursor, type GitAiAttributionStatus } from "../../../src/protocol/git-ai-attribution-protocol-types.js"
import { updatesCursor, type UpdateStatusView } from "../../../src/protocol/update-protocol-types.js"

/** The workspace status views that read themselves: each one holds its own
 *  cursor, reads its snapshot, and adopts its own patches, so the session
 *  routes no patch of these domains anywhere else. */
export interface WorkspaceStatusViews {
  /** The runtime's update view (ARCH-PROTOCOL-043), or undefined before the first read. */
  readonly update: UpdateStatusView | undefined
  /** Whether Git AI attribution can record in this runtime, or undefined
   *  before the first read. */
  readonly gitAiAttribution: GitAiAttributionStatus | undefined
  dispose(): void
}

/** The workspace domains these views own. */
export const WORKSPACE_STATUS_DOMAINS: ReadonlySet<string> = new Set([updatesCursor().domain, gitAiAttributionCursor().domain])

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
  return {
    get update() { return updates.view },
    get gitAiAttribution() { return gitAiAttribution.view },
    dispose() {
      updates.dispose()
      gitAiAttribution.dispose()
    },
  }
}
