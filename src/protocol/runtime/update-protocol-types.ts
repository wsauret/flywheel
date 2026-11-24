import type { RuntimePosition } from "./runtime-ui-protocol-types.js"

/** What stands between this account and a release it found. It is the reason
 *  the user is given, so it is decided where the refusal is decided rather
 *  than re-derived by whoever renders it:
 *  - `nothing`: this Flywheel can install it, and no attempt has landed yet.
 *  - `auto-install-off`: the effective policy forbids installing.
 *  - `platform`: this runtime has no installer bound, so it can discover a
 *    release and owns no way to take it. */
type UpdateBlocking = "nothing" | "auto-install-off" | "platform"

/** What the runtime publishes about updates. Each variant carries exactly the
 *  fields it means:
 *  - `idle`: nothing actionable is known.
 *  - `no-repository`: this build names no release repository, so it never
 *    checks for or installs updates (ARCH-DISTRIBUTION-034).
 *  - `refused`: this account runs an older build in place of the build a
 *    rollback refused because it could not start or could not open any
 *    project on this machine (ARCH-DISTRIBUTION-024). `version` is the refused build's
 *    version, and `buildId` names it too when that version is the running
 *    build's own, as after a local rebuild. It holds with no check, and a
 *    newer release installs normally.
 *  - `source-refused`: this dev service runs the last proved snapshot of its
 *    checkout, `running`, because the source `refused` could not start
 *    (ARCH-DISTRIBUTION-030). Both are snapshot digests.
 *  - `available`: a newer release exists and is not active, with the reason.
 *  - `installing`: this process owns the fenced attempt on that release.
 *  - `installed`: the next launch runs that version. */
export type UpdateStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "no-repository" }
  | { readonly kind: "refused"; readonly version: string; readonly buildId?: string }
  | { readonly kind: "source-refused"; readonly refused: string; readonly running: string }
  | { readonly kind: "available"; readonly version: string; readonly blocking: UpdateBlocking }
  | { readonly kind: "installing"; readonly version: string }
  | { readonly kind: "installed"; readonly version: string }

/** The account's auto-install setting, as a user has to be able to read it: a
 *  toggle writes `persisted`, every admission decision obeys `effective`, and
 *  `forcedOff` is the only thing that explains a difference between them. One
 *  boolean could not say "on, but held off for this run", which is why a
 *  toggle against it could report success and change nothing visible. */
export interface UpdateAutoInstall {
  /** What the config file says, and what a toggle writes. */
  readonly persisted: boolean
  /** `FLYWHEEL_DISABLE_AUTOUPDATE` holds this run off, whatever the durable
   *  setting says, so a row can explain itself in both directions. */
  readonly forcedOff: boolean
  /** What every update decision reads. */
  readonly effective: boolean
}

/** One published view. `revision` advances on every change, so a receiver
 *  that collapses to the latest can still tell two views apart. */
export interface UpdateStatusView {
  readonly revision: number
  readonly autoInstall: UpdateAutoInstall
  readonly status: UpdateStatus
  /** The account's post-update welcome notice. Absent after dismissal and in source runs. */
  readonly releaseNotice?: ReleaseNotice
}

/** Runtime-computed copy and destination; clients render without reading release bodies. */
export interface ReleaseNotice {
  readonly version: string
  readonly message: string
  readonly url: string
}
/** The workspace update domain: one runtime-wide view of what Flywheel could
 *  run and whether it may install it (ARCH-PROTOCOL-043). It is the TUI's sole source
 *  for the settings value, the status row, and the global notice, so the
 *  policy is never copied into a client-side store.
 *
 *  Delivery is latest-collapsible: one patch carries the whole view, so the
 *  newest supersedes anything it overtook and a client that missed one needs
 *  no resnapshot. `revision` advances with every published change, which is
 *  what lets a receiver tell two views apart after collapsing. */
export interface RuntimeUpdateSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly update: UpdateStatusView
}

export type UpdatePatchPayload = { readonly kind: "update.changed"; readonly update: UpdateStatusView }

export function updatesCursor() {
  return { scope: "workspace", domain: "updates" } as const
}
