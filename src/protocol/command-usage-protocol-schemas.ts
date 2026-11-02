import { Schema } from "effect"
import type { CommandUsagePatchPayload, CommandUsageRecordMutation, CommandUsageView, RuntimeCommandUsageSnapshotResult } from "./command-usage-protocol-types.js"

const CommandUsageViewSchema: Schema.Codec<CommandUsageView> = Schema.Struct({
  uses: Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, count: Schema.Int.check(Schema.isGreaterThan(0)) })),
})
export const CommandUsagePatchPayloadSchema: Schema.Codec<CommandUsagePatchPayload> = Schema.Struct({ kind: Schema.Literal("commandUsage.changed"), usage: CommandUsageViewSchema })
export const RuntimeCommandUsageSnapshotResultSchema: Schema.Codec<RuntimeCommandUsageSnapshotResult> = Schema.Struct({ snapshotPosition: Schema.Number, usage: CommandUsageViewSchema })
export const CommandUsageRecordMutationSchema: Schema.Codec<CommandUsageRecordMutation> = Schema.Struct({ type: Schema.Literal("command_usage.record"), name: Schema.NonEmptyString })
