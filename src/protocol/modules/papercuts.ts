import { Schema } from "effect"
import { defineProtocolDomain, defineProtocolModule, type ModuleRow } from "../protocol-module.js"
import type { RuntimePosition } from "../runtime-ui-protocol-types.js"

/** The workspace-scoped `papercuts` contract: the count of recorded papercuts
 *  nobody has disposed yet, derived from the project's durable papercut facts. */

export interface RuntimePapercutCountView {
  readonly undisposedCount: number
}

export interface RuntimePapercutCountSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly papercuts: RuntimePapercutCountView
}

export type PapercutPatchPayload = { readonly kind: "papercuts.changed"; readonly papercuts: RuntimePapercutCountView }

const RuntimePapercutCountViewSchema: Schema.Codec<RuntimePapercutCountView> = Schema.Struct({ undisposedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
export const RuntimePapercutCountSnapshotResultSchema: Schema.Codec<RuntimePapercutCountSnapshotResult> = Schema.Struct({ snapshotPosition: Schema.Number, papercuts: RuntimePapercutCountViewSchema })
export const PapercutPatchPayloadSchema: Schema.Codec<PapercutPatchPayload> = Schema.Struct({ kind: Schema.Literal("papercuts.changed"), papercuts: RuntimePapercutCountViewSchema })

/** The backlog size at which the intro card starts to nudge, so a handful of
 *  notes never crowds a fresh session's first screen. */
const INTRO_NUDGE_THRESHOLD = 10

const DRAIN: ModuleRow["action"] = { kind: "command", id: "papercuts" }

const papercutsDomain = defineProtocolDomain({
  domain: "papercuts",
  scope: "workspace",
  // One patch carries the whole count, so the newest supersedes any it overtook.
  delivery: "latest-collapsible",
  content: "whole-value",
  snapshot: { query: "papercutCountSnapshot", result: RuntimePapercutCountSnapshotResultSchema, deadline: "control" },
  patch: PapercutPatchPayloadSchema,
  view: { snapshot: (result) => result.papercuts, patch: (payload) => payload.papercuts },
})

export const papercutsProtocol = defineProtocolModule({
  id: "papercuts",
  domains: [papercutsDomain],
  hostCommands: [{ key: "drainPapercuts", commandId: DRAIN.id }],
  rows: {
    intro: (read) => {
      const count = read(papercutsDomain)?.undisposedCount ?? 0
      return count < INTRO_NUDGE_THRESHOLD ? [] : [{ id: "papercuts", label: "papercuts", value: `${count} logged`, action: DRAIN }]
    },
    status: (read) => {
      const view = read(papercutsDomain)
      if (view === undefined) return []
      const count = view.undisposedCount
      return [count === 0
        ? { id: "papercuts", label: "Papercuts", value: "none recorded" }
        : { id: "papercuts", label: "Papercuts", value: `${count} waiting`, hint: "Small annoyances recorded against this project. Pick this to work through them.", action: DRAIN }]
    },
  },
})
