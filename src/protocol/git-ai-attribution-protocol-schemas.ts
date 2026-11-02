import { Schema } from "effect"
import type { GitAiAttributionPatchPayload, GitAiAttributionStatus, RuntimeGitAiAttributionSnapshotResult } from "./git-ai-attribution-protocol-types.js"

const GitAiAttributionStatusSchema: Schema.Codec<GitAiAttributionStatus> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("checking") }),
  Schema.Struct({ kind: Schema.Literal("available") }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.Literals(["no-repository", "command-not-found", "check-failed", "check-timed-out"]) }),
])
export const GitAiAttributionPatchPayloadSchema: Schema.Codec<GitAiAttributionPatchPayload> = Schema.Struct({ kind: Schema.Literal("gitAiAttribution.changed"), status: GitAiAttributionStatusSchema })
export const RuntimeGitAiAttributionSnapshotResultSchema: Schema.Codec<RuntimeGitAiAttributionSnapshotResult> = Schema.Struct({ snapshotPosition: Schema.Number, status: GitAiAttributionStatusSchema })
