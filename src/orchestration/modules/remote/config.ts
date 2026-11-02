import { Effect, Schema } from "effect"
import type { ModuleConfigSection } from "../../config/config-section.js"

const RemoteConfigSchema = Schema.Struct({
  keep_awake: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(true)), Schema.annotate({ description: "Keep this machine awake while a phone uses a runtime it started?" })),
}).pipe(Schema.withDecodingDefaultType(Effect.succeed({ keep_awake: true })))

export const remoteConfigSection = {
  key: "remote", schema: RemoteConfigSchema, owner: "Remote access",
  applications: [{ mode: "next-use", path: [] }], protocolExposure: "ui-safe",
} as const satisfies ModuleConfigSection<typeof RemoteConfigSchema>
