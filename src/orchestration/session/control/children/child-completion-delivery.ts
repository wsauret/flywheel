import type { AsyncEventStateReadSurface, InFlightRecord } from "../../../../infra/event-store-types.js"
import { completionWorkIds } from "../../../agent-runtime/background-work-notifications.js"
import { liveSessionControl } from "../live-session-control.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, decodeQueuedBackgroundNotification, type HeldBackgroundNotification } from "../../conversation/queued-background-notifications.js"
import { retryChildResults } from "./child-reconciliation-fault.js"

interface CompletionDeliveryInput {
  readonly parentSessionId: string
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly deliverNotification?: (notification: HeldBackgroundNotification) => Promise<boolean>
}

/** Every live completion enters the parent's registry, never its raw notice
 *  queue. A registry that takes it commits it into the parent conversation
 *  later, and only a sweep that reads that commit records the child's end
 *  durable, so `sweepAfterCommit` runs once the commit lands. Only a workflow
 *  completion needs it, because the workflow's runner waits for that sweep to
 *  acknowledge its end; a subagent completion retires its runs in the
 *  registry at the commit. Only a receipt that the registry owns settles on
 *  a commit: a sink that gives no receipt settles it at once and leaves the
 *  hold, so a sweep after it would offer the hold again without end, starving
 *  the process. The sweep is the parent's fault-noticed reconciliation, which
 *  reports and reschedules its own failure through `retryChildResults`, so
 *  its rejection here needs no other handling. */
export async function offerChildCompletion(input: CompletionDeliveryInput, notification: HeldBackgroundNotification, sweepAfterCommit?: () => Promise<void>): Promise<boolean> {
  const control = liveSessionControl(input.reader, input.parentSessionId)
  const registry = control?.backgroundTasks ?? control?.child?.backgroundTasks ?? control?.member?.backgroundTasks
  const { key } = notification
  const ids = key === undefined ? [] : completionWorkIds(key)
  if (registry && key !== undefined && ids.length > 0) {
    if (await control?.state() === "handing_off") return false
    const committed = registry.deliverDurableSubagentNotification({ ...notification, completionRunIds: ids })
    if (!committed) return false
    if (sweepAfterCommit && registry.ownsNotification(key)) void committed.then(sweepAfterCommit).catch(() => {})
    return true
  }
  return await input.deliverNotification?.(notification) || await control?.notify(notification) || false
}

/** Reoffers the holds that the sweep read before its passes, `previous`, and
 * that no live receipt owner holds. Only a sweep whose passes wrote or offered
 * a hold since (`passesWrote`) reads the holds again, and only an offer here
 * reads them once more. Failed and ownerless results remain the project's
 * recovery responsibility across runner replacement. Returns the keys still
 * held. */
export async function reofferChildCompletions(input: CompletionDeliveryInput, previous: readonly InFlightRecord[], passesWrote: boolean, retry: () => Promise<void>): Promise<ReadonlySet<string>> {
  const reader = input.projectionReader
  const read = () => reader.readInFlight(input.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
  const previousKeys = new Set(previous.map(({ key }) => key))
  const held = passesWrote ? await read() : previous
  const control = liveSessionControl(input.reader, input.parentSessionId)
  const registry = control?.backgroundTasks ?? control?.child?.backgroundTasks ?? control?.member?.backgroundTasks
  if (!input.deliverNotification && !control) return new Set(held.map(({ key }) => key))
  let offered = false
  for (const row of held) {
    if (!previousKeys.has(row.key) || registry?.ownsNotification(row.key)) continue
    const conversationId = row.payload.conversationId
    if (typeof conversationId !== "string") continue
    const notification = decodeQueuedBackgroundNotification(row, conversationId)
    if (!notification) continue
    offered = true
    await offerChildCompletion(input, notification, retry)
  }
  const remaining = offered ? await read() : held
  if (remaining.some(({ key }) => !registry?.ownsNotification(key))) retryChildResults(input.reader, input.parentSessionId, retry)
  return new Set(remaining.map(({ key }) => key))
}
