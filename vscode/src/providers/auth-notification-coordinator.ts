import type { AttachedRuntimeClient, FrontendEvent } from "../../../src/protocol/runtime/app-service-types.js"
import { authStatusCursor, type RuntimeAuthStatusSnapshotResult } from "../../../src/protocol/auth/auth-status-protocol-types.js"
import { lostWithLane } from "../../../src/protocol/client/runtime/connection-failures.js"
import { formatDateTime } from "../../../src/protocol/client/format.js"
import { notificationAction, type NotificationActionView } from "../../../src/protocol/client/host/host-contract.js"
import { MODULE_DOMAIN_BINDINGS } from "../../../src/protocol/client/modules/module-domain.js"

interface AuthNotificationCoordinator {
  /** Presents every unresolved notice not yet presented, when the window can take one. */
  foregroundAvailable(): void
  onAuthChange(listener: (snapshot: RuntimeAuthStatusSnapshotResult | undefined) => void): () => void
  dispose(): void
}

export interface AuthNotificationCoordinatorDeps {
  readonly connection: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">
  readonly isForegroundSafe: () => boolean
  /** Shows one notice and resolves true when the person chose its action.
   *  An editor notice can stay open for good, so the coordinator never waits
   *  for it in order with the events. */
  readonly presentNotification: (toast: NotificationToast) => Promise<boolean>
  /** Opens where a chosen notice points, in the client. */
  readonly open: (target: NotificationActionView["open"]) => void
  readonly onError: (cause: unknown) => void
}

/** One notice as an editor shows it: its text and an optional action button. */
export interface NotificationToast {
  readonly text: string
  readonly action?: string
}

/** The notice's title, message, and the date and 24-hour time it was raised
 *  (PI-INTERACTION-014), with the button the client's own list offers. */
export function notificationToast(episode: ProjectNotificationEpisode, now = Date.now()): NotificationToast {
  return {
    text: `${episode.title}: ${episode.message} Raised ${formatDateTime(episode.createdAt, now)}.`,
    ...(episode.action ? { action: notificationAction(episode.action).label } : {}),
  }
}

/** The notification list as this coordinator holds it, beside the position its cursor has reached. */
interface HeldNotifications {
  readonly snapshotPosition: number
  readonly notifications: readonly ProjectNotificationEpisode[]
}

const authCursor = authStatusCursor()
/** The registry binding for the notifications domain: its cursor, read, patch test, and fold. */
const notifications = MODULE_DOMAIN_BINDINGS.project_notifications
const notificationCursor = notifications.cursor()
/** One episode as the binding's view holds it. */
type ProjectNotificationEpisode = NonNullable<Awaited<ReturnType<typeof notifications.read>>["view"]>[number]

/** Owns the VS Code auth and notification streams. Snapshots seed each cursor;
 * only contiguous patches can advance them. Consumers derive every provider
 * surface from this one ordered auth projection. */
