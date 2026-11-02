import type { RuntimePosition } from "./runtime-ui-protocol-types.js"

/** One slash token and how many times a person has dispatched it. */
export interface CommandUse {
  readonly name: string
  readonly count: number
}

/** Account-global slash-command usage: the one ranking source every client
 *  orders its command lists by. Sorted by count, then name, so a client takes
 *  the head for "most used" without sorting again. */
export interface CommandUsageView {
  readonly uses: readonly CommandUse[]
}

export interface RuntimeCommandUsageSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly usage: CommandUsageView
}

/** One patch carries the whole view, so the newest supersedes any it overtook. */
export type CommandUsagePatchPayload = { readonly kind: "commandUsage.changed"; readonly usage: CommandUsageView }

/** A client reports one dispatch of `name`. The client records, not the
 *  runtime, because the terminal handles many commands without a round trip
 *  and only the dispatching side knows the command ran. */
export interface CommandUsageRecordMutation {
  readonly type: "command_usage.record"
  readonly name: string
}

export function commandUsageCursor() {
  return { scope: "workspace", domain: "commandUsage" } as const
}
