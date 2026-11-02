import { Schema } from "effect"
import { NotificationActionSchema, type NotificationAction, type NotificationSeverity } from "../../infra/notification-episode.js"
import { openSheetCommand, type ClientCommand } from "../client/host-contract.js"
import { defineProtocolDomain, defineProtocolModule, defineProtocolMutation, type ModuleRow } from "../protocol-module.js"
import type { RuntimeCursorIdentity, RuntimePosition } from "../runtime-ui-protocol-types.js"

/** The workspace-scoped `project_notifications` contract (ARCH-PROTOCOL-044): the
 *  episodes the runtime raised for this project, the fact-shaped patches that
 *  move them, and the dismiss mutation. Every client folds one ordered cache
 *  from this description; the action vocabulary is closed and secret-free. */

export type ProjectNotificationAction = NotificationAction
type ProjectNotificationSeverity = NotificationSeverity

export interface ProjectNotificationEpisode {
  readonly id: string
  readonly sourceId: string
  readonly title: string
  readonly message: string
  readonly severity: ProjectNotificationSeverity
  readonly action?: ProjectNotificationAction
  readonly sourceSessionId?: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly resolvedAt?: number
  readonly dismissedAt?: number
}

/** The journal's complete reading: every episode newest first, the ones a
 *  client shows, and the aggregate sequence the reading covers. */
export interface ProjectNotificationProjection {
  readonly episodes: readonly ProjectNotificationEpisode[]
  readonly visible: readonly ProjectNotificationEpisode[]
  readonly lastSeq: number
}

export interface RuntimeProjectNotificationSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly notifications: readonly ProjectNotificationEpisode[]
}

export type ProjectNotificationPatchPayload =
  | { readonly kind: "project_notifications.raised"; readonly episode: ProjectNotificationEpisode }
  | { readonly kind: "project_notifications.resolved"; readonly sourceId: string; readonly episodeId: string; readonly resolvedAt: number }
  | { readonly kind: "project_notifications.dismissed"; readonly sourceId: string; readonly episodeId: string; readonly dismissedAt: number }

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const ProjectNotificationEpisodeSchema: Schema.Codec<ProjectNotificationEpisode> = Schema.Struct({
  id: Schema.NonEmptyString,
  sourceId: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  severity: Schema.Literals(["warning", "alert"]),
  action: Schema.optionalKey(NotificationActionSchema),
  sourceSessionId: Schema.optionalKey(Schema.NonEmptyString),
  createdAt: NonNegativeInt,
  expiresAt: NonNegativeInt,
  resolvedAt: Schema.optionalKey(NonNegativeInt),
  dismissedAt: Schema.optionalKey(NonNegativeInt),
})
const ProjectNotificationPatchPayloadSchema: Schema.Codec<ProjectNotificationPatchPayload> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project_notifications.raised"), episode: ProjectNotificationEpisodeSchema }),
  Schema.Struct({ kind: Schema.Literal("project_notifications.resolved"), sourceId: Schema.NonEmptyString, episodeId: Schema.NonEmptyString, resolvedAt: NonNegativeInt }),
  Schema.Struct({ kind: Schema.Literal("project_notifications.dismissed"), sourceId: Schema.NonEmptyString, episodeId: Schema.NonEmptyString, dismissedAt: NonNegativeInt }),
])
export const RuntimeProjectNotificationSnapshotResultSchema: Schema.Codec<RuntimeProjectNotificationSnapshotResult> = Schema.Struct({
  snapshotPosition: Schema.Number,
  notifications: Schema.Array(ProjectNotificationEpisodeSchema),
})

/** Folds one fact-shaped patch into the list a client holds: a raise leads
 *  the list, and a transition marks the exact episode it names. */
function foldPatch(payload: ProjectNotificationPatchPayload, current: readonly ProjectNotificationEpisode[] | undefined): readonly ProjectNotificationEpisode[] {
  const held = current ?? []
  if (payload.kind === "project_notifications.raised") return [payload.episode, ...held.filter((row) => row.id !== payload.episode.id)]
  return held.map((row) => {
    if (row.id !== payload.episodeId || row.sourceId !== payload.sourceId) return row
    return payload.kind === "project_notifications.resolved" ? { ...row, resolvedAt: payload.resolvedAt } : { ...row, dismissedAt: payload.dismissedAt }
  })
}

/** The module's one domain, exported so its client homes read the view by
 *  this declaration and never by a domain literal. */
