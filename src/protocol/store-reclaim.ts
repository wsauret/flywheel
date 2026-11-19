/** The outcome of one Reclaim storage run, which the kernel produces and the
 *  storage module publishes. `refused` changed nothing. */
export type StorageReclaimOutcome =
  | { readonly kind: "reclaimed"; readonly beforeBytes: number; readonly afterBytes: number; readonly rowsDeleted: number }
  | { readonly kind: "refused"; readonly reason: "disk-space" | "busy" | "no-store"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }

/** What Reclaim storage shows before the person confirms: the store, what
 *  the run can give back, and the free space the rebuild needs on the
 *  tightest disk. `refusal` says why the run would refuse now. Null when the
 *  project holds no store, or no account service serves it. */
export type StorageReclaimPreview = {
  readonly storeBytes: number
  readonly reclaimableBytes: number
  readonly freeBytes: number
  readonly neededBytes: number
  readonly refusal?: string
} | null

/** Bytes in the binary units every storage line shows. */
export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB", "TiB"] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
