import { Schema } from "effect"
import { defineProtocolDomain, defineProtocolModule, defineProtocolMutation, defineProtocolQuery, type ModuleRow } from "../protocol-module.js"
import type { RuntimeCursorIdentity, RuntimePosition } from "../runtime-ui-protocol-types.js"
import { formatStorageBytes, type StorageReclaimOutcome, type StorageReclaimPreview } from "../store-reclaim.js"

/** The workspace-scoped `storage` contract: how large the project's Flywheel
 *  store is, how much of it Reclaim storage can give back, the last run of
 *  that command, and the command itself (PI-INTERACTION-182). */

export interface RuntimeStorageView {
  /** The store's size and what the command can give back, as the service
   *  measured them last; null until the first measurement after the
   *  project opens. */
  readonly usage: { readonly storeBytes: number; readonly reclaimableBytes: number } | null
  readonly lastReclaim: { readonly outcome: StorageReclaimOutcome; readonly at: number } | null
}

interface RuntimeStorageSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly storage: RuntimeStorageView
}

type StoragePatchPayload = { readonly kind: "reclaim_storage.changed"; readonly storage: RuntimeStorageView }

const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const StorageReclaimOutcomeSchema: Schema.Codec<StorageReclaimOutcome> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("reclaimed"), beforeBytes: Bytes, afterBytes: Bytes, rowsDeleted: Bytes }),
  Schema.Struct({ kind: Schema.Literal("refused"), reason: Schema.Literals(["disk-space", "busy", "no-store"]), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
])
const RuntimeStorageViewSchema: Schema.Codec<RuntimeStorageView> = Schema.Struct({
  usage: Schema.NullOr(Schema.Struct({ storeBytes: Bytes, reclaimableBytes: Bytes })),
  lastReclaim: Schema.NullOr(Schema.Struct({ outcome: StorageReclaimOutcomeSchema, at: Bytes })),
})
const RuntimeStorageSnapshotResultSchema: Schema.Codec<RuntimeStorageSnapshotResult> = Schema.Struct({ snapshotPosition: Schema.Number, storage: RuntimeStorageViewSchema })
const StoragePatchPayloadSchema: Schema.Codec<StoragePatchPayload> = Schema.Struct({ kind: Schema.Literal("reclaim_storage.changed"), storage: RuntimeStorageViewSchema })

/** The reclaimable size at which the intro card suggests Reclaim storage (PI-INTERACTION-183):
 *  1 GiB. Below it, the space a rebuild gives back is not worth the minutes
 *  the project is closed, and idle reclaim keeps a converted store small. */
const RECLAIM_NUDGE_BYTES = 1024 * 1024 * 1024

/** The surface the command opens: the preview and the confirmation. */
export const RECLAIM_STORAGE_SURFACE = "reclaim-storage"
export const RECLAIM_STORAGE_COMMAND = "reclaim-storage"
/** The command's one name, which its surface also heads with. */
export const RECLAIM_STORAGE_COMMAND_NAME = "Reclaim storage"

const OPEN: ModuleRow["action"] = { kind: "surface", id: RECLAIM_STORAGE_SURFACE }
const PICK_HINT = "Pick this to reclaim space."

/** The module's one domain, exported so its client homes read the view by
 *  this declaration and never by a domain literal. */
export const storageDomain = defineProtocolDomain({
  domain: "reclaim_storage",
  scope: "workspace",
  // One patch carries the whole view, so the newest supersedes any it overtook.
  delivery: "latest-collapsible",
  content: "whole-value",
  snapshot: { query: "storageSnapshot", result: RuntimeStorageSnapshotResultSchema, deadline: "control" },
  patch: StoragePatchPayloadSchema,
  view: { snapshot: (result) => result.storage, patch: (payload) => payload.storage },
})

export const storageCursor = (): RuntimeCursorIdentity => ({ scope: "workspace", domain: storageDomain.domain })

/** What the surface shows before the person confirms, read when it opens:
 *  the store, what the run can give back, and the free space the rebuild
 *  needs. `refusal` says why the run would refuse now. Null when the project
 *  holds no store, or no account service serves it. */
