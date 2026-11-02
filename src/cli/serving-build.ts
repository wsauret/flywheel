import { accessSync, constants, readFileSync } from "node:fs"
import { basename, join } from "node:path"

import type { ServeLane } from "../infra/cli-subprocess.js"
import { versionsDir } from "../infra/paths.js"
import { assertInstallLocation, BUILD_METADATA_FILE, buildExecutable, decodeBuildMetadata, NATIVE_DIR } from "../infra/update/build-identity.js"
import type { RuntimeIdentity } from "./runtime-attach.js"
import type { TerminalSuccessor } from "./terminal-handoff.js"

/** The build a terminal re-executes into when the account service speaks a
 *  protocol it cannot: the one that serves, never a guess at `current`. */
export interface ServingBuild extends TerminalSuccessor {
  /** The build's version, as the service states it. */
  readonly version: string
}

export interface ServingBuildInput {
  readonly lane: ServeLane
  readonly platform: NodeJS.Platform
  /** This build's release target (`buildPlatformArch`). The serving build is
   *  of the same installation, so its native directory carries that name. */
  readonly platformArch: string
  readonly userDataRoot: string
  /** The listening service's identity record. */
  readonly identity: RuntimeIdentity
  /** The build this process runs. A service that names it offers nothing to follow. */
  readonly ownBuild: string | undefined
  /** How this account starts a Flywheel of this lane from its source checkout. */
  readonly sourceCommand: readonly string[]
}

/** Resolves the service's identity to a program this terminal can become, or
 *  answers why it cannot. The service is Flywheel's, yet its record is read
 *  from disk, so each name that becomes a path is checked before it is one. */
export function servingBuild(input: ServingBuildInput): ServingBuild | string {
  const { identity } = input
  if (identity.buildId === undefined) return "the account service does not name its build"
  if (identity.buildId === input.ownBuild) return "the account service names this terminal's own build"
  // A source checkout serves the protocol its source declares, and its entry
  // builds that source afresh, so the checkout's entry is the serving build.
  if (input.lane === "dev") return { version: identity.version, command: input.sourceCommand, env: {} }
  const { version, buildId } = identity
  if (!isPathComponent(version) || !isPathComponent(buildId)) return "the account service names a build outside the versions home"
  const directory = join(versionsDir(input.userDataRoot), version, buildId)
  const executable = join(directory, buildExecutable(input.platform))
  try {
    assertInstallLocation(decodeBuildMetadata(readFileSync(join(directory, BUILD_METADATA_FILE), "utf8")), directory)
    accessSync(executable, constants.X_OK)
  } catch (error) {
    return `the serving build ${version} is not installed at ${directory}: ${error instanceof Error ? error.message : String(error)}`
  }
  return { version, command: [executable], env: { FLYWHEEL_NATIVE_DIR: join(directory, NATIVE_DIR, input.platformArch) } }
}

function isPathComponent(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && basename(name) === name && !name.includes("\\")
}
