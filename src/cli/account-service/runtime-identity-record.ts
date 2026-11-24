import { readFileSync } from "node:fs"

import type { SourceSnapshotLocation } from "../../infra/cli-subprocess.js"
import { decodeHolderFields, type ProcessHolder } from "../../infra/process-holder.js"
import type { RuntimeIdentity as DisplayedRuntimeIdentity } from "../../protocol/client/runtime-identity.js"

/** A lane's identity record: the service that published its address. The
 *  record lives while that service serves, so a record whose holder is gone
 *  is the trace of a service that ended without its exit path. */
export interface RuntimeIdentity {
  readonly pid: number
  readonly version: string
  readonly protocolVersion?: number
  readonly buildId?: string
  /** The code identity a person reads, as `runningDisplayBuildId` states it.
   *  Absent when the service runs live from source or predates the field. */
  readonly displayBuildId?: string
  /** The snapshot of its checkout that a dev service runs from. A record
   *  without it, which a service before snapshots and every installed
   *  service writes, names none. */
  readonly sourceSnapshot?: SourceSnapshotLocation
  /** The process that published the record. The holder fields sit flat
   *  beside `pid`. A record without them names no identity: an earlier build
   *  wrote it, or a service that could not read its own identity. It is a
   *  valid shape for good, not a shape to convert. */
  readonly holder: ProcessHolder
}

/** The identity a client shows for the service a record names: the display
 *  build the service wrote from `runningDisplayBuildId`, the same value its
 *  snapshots state. A record from a service that predates the field names
 *  none, and the first snapshot supplies it. */
export function displayedRuntimeIdentity(identity: RuntimeIdentity): DisplayedRuntimeIdentity {
  return { version: identity.version, buildId: identity.displayBuildId ?? null }
}

function isSourceSnapshotLocation(value: unknown): value is SourceSnapshotLocation {
  return typeof value === "object" && value !== null
    && "checkout" in value && typeof value.checkout === "string"
    && "digest" in value && typeof value.digest === "string"
}

export function readRuntimeIdentity(identityPath: string): RuntimeIdentity | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(identityPath, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    if (!("pid" in parsed) || typeof parsed.pid !== "number") return undefined
    if (!("version" in parsed) || typeof parsed.version !== "string") return undefined
    return {
      pid: parsed.pid,
      version: parsed.version,
      ...("protocolVersion" in parsed && typeof parsed.protocolVersion === "number" ? { protocolVersion: parsed.protocolVersion } : {}),
      ...("buildId" in parsed && typeof parsed.buildId === "string" ? { buildId: parsed.buildId } : {}),
      ...("displayBuildId" in parsed && typeof parsed.displayBuildId === "string" ? { displayBuildId: parsed.displayBuildId } : {}),
      ...("sourceSnapshot" in parsed && isSourceSnapshotLocation(parsed.sourceSnapshot) ? { sourceSnapshot: { checkout: parsed.sourceSnapshot.checkout, digest: parsed.sourceSnapshot.digest } } : {}),
      holder: decodeHolderFields(parsed.pid, {
        v: "v" in parsed ? parsed.v : undefined,
        start: "start" in parsed ? parsed.start : undefined,
        boot: "boot" in parsed ? parsed.boot : undefined,
      }),
    }
  } catch {
    return undefined
  }
}
