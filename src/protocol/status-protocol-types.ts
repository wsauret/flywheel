import { isActiveActivity, type FrontendConnectionState, type FrontendActivity } from "./app-service-types.js"
import type { RuntimePosition, RuntimeSessionCursorIdentity, RuntimeSessionViewsResult, RuntimeUiPatchPayload } from "./runtime-ui-protocol-types.js"

interface ActiveBackgroundCommandViewBase {
  readonly id: string
  readonly description: string
  readonly toolUseId: string
  readonly startedAtMs: number
}

export type ActiveBackgroundCommandView = ActiveBackgroundCommandViewBase & (
  | { readonly model: string; readonly effort?: string; readonly roleSessionId?: string }
  | { readonly model?: never; readonly effort?: never; readonly roleSessionId?: never }
)

/** One session that the session of a status waits on for a reply: its id
 *  and the name it shows to the person, so a client can name it without a
 *  row of its own. */
export interface ReplyWaitView {
  readonly sessionId: string
  readonly name: string
}

export interface StatusView {
  readonly activity: FrontendActivity
  /** Runtime-owned start of the displayed activity. Null when no runtime activity supplies a start, including synthetic replacement waiting. */
  readonly activityStartedAt: number | null
  /** A public output position, or an opaque requirement for a fresh authoritative
   * tail read by this client. Null means there is no settlement barrier. */
  readonly settledOutputPosition: RuntimePosition | { readonly recovery: string } | null
  readonly connectionState: FrontendConnectionState
  readonly activeSubagentCount: number
  readonly waitingOnBackgroundWork: boolean
  /** The sessions this session waits on for a reply, in the order its waits
   *  opened. A reply wait is background work, so it is no background command. */
  readonly replyWaits: readonly ReplyWaitView[]
  readonly activeBackgroundCommands: readonly ActiveBackgroundCommandView[]
  readonly activeForegroundBashToolCallIds: readonly string[]
  /** The tool call ids of this session's shell commands that processor
   *  admission holds, foreground and background (PI-AGENT-052). */
  readonly processorHeldToolCallIds: readonly string[]
  readonly startedAt: number
  readonly streamingStartedAt: number | null
  readonly accumulatedActiveMs: number
  readonly compactionStartedAt: number | null
}

/** Whether Flywheel still owes work for a session, as every surface's spinner reads
 *  it: the terminal's tab bar, the terminal's session picker, and the web
 *  client's session rows all take this one rule, so a session cannot spin in
 *  one place and rest in another. A session remains working while its runner
 *  is parked on background work, even when no model request is active. */
export function isWorkingStatus(
  status: Pick<StatusView, "activity" | "activeSubagentCount" | "waitingOnBackgroundWork"> | undefined,
): boolean {
  return isActiveActivity(status?.activity)
    || (status?.activeSubagentCount ?? 0) > 0
    || status?.waitingOnBackgroundWork === true
}

export type RuntimeStatusSnapshotResult = RuntimeSessionViewsResult<StatusView>

export type StatusPatchPayload =
  | { readonly kind: "status.updated"; readonly status: StatusView }
  | { readonly kind: "status.removed" }

export function statusCursor(sessionId: string): RuntimeSessionCursorIdentity & { readonly domain: "status" } {
  return { scope: "session", domain: "status", sessionId }
}

export function isStatusPayload(payload: RuntimeUiPatchPayload): payload is StatusPatchPayload {
  return payload.kind === "status.updated" || payload.kind === "status.removed"
}
