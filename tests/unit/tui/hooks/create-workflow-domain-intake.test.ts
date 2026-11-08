import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { MODULE_DOMAIN_BINDINGS } from "../../../../src/protocol/client/module-domain.js"
import { workflowViewCursor } from "../../../../src/protocol/modules/workflows.js"
import { RuntimeLaneLost } from "../../../../src/protocol/client/connection-failures.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createWorkflowDomainIntake } from "../../../../src/tui/hooks/create-workflow-domain-intake.js"
import type { FrontendWorkflowView, LoadedWorkflowView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { plainAgentTree } from "../../../helpers/workflow-view.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

function view(state: LoadedWorkflowView["state"]): LoadedWorkflowView {
  return { attempts: [], attemptsStatus: "loaded", state, tree: plainAgentTree([]) }
}
/** A fake runtime; `failFirst` rejects the first read with that error. */
function runtime(failFirst?: Error) {
  const sequencer = createRuntimeUiPatchSequencer()
  const views = new Map<string, FrontendWorkflowView>()
  const reads: string[] = []
  let failure = failFirst
  let listener: ((event: FrontendEvent) => void) | undefined
  const lanes = fakeLanes()
  const client = {
    query: runtimeQuery({ workflowViewSnapshot: async (request) => {
      reads.push(request.workflowId)
      if (failure) { const error = failure; failure = undefined; throw error }
      return { snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: workflowViewCursor(request.workflowId) }), view: views.get(request.workflowId) ?? null }
    } }),
    subscribe(next: (event: FrontendEvent) => void) { listener = next; return () => { listener = undefined } },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  return { client, views, reads, lanes, emit: (event: FrontendEvent) => listener?.(event),
    publish(workflowId: string, next: FrontendWorkflowView, miss = false) {
      views.set(workflowId, next)
      const patch = sequencer.publish({ cursor: workflowViewCursor(workflowId), payload: { kind: "workflow_view.updated", workflowView: next } })
      if (!miss) listener?.({ type: "patch", patch })
    },
  }
}

describe("workflow domain intake", () => {
  test("holds independent aggregate cursors, repairs a gap and refreshes a released reader", async () => {
    await createRoot(async (dispose) => {
      try {
        const f = runtime()
        f.views.set("a", view("running")); f.views.set("b", view("paused"))
        const cache = createWorkflowDomainIntake(MODULE_DOMAIN_BINDINGS.workflow_view, f.client)
        const a = cache.retain("a")
        cache.retain("b")
        await Bun.sleep(0)
        expect(cache.view("a")).toEqual(view("running"))
        expect(cache.view("b")).toEqual(view("paused"))
        f.publish("a", view("paused"), true)
        f.publish("a", view("completed"))
        await Bun.sleep(0)
        expect(cache.view("a")).toEqual(view("completed"))
        expect(cache.view("b")).toEqual(view("paused"))
        a.release()
        f.publish("a", view("failed"))
        cache.retain("a")
        await Bun.sleep(0)
        expect(cache.view("a")).toEqual(view("failed"))
      } finally { dispose() }
    })
  })
  test("an aggregate with no view is read once while held, without inventing a session", async () => {
    await createRoot(async (dispose) => {
      try {
        const f = runtime()
        const cache = createWorkflowDomainIntake(MODULE_DOMAIN_BINDINGS.workflow_view, f.client)
        const discovery = cache.retain("pending")
        const viewer = cache.retain("pending")
        await Bun.sleep(0)
        expect(cache.view("pending")).toBeUndefined()
        expect(f.reads).toEqual(["pending"])
        viewer.release()
        f.publish("pending", view("completed"))
        await Bun.sleep(0)
        expect(cache.view("pending")).toEqual(view("completed"))
        discovery.release()
      } finally { dispose() }
    })
  })
  test("a held workflow whose first read is lost with its lane reads again on the next lane and takes later patches", async () => {
    await createRoot(async (dispose) => {
      try {
        const f = runtime(new RuntimeLaneLost(new Error("lane dropped")))
        f.views.set("a", view("running"))
        const cache = createWorkflowDomainIntake(MODULE_DOMAIN_BINDINGS.workflow_view, f.client)
        cache.retain("a")
        await Bun.sleep(0)
        f.emit(LANE_BREAK); f.lanes.end(); f.lanes.open()
        await Bun.sleep(0)
        expect(cache.view("a")).toEqual(view("running"))
        expect(f.reads).toEqual(["a", "a"])
        f.publish("a", view("completed"))
        await Bun.sleep(0)
        expect(cache.view("a")).toEqual(view("completed"))
      } finally { dispose() }
    })
  })
})
