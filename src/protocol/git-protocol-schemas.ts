import { Schema } from "effect"
import type { GitPatchPayload, GitView, RuntimeGitSnapshotResult } from "./git-protocol-types.js"

const GitViewSchema: Schema.Codec<GitView> = Schema.Struct({
  directories: Schema.Record(Schema.String, Schema.Struct({ branch: Schema.optionalKey(Schema.String), worktreeRoot: Schema.optionalKey(Schema.String) })),
})
export const GitPatchPayloadSchema: Schema.Codec<GitPatchPayload> = Schema.Struct({ kind: Schema.Literal("git.changed"), git: GitViewSchema })
export const RuntimeGitSnapshotResultSchema: Schema.Codec<RuntimeGitSnapshotResult> = Schema.Struct({ snapshotPosition: Schema.Number, git: GitViewSchema })
