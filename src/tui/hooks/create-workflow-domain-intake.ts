import { createSignal, onCleanup, untrack } from "solid-js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import type { ModuleDomainBinding, ModuleDomainSnapshot } from "../../protocol/client/module-domain.js"
import type { ProtocolModuleWorkflowDomain } from "../../protocol/modules.js"
import { runtimeSnapshotScopeKey } from "../../protocol/client/family-intake.js"
import type { RuntimeUiPatchPayload, RuntimeWorkflowCursorIdentity } from "../../protocol/runtime-ui-protocol-types.js"
import { createOrderedPatchReceiver } from "./create-ordered-patch-receiver.js"

/** Passive aggregate reads, independent of session activation and transcript holds. */
export interface WorkflowDomainIntake<View> {
  readonly scope: "workflow"
  retain(workflowId: string): { release(): void }
  view(workflowId: string): View | undefined
  workflowIds(): readonly string[]
}

export function createWorkflowDomainIntake<View>(
  binding: ModuleDomainBinding<ProtocolModuleWorkflowDomain, "workflow", RuntimeUiPatchPayload, View>,
  client: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">,
): WorkflowDomainIntake<View> {
  const [views, setViews] = createSignal<ReadonlyMap<string, View>>(new Map())
  const holds = new Map<string, number>()
  type Scope = { readonly kind: "cursor"; readonly cursor: RuntimeWorkflowCursorIdentity }
  const scope = (workflowId: string): Scope => ({ kind: "cursor", cursor: { scope: "workflow", domain: binding.domain, workflowId } })
  const write = (id: string, view: View | null): void => {
    setViews((prior) => { const next = new Map(prior); if (view === null) next.delete(id); else next.set(id, view); return next })
  }
  const receiver = createOrderedPatchReceiver<Scope, ModuleDomainSnapshot<View>>({
    client,
    scopeKey: runtimeSnapshotScopeKey,
    onConnected() { for (const id of holds.keys()) void receiver.resnapshot(scope(id)).catch(() => {}) },
    accept(patch) {
      if (patch.cursor.scope !== "workflow" || patch.cursor.domain !== binding.domain) return null
      if (!holds.has(patch.cursor.workflowId)) return null
      return patch.payload.kind === "runtime.invalidate" || binding.isPayload(patch.payload)
        ? { cursor: patch.cursor, scope: scope(patch.cursor.workflowId), patch } : null
    },
    loadSnapshot: (current) => binding.read(client, current.cursor.workflowId),
    applySnapshot(snapshot, current) {
      write(current.cursor.workflowId, snapshot.view)
      return { snapshotPosition: snapshot.snapshotPosition, cursors: [current.cursor] }
    },
    applyPayload(patch) {
      if (patch.cursor.scope !== "workflow" || !binding.isPayload(patch.payload)) return
      write(patch.cursor.workflowId, binding.payloadView(patch.payload, untrack(views).get(patch.cursor.workflowId)))
    },
  })
  onCleanup(() => { holds.clear() })
  return {
    scope: "workflow",
    retain(id) {
      const held = holds.get(id) ?? 0
      holds.set(id, held + 1)
      // The family intake owns retries: a lost lane reads every held id
      // again, and any other failure retries on its shared backoff.
      if (held === 0) void receiver.resnapshot(scope(id)).catch(() => {})
      let released = false
      return { release() {
        if (released) return
        released = true
        const count = (holds.get(id) ?? 1) - 1
        if (count > 0) { holds.set(id, count); return }
        holds.delete(id)
        receiver.cancelSnapshot(scope(id))
        receiver.release(scope(id).cursor)
        write(id, null)
      } }
    },
    view: (id) => views().get(id),
    workflowIds: () => [...views().keys()],
  }
}
