import { MODULE_DOMAIN_BINDINGS } from "../../../../src/protocol/client/module-domain.js"
import type { RuntimeConnection } from "../../../../src/protocol/client/connection.js"
import type { WorkflowDetail } from "../../../../src/protocol/modules/workflows.js"
import type { FrontendWorkflowView, WorkflowAgentLive, WorkflowLiveView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { workflowSurfaceReads, type WorkflowSurface } from "../../../../src/protocol/client/workflow-surface.js"
import { createModuleDomainMonitor, type ModuleDomainMonitor } from "../../client/module-domain-monitor.js"

export interface WorkflowReading {
  readonly detail: WorkflowDetail | undefined
  readonly view: FrontendWorkflowView | undefined
  readonly live: readonly WorkflowAgentLive[]
}

/** Releases a resident subscriber, or changes its read demand without losing loaded values. */
export interface WorkflowInspectionSubscription {
  (): void
  update(surface: WorkflowSurface): void
}

/** Passive, ref-counted workflow cursors never acquire session residence. */
export function createWorkflowInspections(connection: Pick<RuntimeConnection, "query" | "subscribe" | "onLane">) {
  function createEntry(workflowId: string) {
    const subscribers = new Set<{ notify: (reading: WorkflowReading) => void; surface: WorkflowSurface }>()
    const options = { connection, ownerId: workflowId }
    let reading: WorkflowReading = { detail: undefined, view: undefined, live: [] }
    let detail: ModuleDomainMonitor<WorkflowDetail> | undefined
    let view: ModuleDomainMonitor<FrontendWorkflowView> | undefined
    let live: ModuleDomainMonitor<WorkflowLiveView> | undefined
    const publish = (domain: "detail" | "view" | "live") => {
      reading = {
        detail: domain === "detail" ? detail?.view ?? undefined : reading.detail,
        view: domain === "view" ? view?.view ?? undefined : reading.view,
        live: domain === "live" ? live?.view?.agents ?? [] : reading.live,
      }
      reconcile()
      for (const subscriber of subscribers) subscriber.notify(reading)
    }
    function reconcile() {
      const demand = [...subscribers].map(({ surface }) => workflowSurfaceReads(surface))
      if (demand.some(reads => reads.detail)) {
        if (!detail) { detail = createModuleDomainMonitor({ ...options, binding: MODULE_DOMAIN_BINDINGS.workflow_detail }); detail.onChange(() => publish("detail")) }
      } else { detail?.dispose(); detail = undefined }
      if (demand.some(reads => reads.view)) {
        if (!view) { view = createModuleDomainMonitor({ ...options, binding: MODULE_DOMAIN_BINDINGS.workflow_view }); view.onChange(() => publish("view")) }
      } else { view?.dispose(); view = undefined }
      if (demand.some(reads => reads.live)) {
        if (!live) { live = createModuleDomainMonitor({ ...options, binding: MODULE_DOMAIN_BINDINGS.workflow_live }); live.onChange(() => publish("live")) }
      } else { live?.dispose(); live = undefined }
    }
    return {
      subscribers,
      read: () => reading,
      reconcile,
      dispose() { detail?.dispose(); view?.dispose(); live?.dispose() },
    }
  }
  const entries = new Map<string, ReturnType<typeof createEntry>>()
  return {
    subscribe(workflowId: string, listener: (reading: WorkflowReading) => void, surface: WorkflowSurface = { kind: "page" }): WorkflowInspectionSubscription {
      let entry = entries.get(workflowId)
      if (!entry) {
        entry = createEntry(workflowId)
        entries.set(workflowId, entry)
      }
      const subscriber = { notify: listener, surface }
      entry.subscribers.add(subscriber)
      entry.reconcile()
      listener(entry.read())
      const release = () => {
        entry.subscribers.delete(subscriber)
        if (entry.subscribers.size !== 0) { entry.reconcile(); return }
        entry.dispose()
        entries.delete(workflowId)
      }
      return Object.assign(release, {
        update(next: WorkflowSurface) {
          subscriber.surface = next
          entry.reconcile()
          listener(entry.read())
        },
      })
    },
    dispose() {
      for (const entry of entries.values()) entry.dispose()
      entries.clear()
    },
  }
}
