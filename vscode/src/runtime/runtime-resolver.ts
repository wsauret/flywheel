import { probeVersion } from "./probe-version.js"
import { isVersionAtLeast } from "./supervisor.js"

/** Finds the Flywheel the extension serves an editor from.
 *
 *  The extension carries no runtime. It uses the account's own install, which
 *  every update keeps current, and installs Flywheel through the platform's
 *  bootstrap installer only when there is none (see `bootstrap-install.ts`).
 *  The order is one strict override followed by two discovered candidates:
 *
 *  1. An explicit setting. Someone who names a binary means it, including a
 *     development build, and nothing here second-guesses that.
 *  2. The launcher at the path the installer places it. It comes before PATH
 *     because the installer's PATH edit reaches a shell profile, never an
 *     editor that is already running.
 *  3. `flywheel` on PATH, for an install the account put somewhere else.
 *
 *  The first compatible candidate wins. A candidate older than the minimum is
 *  reported rather than replaced: installing over it would bypass the
 *  account's own update setting (PI-UPDATES-016). */

/** The oldest Flywheel this build serves an editor from. It names a public
 *  release, never an unreleased one: a checkout reports the last public
 *  version, so a minimum above it would refuse the checkout itself. It moves
 *  to the first release that answers the `client` attach in this build's
 *  protocol when the package carrying this build is published, which happens
 *  only after that release is public (`scripts/e2e-bootstrap.ts` proves it
 *  before publication). */
export const MINIMUM_RUNTIME_VERSION = "0.0.11"

type RuntimeSource = "setting" | "launcher" | "path"

export interface ResolvedRuntime {
  readonly executable: string
  readonly version: string
  readonly source: RuntimeSource
}

export type ResolveFailure =
  | { readonly kind: "none_found" }
  | { readonly kind: "too_old"; readonly executable: string; readonly version: string; readonly source: RuntimeSource }
  | { readonly kind: "setting_unusable"; readonly executable: string; readonly detail: string }

type ResolveResult =
  | { readonly ok: true; readonly runtime: ResolvedRuntime }
  | { readonly ok: false; readonly failure: ResolveFailure }

interface ResolveOptions {
  /** `flywheel.executablePath`, when the user set one. */
  readonly configured?: string | undefined
  /** Where the account's installer places the launcher (`installedLauncherPath`). */
  readonly launcher: string
  readonly minimumVersion: string
  /** Test seam. */
  readonly probe?: (executable: string) => Promise<string | undefined>
}

export async function resolveRuntime(options: ResolveOptions): Promise<ResolveResult> {
  const probe = options.probe ?? probeVersion

  const configured = options.configured?.trim()
  if (configured) {
    const version = await probe(configured)
    if (version === undefined) {
      // An explicit setting that does not work is an error, never a reason to
      // quietly run something else: the user would be told they are on the
      // build they named while they are not.
      return { ok: false, failure: { kind: "setting_unusable", executable: configured, detail: "did not report a version" } }
    }
    if (!isVersionAtLeast(version, options.minimumVersion)) {
      return { ok: false, failure: { kind: "too_old", executable: configured, version, source: "setting" } }
    }
    return { ok: true, runtime: { executable: configured, version, source: "setting" } }
  }

  const candidates = [
    { executable: options.launcher, source: "launcher" },
    { executable: "flywheel", source: "path" },
  ] as const
  const versions = await Promise.all(candidates.map((candidate) => probe(candidate.executable)))
  const found = candidates.flatMap((candidate, index) => {
    const version = versions[index]
    return version === undefined ? [] : [{ ...candidate, version }]
  })
  const compatible = found.find((candidate) => isVersionAtLeast(candidate.version, options.minimumVersion))
  if (compatible) return { ok: true, runtime: compatible }
  // Having Flywheel but an older one is a different problem from having none,
  // and the message says which install it is.
  const older = found[0]
  if (older) return { ok: false, failure: { kind: "too_old", ...older } }
  return { ok: false, failure: { kind: "none_found" } }
}

/** What a person reads when the resolver found a Flywheel it cannot use. */
export function describeResolveFailure(failure: Exclude<ResolveFailure, { readonly kind: "none_found" }>): string {
  switch (failure.kind) {
    case "too_old":
      return failure.source === "setting"
        ? `The Flywheel at ${failure.executable} is ${failure.version}, and this extension needs ${MINIMUM_RUNTIME_VERSION} or newer. Point flywheel.executablePath at a newer build, or clear it to use your installed Flywheel.`
        : `Flywheel ${failure.version} at ${failure.executable} is older than this extension needs (${MINIMUM_RUNTIME_VERSION} or newer). Run \`flywheel update\` in a terminal.`
    case "setting_unusable":
      return `flywheel.executablePath points at ${failure.executable}, which ${failure.detail}. Fix the setting or clear it to use your installed Flywheel.`
  }
}
