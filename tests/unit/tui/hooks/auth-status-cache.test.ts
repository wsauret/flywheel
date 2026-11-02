import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { authStatusCursor, type RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createAuthStatusCache } from "../../../../src/tui/hooks/create-auth-status-cache.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

function view(id: string): RuntimeAuthView {
  return {
    providers: [],
    warnings: [],
    authFilePath: `/profiles/${id}/auth.json`,
    profile: { id, displayName: id, source: "default", availableProfiles: [{ id, displayName: id }] },
    subscriptionSpendConsent: { kind: "available", profileId: id, usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
  }
}

function fakeAppService() {
  const sequencer = createRuntimeUiPatchSequencer()
  const snapshots = new Map<string, RuntimeAuthView>([["defaults", view("default")], ["session:session-1", view("session")]])
  const queries: string[] = []
  let listener: ((event: FrontendEvent) => void) | undefined
  const lanes = fakeLanes()
  const query = runtimeQuery({
    authStatusSnapshot: async ({ scope }) => {
      const key = scope.kind === "defaults" ? "defaults" : `session:${scope.sessionId}`
      queries.push(key)
      const cursor = authStatusCursor(scope)
      return { snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor }), auth: snapshots.get(key) ?? view("missing") }
    },
  })
  const service = {
    query,
    subscribe(next: (event: FrontendEvent) => void): () => void {
      listener = next
      return () => { listener = undefined }
    },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  return {
    service,
    queries,
    emit(scope: { readonly kind: "defaults" } | { readonly kind: "session"; readonly sessionId: string }, id: string): void {
      const patch = sequencer.publish({ cursor: authStatusCursor(scope), payload: { kind: "auth.changed", auth: view(id) } })
      listener?.({ type: "patch", patch })
    },
  }
}

describe("createAuthStatusCache", () => {
  test("switches to the foreground session and rejects stale default patches", async () => {
    await createRoot(async (dispose) => {
      const [foregroundId, setForegroundId] = createSignal<string | undefined>()
      const fake = fakeAppService()
      const cache = createAuthStatusCache({ appService: fake.service, foregroundId })
      await Promise.resolve()
      expect(cache.view()?.profile.id).toBe("default")
      setForegroundId("session-1")
      await Promise.resolve()
      await Promise.resolve()
      expect(cache.view()?.profile.id).toBe("session")
      fake.emit({ kind: "defaults" }, "default-new")
      expect(cache.view()?.profile.id).toBe("session")
      fake.emit({ kind: "session", sessionId: "session-1" }, "session-new")
      expect(cache.view()?.profile.id).toBe("session-new")
      expect(fake.queries).toEqual(["defaults", "session:session-1"])
      dispose()
    })
  })
})
