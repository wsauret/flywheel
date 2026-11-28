import { Schema } from "effect"

/** The notify seam's vocabulary (ARCH-STRUCTURE-034,
 *  ARCH-BOUNDARIES-015). A producer states a condition it
 *  observed; whichever module observes the seam decides what becomes durable.
 *  The shapes are curated presentation fields only, never commands, raw
 *  payloads, errors, or secrets, so a fact derived from them stays safe. */

/** One closed action a client offers for an episode. A targeted auth action
 *  carries opaque correlation identities, never account subject data. */
export type NotificationAction =
  | { readonly kind: "open-auth" }
  | { readonly kind: "open-auth-provider"; readonly providerId: string }
  | { readonly kind: "open-auth"; readonly providerId: string; readonly accountCorrelationId: string; readonly envelopeId: string }
  | { readonly kind: "open-usage" }
  | { readonly kind: "open-settings" }

export type NotificationSeverity = "warning" | "alert"

/** One occurrence of a condition. `sourceId` is the stable, secret-free
 *  identity of the condition; raising it while an occurrence is active is an
 *  idempotent retry. */
export interface NotificationOccurrence {
  readonly sourceId: string
  readonly title: string
  readonly message: string
  readonly severity: NotificationSeverity
  readonly action?: NotificationAction
  readonly sourceSessionId?: string
}

/** The scope a producer declares for its condition (ARCH-SUBSTRATE-041). A
 *  condition of a provider account or an auth profile names that profile, and
 *  its episodes are kept once for the profile and shown in every project that
 *  uses it (PI-INTERACTION-072). Without `profileId` the condition belongs to
 *  the project that stated it. */
interface NotificationScope {
  readonly profileId?: string
}

/** What a producer hands the seam. `raise` and `resolve` name one source.
 *  `reconcile` states every occurrence that is active under a source prefix:
 *  the observer raises the missing ones and resolves every other active source
 *  under the prefix, except sources under a `keep` prefix, which belong to a
 *  scope the producer did not read. Each input acts only on the episodes of
 *  its own scope. */
export type NotificationEpisodeInput = NotificationScope & (
  | { readonly type: "raise"; readonly occurrence: NotificationOccurrence }
  | { readonly type: "resolve"; readonly sourceId: string }
  | { readonly type: "reconcile"; readonly prefix: string; readonly desired: readonly NotificationOccurrence[]; readonly keep?: readonly string[] }
)

export const NotificationActionSchema: Schema.Codec<NotificationAction> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("open-auth-provider"), providerId: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("open-auth"), providerId: Schema.NonEmptyString, accountCorrelationId: Schema.NonEmptyString, envelopeId: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("open-auth") }),
  Schema.Struct({ kind: Schema.Literal("open-usage") }),
  Schema.Struct({ kind: Schema.Literal("open-settings") }),
])
const OccurrenceSchema = Schema.Struct({
  sourceId: Schema.NonEmptyString, title: Schema.NonEmptyString, message: Schema.NonEmptyString,
  severity: Schema.Literals(["warning", "alert"]), action: Schema.optionalKey(NotificationActionSchema),
  sourceSessionId: Schema.optionalKey(Schema.NonEmptyString),
})
export const NotificationEpisodeInputSchema: Schema.Codec<NotificationEpisodeInput> = Schema.Union([
  Schema.Struct({ type: Schema.Literal("raise"), profileId: Schema.optionalKey(Schema.NonEmptyString), occurrence: OccurrenceSchema }),
  Schema.Struct({ type: Schema.Literal("resolve"), profileId: Schema.optionalKey(Schema.NonEmptyString), sourceId: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("reconcile"), profileId: Schema.optionalKey(Schema.NonEmptyString), prefix: Schema.NonEmptyString, desired: Schema.Array(OccurrenceSchema), keep: Schema.optionalKey(Schema.Array(Schema.String)) }),
])