const StorageReclaimPreviewSchema: Schema.Codec<StorageReclaimPreview> = Schema.NullOr(Schema.Struct({
  storeBytes: Bytes,
  reclaimableBytes: Bytes,
  freeBytes: Bytes,
  neededBytes: Bytes,
  refusal: Schema.optionalKey(Schema.String),
}))

const StorageReclaimResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
export type StorageReclaimResult = typeof StorageReclaimResultSchema.Type

/** Whether a Reclaim storage preview still shows the live view: no run ended
 *  since the preview was read, when the last run was `lastRunAtRead`, and its
 *  sizes are the service's last measurement. When it does not, a surface
 *  reads the preview again and patches its rows in place. A preview's own
 *  read reports the sizes it shows, so that report asks for no read. */
export function previewShowsView(preview: StorageReclaimPreview | undefined, lastRunAtRead: number | null, view: RuntimeStorageView | undefined): boolean {
  if (view === undefined) return true
  if ((view.lastReclaim?.at ?? null) !== lastRunAtRead) return false
  if (view.usage === null) return true
  return preview != null && preview.storeBytes === view.usage.storeBytes && preview.reclaimableBytes === view.usage.reclaimableBytes
}

/** The last run in a few words, for a one-line slot: the status row's hint
 *  and the web sheet's row value. The whole sentence is
 *  `describeReclaimOutcome`, which the surfaces show where text wraps. */
export function reclaimOutcomeLabel(outcome: StorageReclaimOutcome): string {
  switch (outcome.kind) {
    case "reclaimed": return `reclaimed ${formatStorageBytes(Math.max(0, outcome.beforeBytes - outcome.afterBytes))}`
    case "refused": return `refused: ${refusalLabel(outcome.reason)}`
    case "failed": return "failed"
  }
}

function refusalLabel(reason: Extract<StorageReclaimOutcome, { kind: "refused" }>["reason"]): string {
  switch (reason) {
    case "disk-space": return "disk space"
    case "busy": return "busy"
    case "no-store": return "no store"
  }
}

/** The last run in one sentence, which the surfaces show where text wraps. */
export function describeReclaimOutcome(outcome: StorageReclaimOutcome): string {
  switch (outcome.kind) {
    case "reclaimed":
      return `Reclaimed ${formatStorageBytes(Math.max(0, outcome.beforeBytes - outcome.afterBytes))}: ${formatStorageBytes(outcome.beforeBytes)} to ${formatStorageBytes(outcome.afterBytes)}`
    case "refused":
    case "failed":
      return outcome.message
  }
}

export const reclaimStorageProtocol = defineProtocolModule({
  id: "reclaim-storage",
  domains: [storageDomain],
  queries: [defineProtocolQuery({ query: "storage.reclaimPreview", result: StorageReclaimPreviewSchema, deadline: "control" })],
  mutations: [defineProtocolMutation({
    type: "storage.reclaim",
    fields: {},
    result: StorageReclaimResultSchema,
    refuse: (error): StorageReclaimResult => ({ ok: false, error }),
  })],
  rows: {
    intro: (read) => {
      const reclaimable = read(storageDomain)?.usage?.reclaimableBytes ?? 0
      return reclaimable <= RECLAIM_NUDGE_BYTES ? [] : [{ id: "reclaim-storage", label: "storage", value: `${formatStorageBytes(reclaimable)} reclaimable`, hint: PICK_HINT, action: OPEN }]
    },
    status: (read) => {
      const view = read(storageDomain)
      if (view === undefined) return []
      if (view.usage === null) return [{ id: "reclaim-storage", label: "Storage", value: "measuring", action: OPEN }]
      const { storeBytes, reclaimableBytes } = view.usage
      return [{
        id: "reclaim-storage",
        label: "Storage",
        value: `${formatStorageBytes(storeBytes)}, ${formatStorageBytes(reclaimableBytes)} reclaimable`,
        hint: view.lastReclaim === null ? PICK_HINT : `Last run: ${reclaimOutcomeLabel(view.lastReclaim.outcome)}`,
        ...(reclaimableBytes > RECLAIM_NUDGE_BYTES ? { tone: "warning" as const } : {}),
        action: OPEN,
      }]
    },
  },
})
