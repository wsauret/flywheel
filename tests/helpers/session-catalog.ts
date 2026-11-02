import type { AttachedRuntimeClient, FrontendEvent, RuntimeChatDefault, RuntimeExecutorState, RuntimeServiceState, SessionCatalogError, SessionCatalogRow } from "../../src/protocol/app-service-types.js"
import { createRuntimeUiPatchSequencer } from "../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { readyCatalogRow as completeCatalogRow } from "../../src/orchestration/session/session-catalog-row.js"
import type { RuntimeUiSnapshot } from "../../src/protocol/runtime-ui-protocol-types.js"
import { fakeLanes, LANE_BREAK } from "./fake-lanes.js"
import { runtimeQuery } from "./runtime-dispatch.js"

export function catalogRow(id: string, title: string): Extract<SessionCatalogRow, { kind: "chat" }> {
  return {
    id,
    kind: "chat",
    title,
    lifecycleState: "active",
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: "2026-01-01T00:00:00.000Z",
    executionCwd: "/workspace",
    totalsLoading: true,
  }
}

type ReadyCatalogRow = Extract<SessionCatalogRow, { readonly kind: "chat"; readonly totalsLoading: false }>
type ReadyCatalogOverrides = Partial<Pick<ReadyCatalogRow, "totalCost" | "totalBilledCost" | "priceUnavailable" | "totalTokens" | "contextPercent" | "contextPromptTokens" | "durationMs" | "diffStats">> & Pick<Partial<ReadyCatalogRow>, "shortTitle">

export function readyCatalogRow(id: string, title: string, overrides: ReadyCatalogOverrides = {}): ReadyCatalogRow {
  const { shortTitle, ...totals } = overrides
  return completeCatalogRow({
    ...catalogRow(id, title),
    ...(shortTitle !== undefined ? { shortTitle } : {}),
  }, {
    totalCost: 1.25,
    totalBilledCost: 0.5,
    priceUnavailable: false,
    totalTokens: 500,
    contextPercent: 12,
    contextPromptTokens: 300,
    durationMs: 9000,
    ...totals,
  })
}

/** A minimal app-service stand-in: real sequencer for correct positions, a controllable snapshot, a lane open from the start, and a single subscriber whose patches we drive. */
export function fakeAppService(
  initial: SessionCatalogRow[],
  initialErrors: SessionCatalogError[] = [],
  initialChatDefault: RuntimeChatDefault = { kind: "none" },
) {
  const sequencer = createRuntimeUiPatchSequencer()
  let sessions = initial
  let errors = initialErrors
  let chatDefault = initialChatDefault
  let executor: RuntimeExecutorState = { kind: "serving" }
  let serviceState: RuntimeServiceState = { kind: "serving" }
  let listener: ((event: FrontendEvent) => void) | null = null
  let identity: { runtimeVersion: string; runtimeBuildId: string | null } = { runtimeVersion: "test", runtimeBuildId: null }
  let snapshotCalls = 0
  const lanes = fakeLanes()

  const snapshot = async (): Promise<RuntimeUiSnapshot> => {
    snapshotCalls += 1
    return {
      rows: sessions,
      activeRuntimeCount: sessions.length,
      errors,
      snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] }),
      projectRoot: "/workspace",
      runtimeVersion: identity.runtimeVersion,
      runtimeBuildId: identity.runtimeBuildId,
      chatDefault,
      executor,
      service: serviceState,
    }
  }

  const service = {
    query: runtimeQuery({ snapshot }),
    subscribe: (l: (event: FrontendEvent) => void) => {
      listener = l
      return () => { listener = null }
    },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">

  return {
    service,
    snapshotCalls: () => snapshotCalls,
    setSessions: (next: SessionCatalogRow[]) => { sessions = next },
    setErrors: (next: SessionCatalogError[]) => { errors = next },
    setChatDefault: (next: RuntimeChatDefault) => { chatDefault = next },
    setRuntimeIdentity: (next: { runtimeVersion: string; runtimeBuildId: string | null }) => { identity = next },
    setExecutor: (next: RuntimeExecutorState) => { executor = next },
    changeExecutor: (next: RuntimeExecutorState) => {
      executor = next
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: { scope: "workspace", domain: "executor" }, payload: { kind: "executor.changed", executor: next } }) })
    },
    changeService: (next: RuntimeServiceState) => {
      serviceState = next
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: { scope: "workspace", domain: "service" }, payload: { kind: "service.changed", service: next } }) })
    },
    changeChatDefault: (next: RuntimeChatDefault) => {
      chatDefault = next
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: { scope: "workspace", domain: "chat_default" }, payload: { kind: "chat_default.changed", chatDefault: next } }) })
    },
    skipThenChangeChatDefault: (next: RuntimeChatDefault) => {
      chatDefault = next
      const cursor = { scope: "workspace", domain: "chat_default" } as const
      sequencer.publish({ cursor, payload: { kind: "chat_default.changed", chatDefault: next } })
      listener?.({ type: "patch", patch: sequencer.publish({ cursor, payload: { kind: "chat_default.changed", chatDefault: next } }) })
    },
    update: (row: SessionCatalogRow) => {
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: { scope: "session", domain: "session", sessionId: row.id }, payload: { kind: "session.updated", row } }) })
    },
    add: (row: SessionCatalogRow) => {
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: { scope: "session", domain: "session", sessionId: row.id }, payload: { kind: "session.added", row } }) })
    },
    remove: (sessionId: string) => {
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: { scope: "session", domain: "session", sessionId }, payload: { kind: "session.removed" } }) })
    },
    skipThenUpdate: (row: SessionCatalogRow) => {
      const cursor = { scope: "session", domain: "session", sessionId: row.id } as const
      sequencer.publish({ cursor, payload: { kind: "session.updated", row } })
      listener?.({ type: "patch", patch: sequencer.publish({ cursor, payload: { kind: "session.updated", row } }) })
    },
    /** The lane breaks and the next one opens, without re-subscribing: forces the client to resnapshot. */
    reconnect: () => {
      lanes.end()
      listener?.(LANE_BREAK)
      lanes.open()
    },
    isSubscribed: () => listener !== null,
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

export function snapshotResult(rows: SessionCatalogRow[], snapshotPosition: number): RuntimeUiSnapshot {
  return {
    rows,
    activeRuntimeCount: rows.length,
    errors: [],
    snapshotPosition,
    projectRoot: "/workspace",
    runtimeVersion: "test",
    runtimeBuildId: null,
    chatDefault: { kind: "pending" },
    executor: { kind: "serving" },
    service: { kind: "serving" },
  }
}

export const awaitSnapshot = (): Promise<void> => Bun.sleep(1)
