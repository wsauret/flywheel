import { Effect, Schema } from "effect"
import type { ModuleConfigSection } from "../../config/config-section.js"

export const DEFAULT_USAGE_ALERT_THRESHOLDS = [70, 90, 100] as const
const thresholds = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).check(
  Schema.makeFilter((values) => values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0)) || "must be unique and strictly ascending"),
)
const SubscriptionUsageConfigSchema = Schema.Struct({
  alert_thresholds: thresholds.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_USAGE_ALERT_THRESHOLDS)), Schema.annotate({ description: "Ascending usage percentages for alerts. Empty disables alerts." })),
}).pipe(Schema.withDecodingDefaultType(Effect.succeed({ alert_thresholds: DEFAULT_USAGE_ALERT_THRESHOLDS })))

/** Retained while Usage is off. Only the module's polling and notices consume
 *  these percentages; provider admission has no threshold dependency. */
export const subscriptionUsageConfigSection = {
  key: "subscription_usage",
  schema: SubscriptionUsageConfigSchema,
  owner: "Subscription usage",
  applications: [{ mode: "live", path: [] }],
  protocolExposure: "ui-safe",
  seeds: [{ key: "alert_thresholds", value: DEFAULT_USAGE_ALERT_THRESHOLDS, replaces: [[75, 90, 95, 100]] }],
} as const satisfies ModuleConfigSection<typeof SubscriptionUsageConfigSchema>