export const projectNotificationsDomain = defineProtocolDomain({
  domain: "project_notifications",
  scope: "workspace",
  // A patch names one fact; a client that missed one resnapshots rather than
  // trusting the newest to carry what it overtook.
  delivery: "durable-resnapshot",
  content: "change",
  snapshot: { query: "projectNotificationSnapshot", result: RuntimeProjectNotificationSnapshotResultSchema, deadline: "control" },
  patch: ProjectNotificationPatchPayloadSchema,
  view: { snapshot: (result) => result.notifications, patch: foldPatch },
})

export const projectNotificationsCursor = (): RuntimeCursorIdentity => ({ scope: "workspace", domain: projectNotificationsDomain.domain })

/** Dismiss hides one exact occurrence for good; it is a lossless user action (ARCH-PROTOCOL-020). */
const projectNotificationDismiss = defineProtocolMutation({
  type: "project_notifications.dismiss",
  fields: { sourceId: Schema.NonEmptyString, episodeId: Schema.NonEmptyString },
  result: Schema.Union([Schema.Struct({ ok: Schema.Literal(true) }), Schema.Struct({ ok: Schema.Literal(false), error: Schema.String })]),
  policy: "lossless",
})


/** The surface both client homes register the list under. */
export const NOTIFICATIONS_SURFACE = "notifications"
export const NOTIFICATIONS_COMMAND = "notifications"
/** The command's one name, which its surface also heads with. */
export const NOTIFICATIONS_COMMAND_NAME = "Notifications"

const OPEN: ModuleRow["action"] = { kind: "surface", id: NOTIFICATIONS_SURFACE }

/** Episodes a client shows: not dismissed and not expired. Expiry is a read-time predicate (ARCH-SUBSTRATE-042). */
export function visibleNotifications(episodes: readonly ProjectNotificationEpisode[], now: number): readonly ProjectNotificationEpisode[] {
  return episodes.filter((episode) => episode.dismissedAt === undefined && now < episode.expiresAt)
}

/** Shown episodes that still need attention. A resolved episode stays in the
 *  list as history, but no count of what needs attention includes it. */
export function unresolvedNotifications(episodes: readonly ProjectNotificationEpisode[], now: number): readonly ProjectNotificationEpisode[] {
  return visibleNotifications(episodes, now).filter((episode) => episode.resolvedAt === undefined)
}

/** A notice's one action as the web and editor clients offer it: the words
 *  on its button and the client command that opens where it points. The
 *  words name the sheet or surface the command opens, so a button never
 *  names one place and opens another, and both clients land on the same
 *  surface. */
export interface NotificationActionView {
  readonly label: string
  readonly open: Extract<ClientCommand, { readonly type: "openSheet" | "openSurface" }>
}

export function notificationAction(action: ProjectNotificationAction): NotificationActionView {
  switch (action.kind) {
    case "open-settings":
      return { label: "Open settings", open: openSheetCommand("settings") }
    case "open-usage":
      // The subscription-usage module's surface. One module home never
      // imports another, so the id is named here.
      return { label: "Open usage", open: { type: "openSurface", surface: "usage" } }
    case "open-auth-provider":
      return { label: "Open provider", open: openSheetCommand("providers", { kind: "focus-provider", providerId: action.providerId }) }
    case "open-auth":
      if (!("providerId" in action)) return { label: "Open providers", open: openSheetCommand("providers") }
      return {
        label: "Open provider",
        open: openSheetCommand("providers", {
          kind: "review-paid-use",
          providerId: action.providerId,
          accountCorrelationId: action.accountCorrelationId,
          envelopeId: action.envelopeId,
        }),
      }
  }
}

function plural(count: number): string {
  return `${count} notification${count === 1 ? "" : "s"}`
}

export const projectNotificationsProtocol = defineProtocolModule({
  id: "project-notifications",
  domains: [projectNotificationsDomain],
  mutations: [projectNotificationDismiss],
  rows: {
    intro: (read) => {
      const unresolved = unresolvedNotifications(read(projectNotificationsDomain) ?? [], Date.now())
      return unresolved.length === 0 ? [] : [{ id: "project-notifications", label: "attention", value: plural(unresolved.length), hint: "to review", action: OPEN }]
    },
    status: (read) => {
      const episodes = read(projectNotificationsDomain)
      if (episodes === undefined) return []
      const visible = visibleNotifications(episodes, Date.now())
      const unresolved = unresolvedNotifications(episodes, Date.now()).length
      return [unresolved === 0
        ? { id: "project-notifications", label: "Notifications", value: visible.length === 0 ? "none" : `${plural(visible.length)}, all resolved`, action: OPEN }
        : { id: "project-notifications", label: "Notifications", value: `${plural(unresolved)} ${unresolved === 1 ? "needs" : "need"} attention`, tone: "warning", action: OPEN }]
    },
  },
})
