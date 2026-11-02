import { Schema } from "effect"
import { defineFact } from "../../../infra/event-registry.js"
import { NotificationActionSchema } from "../../../infra/notification-episode.js"

const ProjectNotificationSeveritySchema = Schema.Union([Schema.Literal("warning"), Schema.Literal("alert")])

const ProjectNotificationRaisedFactSchema = defineFact({
  type: "project.notification.raised",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({
    sourceId: Schema.NonEmptyString,
    title: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
    severity: ProjectNotificationSeveritySchema,
    action: Schema.optionalKey(NotificationActionSchema),
    sourceSessionId: Schema.optional(Schema.NonEmptyString),
    createdAt: Schema.Number,
    expiresAt: Schema.Number,
  }),
})

const ProjectNotificationResolvedFactSchema = defineFact({
  type: "project.notification.resolved",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sourceId: Schema.NonEmptyString, episodeId: Schema.NonEmptyString }),
})

const ProjectNotificationDismissedFactSchema = defineFact({
  type: "project.notification.dismissed",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sourceId: Schema.NonEmptyString, episodeId: Schema.NonEmptyString }),
})

const ProjectNotificationFactSchema = Schema.Union([
  ProjectNotificationRaisedFactSchema,
  ProjectNotificationResolvedFactSchema,
  ProjectNotificationDismissedFactSchema,
])


export type ProjectNotificationFact = typeof ProjectNotificationFactSchema.Type

export function parseProjectNotificationFact(value: unknown): ProjectNotificationFact {
  return Schema.decodeUnknownSync(ProjectNotificationFactSchema, { onExcessProperty: "error" })(value)
}
