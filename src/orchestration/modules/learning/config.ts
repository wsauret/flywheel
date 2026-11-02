import { Effect, Schema } from "effect"
import { configSection, type ModuleConfigSection } from "../../config/config-section.js"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const described = <S extends Schema.Top>(schema: S, description: string) => schema.pipe(Schema.annotate({ description }))
const section = <K extends string, S extends Schema.Top & Schema.Decoder<unknown, never> & { readonly Type: Schema.Json }>(key: K, schema: S, owner: string, applications: ModuleConfigSection["applications"], protocolExposure: ModuleConfigSection["protocolExposure"]) => ({key, schema, owner, applications, protocolExposure, requestCapture: (value: unknown) => Schema.decodeUnknownSync(schema)(value)})

export const skillsConfigSection = section("skills", Schema.Struct({ notifications: described(Schema.Union([Schema.Literal("off"), Schema.Literal("on"), Schema.Literal("verbose")]).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed("on" as const))), "Set managed-skill notification detail."), review_interval_iterations: described(NonNegativeInt.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(10))), "Iterations between managed-skill reviews."), stale_after_days: described(NonNegativeInt.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(30))), "Days before a managed skill becomes stale."), archive_after_days: described(NonNegativeInt.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(90))), "Days before a stale managed skill is archived.") }).pipe(Schema.withDecodingDefaultType(Effect.succeed({ notifications: "on" as const, review_interval_iterations: 10, stale_after_days: 30, archive_after_days: 90 }))), "managed skills", [{ mode: "next-request", path: ["notifications"] }, { mode: "next-request", path: ["review_interval_iterations"] }, { mode: "next-use", path: ["stale_after_days"] }, { mode: "next-use", path: ["archive_after_days"] }], "ui-safe")
export const memoryConfigSection = section("memory", Schema.Struct({ review_interval_turns: described(NonNegativeInt.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(10))), "Turns between memory reviews.") }).pipe(Schema.withDecodingDefaultType(Effect.succeed({ review_interval_turns: 10 }))), "memory", [{ mode: "next-request", path: [] }], "ui-safe")

/** Read the same nonsensitive policy from initial config or a frozen request capture. */
export function learningReviewPolicy(config: { readonly [section: string]: unknown }) {
  const memory = configSection(config, memoryConfigSection)
  const skills = configSection(config, skillsConfigSection)
  return { memoryIntervalTurns: memory.review_interval_turns, skillIntervalIterations: skills.review_interval_iterations, notifications: skills.notifications }
}
