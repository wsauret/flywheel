import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { FrontendEvent, FrontendMutation } from "../../../src/protocol/app-service-types.js"
import type { RuntimeAuthStatusSnapshotResult } from "../../../src/protocol/auth-status-protocol-types.js"
import type { NotificationActionView, ProjectNotificationEpisode, RuntimeProjectNotificationSnapshotResult } from "../../../src/protocol/modules/project-notifications.js"
import { runtimeDispatch, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"
import { createAuthNotificationCoordinator, notificationToast, type AuthNotificationCoordinatorDeps, type NotificationToast } from "./auth-notification-coordinator.js"

const authSnapshot = (position: number, operationId?: string): RuntimeAuthStatusSnapshotResult => ({
  snapshotPosition: position,
  auth: {
    providers: [], warnings: [],
    authFilePath: "/profiles/profile/auth.json",
    profile: { id: "profile", displayName: "Default", source: "default", availableProfiles: [] },
    subscriptionSpendConsent: { kind: "available", profileId: "profile", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1, accounts: [{ accountCorrelationId: "account", providerId: "chatgpt", providerDisplayName: "ChatGPT Subscription", providerStatus: "ok", modes: [{ mode: "automatic", envelopeId: "paid", decision: "unreviewed", evidence: { kind: "automatic-billing", enablement: "enabled" } }] }] },
    ...(operationId ? { settlement: { kind: "completed" as const, operationId, providerId: "chatgpt" } } : {}),
  },
})

/** The lanes of a scripted runtime. No lane is open until the test opens one. */
function laneSource() {
  const listeners = new Set<(lane: number) => void>()
  let opened = 0
  return {
    onLane(listener: (lane: number) => void): () => void {
      listeners.add(listener)
      if (opened !== 0) listener(opened)
      return () => { listeners.delete(listener) }
    },
    open(): void {
      opened += 1
      for (const listener of listeners) listener(opened)
    },
  }
}

/** A scripted runtime with one typed handler per request the coordinator makes. */
function scriptedConnection(handlers: {
  readonly onLane: (listener: (lane: number) => void) => () => void
  readonly subscribe: (listener: (event: FrontendEvent) => void) => () => void
  readonly authStatus: () => Promise<RuntimeAuthStatusSnapshotResult>
  readonly notifications: () => Promise<RuntimeProjectNotificationSnapshotResult>
  readonly dismiss?: (mutation: Extract<FrontendMutation, { type: "project_notifications.dismiss" }>) => void
}): AuthNotificationCoordinatorDeps["connection"] {
  const query = runtimeQuery({ authStatusSnapshot: handlers.authStatus, projectNotificationSnapshot: handlers.notifications })
  const dispatch = runtimeDispatch({ "project_notifications.dismiss": (mutation) => {
    handlers.dismiss?.(mutation)
    return Promise.resolve({ ok: true })
  } })
  return { onLane: handlers.onLane, subscribe: handlers.subscribe, query, dispatch }
}

function withoutPendingReview(snapshot: RuntimeAuthStatusSnapshotResult): RuntimeAuthStatusSnapshotResult {
  const consent = snapshot.auth.subscriptionSpendConsent
  if (consent.kind !== "available") throw new Error("expected available consent fixture")
  return { ...snapshot, auth: { ...snapshot.auth, subscriptionSpendConsent: { ...consent, accounts: [] } } }
}

function episode(id: string, action: ProjectNotificationEpisode["action"], createdAt = 1): ProjectNotificationEpisode {
  return { id, sourceId: `${id}-source`, title: `Notice ${id}`, message: "Something needs attention.", severity: "warning", action, createdAt, expiresAt: Date.now() + 10_000 }
}

function harness(
  initialAuth = authSnapshot(10),
  initialNotifications: RuntimeProjectNotificationSnapshotResult = { snapshotPosition: 20, notifications: [] },
  answer: (toast: NotificationToast) => Promise<boolean> = async () => true,
) {
  let listener: ((event: FrontendEvent) => void) | undefined
  const lanes = laneSource()
  let busy = true
  const mutations: unknown[] = []
  const opened: NotificationActionView["open"][] = []
  const toasts: NotificationToast[] = []
  const authSnapshots = [initialAuth]
  const notificationSnapshots: RuntimeProjectNotificationSnapshotResult[] = [initialNotifications]
  const coordinator = createAuthNotificationCoordinator({
    connection: scriptedConnection({
      onLane: lanes.onLane,
      subscribe: (next) => { listener = next; return () => { listener = undefined } },
      authStatus: async () => authSnapshots.shift()!,
      notifications: async () => notificationSnapshots.shift()!,
      dismiss: (mutation) => { mutations.push(mutation) },
    }),
    isForegroundSafe: () => !busy,
    presentNotification: (toast) => { toasts.push(toast); return answer(toast) },
    open: (target) => { opened.push(target) },
    onError: () => {},
  })
  const authChanges: Array<RuntimeAuthStatusSnapshotResult | undefined> = []
  const stopAuth = coordinator.onAuthChange((snapshot) => { authChanges.push(snapshot) })
  return { coordinator, stopAuth, openLane: lanes.open, emit: (event: FrontendEvent) => listener?.(event), mutations, authSnapshots, notificationSnapshots, authChanges, opened, toasts, setBusy: (value: boolean) => { busy = value } }
}

describe("VS Code auth and notification coordinator", () => {
  test("serializes a following patch behind an in-flight reseed", async () => {
    let listener: ((event: FrontendEvent) => void) | undefined
    const lanes = laneSource()
    let resolveAuth!: (snapshot: RuntimeAuthStatusSnapshotResult) => void
    const blockedAuth = new Promise<RuntimeAuthStatusSnapshotResult>((resolve) => { resolveAuth = resolve })
    let authReads = 0
    const coordinator = createAuthNotificationCoordinator({
      connection: scriptedConnection({
        onLane: lanes.onLane,
        subscribe: (next) => { listener = next; return () => { listener = undefined } },
        authStatus: async () => {
          authReads += 1
          return authReads === 1 ? await blockedAuth : authSnapshot(10)
        },
        notifications: async () => ({ snapshotPosition: 20, notifications: [] }),
      }),
      isForegroundSafe: () => false,
      presentNotification: async () => false,
      open: () => {}, onError: () => {},
    })
    const positions: Array<number | undefined> = []
    coordinator.onAuthChange((snapshot) => { positions.push(snapshot?.snapshotPosition) })

    lanes.open()
    listener?.({ type: "patch", patch: { cursor: { scope: "workspace", domain: "auth" }, prevPosition: 10, position: 11, payload: { kind: "auth.changed", auth: authSnapshot(11).auth } } })
    resolveAuth(authSnapshot(10))
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    assert.deepEqual(positions, [undefined, 10, 11])
    assert.equal(authReads, 1)
    coordinator.dispose()
  })

  test("serializes public refresh with following patches", async () => {
    let listener: ((event: FrontendEvent) => void) | undefined
    const lanes = laneSource()
    let resolveRefresh!: (snapshot: RuntimeAuthStatusSnapshotResult) => void
    const blockedRefresh = new Promise<RuntimeAuthStatusSnapshotResult>((resolve) => { resolveRefresh = resolve })
    let authReads = 0
    const coordinator = createAuthNotificationCoordinator({
      connection: scriptedConnection({
        onLane: lanes.onLane,
        subscribe: (next) => { listener = next; return () => { listener = undefined } },
        authStatus: async () => {
          authReads += 1
          return authReads === 1 ? authSnapshot(10) : await blockedRefresh
        },
        notifications: async () => ({ snapshotPosition: 20, notifications: [] }),
      }),
      isForegroundSafe: () => false,
      presentNotification: async () => false,
      open: () => {}, onError: () => {},
    })
    const positions: Array<number | undefined> = []
    coordinator.onAuthChange((snapshot) => { positions.push(snapshot?.snapshotPosition) })
    lanes.open()
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    const refreshing = coordinator.refresh()
    await Promise.resolve()
    listener?.({ type: "patch", patch: { cursor: { scope: "workspace", domain: "auth" }, prevPosition: 10, position: 11, payload: { kind: "auth.changed", auth: authSnapshot(11).auth } } })
    resolveRefresh(authSnapshot(10))
    await refreshing
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    assert.deepEqual(positions, [undefined, 10, 10, 11])
    coordinator.dispose()
  })

  test("correlates OAuth settlement from the exact ordered auth patch", async () => {
    const run = harness()
    run.openLane()
    await Promise.resolve(); await Promise.resolve()
    const waiting = run.coordinator.waitForOAuthSettlement("oauth-op")
    run.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "auth" }, prevPosition: 10, position: 11, payload: { kind: "auth.changed", auth: authSnapshot(11, "oauth-op").auth } } })
    assert.equal((await waiting)?.snapshotPosition, 11)
    run.coordinator.dispose()
  })

  test("cancellation releases OAuth correlation and prevents late settlement", async () => {
    const run = harness()
    run.openLane()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    const controller = new AbortController()
    const waiting = run.coordinator.waitForOAuthSettlement("oauth-op", controller.signal)
    controller.abort()
    assert.equal(await waiting, undefined)
    run.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "auth" }, prevPosition: 10, position: 11, payload: { kind: "auth.changed", auth: authSnapshot(11, "oauth-op").auth } } })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    assert.equal(run.authChanges.at(-1)?.snapshotPosition, 11)
    run.coordinator.dispose()
  })
  test("opens the exact current targeted auth account and dismisses the episode", async () => {
    const complete = authSnapshot(10)
    const consent = complete.auth.subscriptionSpendConsent
    if (consent.kind !== "available") throw new Error("expected available consent fixture")
    const targeted = { ...complete, auth: { ...complete.auth, subscriptionSpendConsent: { ...consent, accounts: consent.accounts.map((account) => ({ ...account, modes: account.modes.map((mode) => ({ ...mode, decision: "accepted" as const })) })) } } }
    const run = harness(targeted)
    run.openLane()
    await Promise.resolve(); await Promise.resolve()
    run.setBusy(false)
    run.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "project_notifications" }, prevPosition: 20, position: 21, payload: { kind: "project_notifications.raised", episode: { id: "episode", sourceId: "source", title: "Review", message: "Paid use changed", severity: "warning", action: { kind: "open-auth", providerId: "chatgpt", accountCorrelationId: "account", envelopeId: "paid" }, createdAt: 1, expiresAt: Date.now() + 10_000 } } } })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    assert.deepEqual(run.opened, [{ type: "openSheet", sheet: "providers", focus: { kind: "review-paid-use", providerId: "chatgpt", accountCorrelationId: "account", envelopeId: "paid" } }])
    assert.deepEqual(run.mutations, [{ type: "project_notifications.dismiss", sourceId: "source", episodeId: "episode" }])
    run.coordinator.dispose()
  })

  test("does not open or dismiss a missing targeted auth account", async () => {
    const run = harness(withoutPendingReview(authSnapshot(10)), { snapshotPosition: 20, notifications: [{ id: "episode", sourceId: "source", title: "Review", message: "Paid use changed", severity: "warning", action: { kind: "open-auth", providerId: "chatgpt", accountCorrelationId: "replaced" }, createdAt: 1, expiresAt: Date.now() + 10_000 }] })
    run.setBusy(false)
    run.openLane()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    assert.deepEqual(run.opened, [])
    assert.deepEqual(run.toasts, [])
    assert.deepEqual(run.mutations, [])
    run.coordinator.dispose()
  })

  test("opens a provider notice at its provider, as the client's own list does", async () => {
    const run = harness(authSnapshot(10), { snapshotPosition: 20, notifications: [episode("absent", { kind: "open-auth-provider", providerId: "google_api" })] })
    run.setBusy(false)
    run.openLane()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    assert.deepEqual(run.opened, [{ type: "openSheet", sheet: "providers", focus: { kind: "focus-provider", providerId: "google_api" } }])
    run.coordinator.dispose()
  })

  test("an unanswered notice holds back neither later events nor a later notice", async () => {
    const run = harness(authSnapshot(10), { snapshotPosition: 20, notifications: [episode("first", { kind: "open-settings" })] }, () => new Promise<boolean>(() => {}))
    run.setBusy(false)
    run.openLane()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    run.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "project_notifications" }, prevPosition: 20, position: 21, payload: { kind: "project_notifications.raised", episode: episode("second", { kind: "open-usage" }) } } })
    run.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "auth" }, prevPosition: 10, position: 11, payload: { kind: "auth.changed", auth: authSnapshot(11).auth } } })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    assert.deepEqual(run.toasts.map((toast) => toast.action), ["Open settings", "Open usage"])
    assert.equal(run.authChanges.at(-1)?.snapshotPosition, 11)
    run.coordinator.dispose()
  })

  test("presents every unresolved notice at once, oldest first", async () => {
    const run = harness(authSnapshot(10), { snapshotPosition: 20, notifications: [
      episode("newer", { kind: "open-auth" }),
      { ...episode("resolved", { kind: "open-settings" }), resolvedAt: 3 },
      episode("notice", undefined),
      episode("older", { kind: "open-settings" }),
    ] }, async () => false)
    run.setBusy(false)
    run.openLane()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    assert.deepEqual(run.toasts.map((toast) => toast.action), ["Open settings", undefined, "Open providers"])
    assert.deepEqual(run.opened, [])
    run.coordinator.dispose()
  })

  test("a toast says when the notice was raised and names the surface its button opens", () => {
    const raised = new Date(2026, 9, 6, 9, 5).getTime()
    assert.deepEqual(notificationToast(episode("auth", { kind: "open-auth" }, raised), raised), {
      text: "Notice auth: Something needs attention. Raised Oct 6, 09:05.",
      action: "Open providers",
    })
    assert.equal(notificationToast(episode("settings", { kind: "open-settings" }, raised), raised).action, "Open settings")
    assert.equal(notificationToast(episode("provider", { kind: "open-auth-provider", providerId: "google_api" }, raised), raised).action, "Open provider")
    const { action: _action, ...notice } = episode("notice", { kind: "open-settings" }, raised)
    assert.deepEqual(notificationToast(notice, raised), {
      text: "Notice notice: Something needs attention. Raised Oct 6, 09:05.",
    })
  })
})
