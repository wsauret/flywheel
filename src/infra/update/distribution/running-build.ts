import { runningSourceSnapshot, runsThroughBun } from "../../platform/cli-subprocess.js"
import { executableBuild } from "../live-builds.js"

/** What an executable says it is, read at one moment: a source run, an
 *  installed build with the directory it was launched from, or nothing
 *  Flywheel installed. */
export type RunningBuild =
  | { readonly kind: "source" }
  | { readonly kind: "installed"; readonly buildId: string; readonly buildDir: string }
  | { readonly kind: "unknown" }

let processBuild: RunningBuild | undefined

/** The build this process executes, read once and kept. The CLI entry reads
 *  it first, so every later question about this process's build is answered
 *  by that one read of an immutable build directory. It is what the
 *  executable says it is: the protocol a source run was loaded with, or the
 *  build directory it runs from, never `current`, which an install can move
 *  to a newer build at any moment. */
export function processRunningBuild(): RunningBuild {
  processBuild ??= readRunningBuild()
  return processBuild
}

function readRunningBuild(): RunningBuild {
  if (runsThroughBun(process.execPath)) return { kind: "source" }
  const build = executableBuild(process.execPath)
  return build === undefined ? { kind: "unknown" } : { kind: "installed", ...build }
}

/** The code identity of this process for a person to read, or null when it
 *  cannot be known: a source run's snapshot digest, or the installed build id
 *  captured at process start. The protocol-only source id names no code, and
 *  neither the `current` link nor a checkout's HEAD says what runs. */
export function runningDisplayBuildId(build: RunningBuild = processRunningBuild()): string | null {
  if (build.kind === "source") return runningSourceSnapshot()?.digest ?? null
  return build.kind === "installed" ? build.buildId : null
}
