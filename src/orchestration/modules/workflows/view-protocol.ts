import { isDeepStrictEqual } from "node:util"
import type { AsyncEventStateReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { recordBackgroundFailure } from "../../../infra/operation-log.js"
import { containSessionReads } from "../../../infra/session-read-containment.js"
import { createReplayingWorkflowView, type LiveWorkflowView } from "../../../workflows/view/view-projection.js"
import type { WorkflowView } from "../../../workflows/view/types.js"
import { frontendAttempts, readWorkflowRunRecords } from "../../workflow-host/frontend-attempts.js"
import type { FrontendWorkflowView } from "../../../protocol/workflow-view-protocol-types.js"
import { workflowViewCursor } from "../../../protocol/modules/workflows.js"
import type { RuntimeUiPatchInput } from "../../../protocol/runtime-ui-protocol-types.js"
import { workflowMembershipReader } from "../../session/workflow-membership.js"
import { workflowRunReader } from "../../module-catalog.js"

export interface WorkflowViewProtocolProjection {
  snapshot(workflowId: string): Promise<FrontendWorkflowView | null>
  settled(): Promise<void>
  dispose(): void
}
export interface WorkflowViewProtocolProjectionDeps {
  readonly reader: AsyncEventStateReadSurface
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => void
}
const log = Log.create({ service: "workflow-view-protocol" })
const UNAVAILABLE_VIEW: FrontendWorkflowView = { attempts: [], attemptsStatus: "unavailable" }

/** One incremental durable view per inspected aggregate. Streaming session changes do not replay workflow control. */
export function createWorkflowViewProtocolProjection(deps: WorkflowViewProtocolProjectionDeps): WorkflowViewProtocolProjection {
  const read = createWorkflowViewProtocolReader(deps.reader)
  const held = new Map<string, FrontendWorkflowView | null>()
  let pending = Promise.resolve()
  let disposed = false
  const unsubscribe = deps.onStored((events) => {
    const ids = new Set(events.flatMap((event) => event.aggregateId.startsWith("workflow:")
      ? [event.aggregateId.slice("workflow:".length)]
      : event.type === "session.created" || event.type === "session.deleted" ? [...held.keys()] : []))
    pending = pending.then(async () => {
      for (const workflowId of ids) {
        if (disposed || !held.has(workflowId)) continue
        const next = await read(workflowId)
        if (isDeepStrictEqual(held.get(workflowId), next)) continue
        held.set(workflowId, next)
        deps.publish({
          cursor: workflowViewCursor(workflowId),
          payload: next ? { kind: "workflow_view.updated", workflowView: next } : { kind: "workflow_view.removed" },
        })
      }
    }).catch((error: unknown) => recordBackgroundFailure(log, "publish workflow view", { workflows: ids.size }, error))
  })
  return {
    async snapshot(workflowId) {
      await pending
      const next = await read(workflowId)
      held.set(workflowId, next)
      return next
    },
    settled: () => pending,
    dispose() { disposed = true; unsubscribe(); held.clear() },
  }
}

async function loadedView(reader: AsyncEventStateReadSurface, workflowId: string, queue: WorkflowView, records: Awaited<ReturnType<typeof readWorkflowRunRecords>>): Promise<FrontendWorkflowView> {
  const members = await workflowMembershipReader(reader).list(workflowId)
  const followUp = members.find(({ membership }) => membership.kind === "historical-follow-up")
  return {
    attempts: frontendAttempts(queue, records?.personas, members),
    attemptsStatus: "loaded", state: queue.status, tree: queue.tree,
    ...(followUp ? { followUp: true, followUpSessionId: followUp.sessionId } : {}),
    ...(records ? { name: records.name } : {}),
  }
}

/** Repeated sweeps reuse the registered queue projection and read only its appended suffix. */
export function createWorkflowViewProtocolReader(reader: AsyncEventStateReadSurface): (workflowId: string) => Promise<FrontendWorkflowView | null> {
  const views = new Map<string, LiveWorkflowView>()
  const records = new Map<string, { readonly head: number; readonly value: Awaited<ReturnType<typeof readWorkflowRunRecords>> }>()
  const runs = workflowRunReader(reader)
  const reads = containSessionReads(log, "read workflow view")
  return (workflowId) => reads.read(workflowId, async () => {
    if (!await runs.read(workflowId)) return null
    let view = views.get(workflowId)
    if (!view) {
      view = createReplayingWorkflowView(reader, workflowId)
      views.set(workflowId, view)
    }
    const queue = await view.read()
    if (!queue) return UNAVAILABLE_VIEW
    const head = await reader.aggregateSeq(`workflow:${workflowId}`)
    const prior = records.get(workflowId)
    const value = prior?.head === head ? prior.value : await readWorkflowRunRecords(reader, workflowId)
    records.set(workflowId, { head, value })
    return loadedView(reader, workflowId, queue, value)
  }, UNAVAILABLE_VIEW)
}
