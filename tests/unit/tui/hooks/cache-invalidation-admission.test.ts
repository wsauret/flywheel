import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent, RuntimeQuery } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeCursorIdentity } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createAuthStatusCache } from "../../../../src/tui/hooks/create-auth-status-cache.js"
import { createRuntimeConfigCache, createShellState } from "../../../../src/tui/hooks/shell-state.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"

const workspaceBindings = [
  ["auth", "authStatusSnapshot"],
  ["mcp", "mcpStatusSnapshot"],
  ["commands", "commandCatalog"],
  ["updates", "updateSnapshot"],
  ["modules", "moduleSnapshot"],
  ["definitionStaleness", "definitionStalenessSnapshot"],
  ["papercuts", "papercutCountSnapshot"],
  ["remote", "remoteSnapshot"],
  ["project_notifications", "projectNotificationSnapshot"],
  ["config", "configSnapshot"],
  ["gitAiAttribution", "gitAiAttributionSnapshot"],
  ["git", "gitSnapshot"],
  ["commandUsage", "commandUsageSnapshot"],
] as const

function client() {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const queries: RuntimeQuery[] = []
  // No lane opens, so only an invalidation can start a read.
  const appService: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane" | "watchOutput"> = {
    ...fakeLanes({ open: false }).client,
    query(request) {
      queries.push(request)
      return new Promise<never>(() => {})
    },
    dispatch() { throw new Error("No mutation expected") },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  function invalidate(cursor: RuntimeCursorIdentity): void {
    for (const listener of listeners) listener({
      type: "patch",
      patch: { cursor, position: 2, prevPosition: 1, payload: { kind: "runtime.invalidate", reason: "overflow" } },
    })
  }
  return { appService, queries, invalidate }
}

for (const [domain, queryType] of workspaceBindings) {
  test(`${domain} admits its invalidation into snapshot recovery, not its payload reducer`, () => {
    createRoot((dispose) => {
      const h = client()
      const runtimeConfig = createRuntimeConfigCache({ appService: h.appService })
      createShellState({
        appService: h.appService, runtimeConfig, now: () => 0, projectRoot: "/project",
        setTerminalTitle: () => {}, showToast: () => {},
      })
      try {
        expect(h.queries).toEqual([])
        h.invalidate({ scope: "workspace", domain })
        expect(h.queries.map((query) => query.type)).toEqual([queryType])
      } finally {
        dispose()
      }
    })
  })
}

test("scoped auth admits only the selected cursor, including invalidations", () => {
  createRoot((dispose) => {
    const h = client()
    const cache = createAuthStatusCache({ appService: h.appService, foregroundId: () => "selected" })
    try {
      h.invalidate({ scope: "workspace", domain: "auth" })
      h.invalidate({ scope: "session", domain: "auth", sessionId: "other" })
      h.invalidate({ scope: "workspace", domain: "remote" })
      expect(h.queries).toEqual([])
      h.invalidate({ scope: "session", domain: "auth", sessionId: "selected" })
      expect(h.queries).toEqual([{ type: "authStatusSnapshot", scope: { kind: "session", sessionId: "selected" } }])
      expect(cache.view()).toBeUndefined()
    } finally {
      dispose()
    }
  })
})
