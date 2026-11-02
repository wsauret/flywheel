import { lstatSync, type BigIntStats } from "node:fs"

/** A regular file's identity, size, and timestamps. Same-tick writes can share a fingerprint. */
export interface FileFingerprint { readonly kind: "file"; readonly identity: string; readonly size: number; readonly mtimeNs: bigint; readonly ctimeNs: bigint }

/** A target's state observed before admission, for example when a private copy of the project was taken.
 * `sha256` pins exact bytes when the observation was too close to the file's last change for timestamps
 * alone to prove that no later write landed in the same tick. */
export type ExpectedFileState = { readonly kind: "absent" } | (FileFingerprint & { readonly sha256?: string })

export type ObservedFileState = { readonly kind: "absent" } | { readonly kind: "other" } | FileFingerprint

/** Observes one path without following a final symlink. */
export function observeFileState(path: string): ObservedFileState {
  const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (!stats) return { kind: "absent" }
  return stats.isFile() ? fileFingerprint(stats) : { kind: "other" }
}

/** The fingerprint of a regular file's stats. */
export function fileFingerprint(stats: BigIntStats): FileFingerprint {
  return { kind: "file", identity: `${stats.dev}:${stats.ino}`, size: Number(stats.size), mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs }
}

/** Compares an observation with an expected state by fingerprint. A pinned hash needs the bytes and is checked by the caller. */
export function sameObservedState(actual: ObservedFileState, expected: ExpectedFileState): boolean {
  if (actual.kind !== "file" || expected.kind !== "file") return actual.kind === expected.kind
  return actual.identity === expected.identity && actual.size === expected.size && actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs
}
