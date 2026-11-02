import { createEffect, createSignal, type Accessor } from "solid-js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { authStatusCursor, type AuthPatchPayload, type RuntimeAuthStatusScope, type RuntimeAuthStatusSnapshotResult, type RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { RuntimeUiPatch } from "../../protocol/runtime-ui-protocol-types.js"
import { cursorKey } from "../../protocol/runtime-ui-protocol-types.js"
import { runtimeSnapshotScopeKey } from "../../protocol/client/family-intake.js"
import { createOrderedPatchReceiver } from "./create-ordered-patch-receiver.js"

export interface AuthStatusCache {
  view(): RuntimeAuthView | undefined
}

/** Client intake for the one auth view selected by the foreground session. */
export function createAuthStatusCache(deps: {
  appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  foregroundId: Accessor<string | undefined>
}): AuthStatusCache {
  const [view, setView] = createSignal<RuntimeAuthView | undefined>()
  let activeScope = authScope(deps.foregroundId())
  const apply = setView
  const scopeFor = (scope: RuntimeAuthStatusScope) => ({ kind: "cursor" as const, cursor: authStatusCursor(scope) })
  const receiver = createOrderedPatchReceiver<ReturnType<typeof scopeFor>, RuntimeAuthStatusSnapshotResult, RuntimeUiPatch & { payload: AuthPatchPayload }>({
    client: deps.appService,
    connectedScope: () => scopeFor(activeScope),
    accept(patch) {
      const cursor = authStatusCursor(activeScope)
      if (cursorKey(patch.cursor) !== cursorKey(cursor)) return null
      if (patch.payload.kind === "runtime.invalidate") return { cursor, scope: scopeFor(activeScope) }
      return patch.payload.kind === "auth.changed"
        ? { cursor, scope: scopeFor(activeScope), patch: { ...patch, payload: patch.payload } }
        : null
    },
    scopeKey: runtimeSnapshotScopeKey,
    loadSnapshot: (scope) => deps.appService.query({ type: "authStatusSnapshot", scope: scopeFromCursor(scope.cursor) }),
    applySnapshot(snapshot, scope) {
      if (runtimeSnapshotScopeKey(scope) === runtimeSnapshotScopeKey(scopeFor(activeScope))) apply(snapshot.auth)
      return { snapshotPosition: snapshot.snapshotPosition, cursors: [scope.cursor] }
    },
    applyPayload(patch) {
      if (cursorKey(patch.cursor) === cursorKey(authStatusCursor(activeScope))) apply(patch.payload.auth)
    },
  })
  createEffect(() => {
    const nextScope = authScope(deps.foregroundId())
    const sameScope = nextScope.kind === "defaults" && activeScope.kind === "defaults"
      || nextScope.kind === "session" && activeScope.kind === "session" && nextScope.sessionId === activeScope.sessionId
    if (sameScope) return
    const previousScope = activeScope
    activeScope = nextScope
    setView(undefined)
    const previous = scopeFor(previousScope)
    receiver.cancelSnapshot(previous)
    receiver.release(previous.cursor)
    void receiver.resnapshot(scopeFor(nextScope))
  })
  return { view }
}

function authScope(sessionId: string | undefined): RuntimeAuthStatusScope {
  return sessionId === undefined ? { kind: "defaults" } : { kind: "session", sessionId }
}

function scopeFromCursor(cursor: ReturnType<typeof authStatusCursor>): RuntimeAuthStatusScope {
  return cursor.scope === "session" ? { kind: "session", sessionId: cursor.sessionId } : { kind: "defaults" }
}