export function createAuthNotificationCoordinator(deps: AuthNotificationCoordinatorDeps): AuthNotificationCoordinator {
  let auth: RuntimeAuthStatusSnapshotResult | undefined
  let held: HeldNotifications | undefined
  let disposed = false
  let reseedGeneration = 0
  const presentedNotificationIds = new Set<string>()
  const authListeners = new Set<(snapshot: RuntimeAuthStatusSnapshotResult | undefined) => void>()
  let eventLane = Promise.resolve()

  const enqueue = (operation: () => Promise<void>): void => {
    // A read lost with its lane is read again on the next lane.
    eventLane = eventLane.then(operation).catch((cause: unknown) => { if (!lostWithLane(cause)) deps.onError(cause) })
  }
  const stop = deps.connection.subscribe((event) => { enqueue(() => consume(event)) })
  // Each lane seeds both cursors, in order with the events around it.
  const stopLanes = deps.connection.onLane(() => { enqueue(reseed) })
  const publishAuth = (): void => {
    for (const listener of authListeners) listener(auth)
  }

  async function reseed(): Promise<void> {
    const generation = ++reseedGeneration
    const nextAuth = await deps.connection.query({ type: "authStatusSnapshot", scope: { kind: "defaults" } })
    const nextNotifications = await notifications.read(deps.connection)
    if (disposed || generation !== reseedGeneration) return
    auth = nextAuth
    held = { snapshotPosition: nextNotifications.snapshotPosition, notifications: nextNotifications.view ?? [] }
    publishAuth()
    const unresolvedIds = new Set(held.notifications.filter((episode) => episode.resolvedAt === undefined && episode.dismissedAt === undefined).map((episode) => episode.id))
    for (const id of presentedNotificationIds) if (!unresolvedIds.has(id)) presentedNotificationIds.delete(id)
    foregroundAvailable()
  }

  async function consume(event: FrontendEvent): Promise<void> {
    if (disposed || event.type !== "patch") return
    const patch = event.patch
    if (patch.payload.kind === "runtime.invalidate") {
      auth = undefined
      held = undefined
      publishAuth()
      return
    }
    if (patch.cursor.scope !== "workspace") return
    if (patch.cursor.domain === authCursor.domain && patch.payload.kind === "auth.changed") {
      if (!auth || patch.prevPosition !== auth.snapshotPosition) {
        await reseed()
        return
      }
      auth = { snapshotPosition: patch.position, auth: patch.payload.auth }
      publishAuth()
      foregroundAvailable()
      return
    }
    if (patch.cursor.domain !== notificationCursor.domain || !notifications.isPayload(patch.payload)) return
    if (!held || patch.prevPosition !== held.snapshotPosition) {
      await reseed()
      return
    }
    const payload = patch.payload
    held = { snapshotPosition: patch.position, notifications: notifications.payloadView(payload, held.notifications) ?? [] }
    if (payload.kind === "project_notifications.raised") {
      foregroundAvailable()
      return
    }
    presentedNotificationIds.delete(payload.episodeId)
  }

  /** A paid-use notice names one review. A notice whose review is gone has
   *  nothing to open, so it is not presented. */
  function opensCurrentReview(action: ProjectNotificationEpisode["action"]): boolean {
    if (action?.kind !== "open-auth" || !("providerId" in action)) return true
    const consent = auth?.auth.subscriptionSpendConsent
    return consent?.kind === "available" && consent.accounts.some((account) => account.providerId === action.providerId
      && account.accountCorrelationId === action.accountCorrelationId
      && account.modes.some((mode) => mode.envelopeId === action.envelopeId))
  }

  function present(episode: ProjectNotificationEpisode): void {
    if (presentedNotificationIds.has(episode.id) || !opensCurrentReview(episode.action)) return
    presentedNotificationIds.add(episode.id)
    // Each notice is its own editor notification. Its answer settles only
    // when the person closes it, which can be never, so nothing waits on it.
    void deps.presentNotification(notificationToast(episode)).then(async (chosen) => {
      if (!chosen || disposed || !episode.action) return
      deps.open(notificationAction(episode.action).open)
      await deps.connection.dispatch({ type: "project_notifications.dismiss", sourceId: episode.sourceId, episodeId: episode.id })
    }).catch((cause: unknown) => { if (!lostWithLane(cause)) deps.onError(cause) })
  }

  function foregroundAvailable(): void {
    if (disposed || !deps.isForegroundSafe()) return
    const now = Date.now()
    // Oldest first, so the newest notice sits on top of the editor's stack.
    for (const episode of (held?.notifications ?? []).toReversed()) {
      if (episode.resolvedAt === undefined && episode.dismissedAt === undefined && now < episode.expiresAt) present(episode)
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    stopLanes()
    stop()
    authListeners.clear()
  }

  return {
    foregroundAvailable,
    onAuthChange: (listener) => {
      authListeners.add(listener)
      listener(auth)
      return () => { authListeners.delete(listener) }
    },
    dispose,
  }
}
