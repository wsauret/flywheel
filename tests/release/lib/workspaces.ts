import { join } from "node:path"

import { accountServeSocketPath } from "../../../src/infra/paths.js"

/** The longest unix socket path that every supported POSIX kernel binds.
 *  macOS holds 104 bytes in `sun_path`, the terminating NUL included, and
 *  Linux holds 108. Bun binds a longer path through a directory descriptor,
 *  but a Node client, such as the editor extension, refuses it, and no real
 *  installation has one. So a measured run keeps every account socket within
 *  the limit that a person's own HOME keeps. */
const MAX_SOCKET_PATH_BYTES = 103

/** The workspace of the release run numbered `index`: the run's HOME and
 *  project root, directly below `root` and named by its number alone, so the
 *  account service socket below it stays short. The run's evidence directory
 *  keeps the descriptive names. Throws, before anything is created, when the
 *  socket path would pass the limit; the caller then passes a shorter
 *  `--work`. Windows names its socket as a pipe, so the limit does not apply
 *  there. */
export function releaseWorkspace(root: string, index: number, platform: NodeJS.Platform = process.platform): string {
  const workDir = join(root, String(index))
  if (platform === "win32") return workDir
  const socketPath = accountServeSocketPath(join(workDir, ".flywheel"), "installed", platform)
  const bytes = Buffer.byteLength(socketPath)
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`the account service socket of a release workspace under ${root} takes ${bytes} bytes, and a unix socket path holds at most 104 bytes with its terminating NUL; pass a shorter --work`)
  }
  return workDir
}
