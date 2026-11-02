import type { UpdateStatus } from "../update-protocol-types.js"

/** How many characters of a build identity or a snapshot digest name it. */
const SHORT_ID_LENGTH = 8

/** One line for what the updater knows, from the live `updates` view. The
 *  web client shows these words for every status, and the terminal's Status
 *  row shows them for a build that does not update itself and for a release
 *  or a checkout's source that could not start on this machine. A refused build of the running build's version is named
 *  by its short build identity too, because the version alone would name the
 *  running build. A view that has not arrived yet reads as up to date. The
 *  switch has no default, so a new status kind cannot compile until it has
 *  its own words. */
export function describeUpdateStatus(status: UpdateStatus | undefined): string {
  switch (status?.kind) {
    case undefined:
    case "idle":
      return "up to date"
    case "no-repository":
      return "updates off: this build names no release repository"
    case "refused":
      return `${status.version}${status.buildId === undefined ? "" : ` build ${status.buildId.slice(0, SHORT_ID_LENGTH)}`} could not start on this machine`
    case "source-refused":
      return `source ${status.refused.slice(0, SHORT_ID_LENGTH)} could not start; running source ${status.running.slice(0, SHORT_ID_LENGTH)}`
    case "available":
      return `${status.version} available`
    case "installing":
      return `installing ${status.version}`
    case "installed":
      return `${status.version} installed, restart to use it`
  }
}
