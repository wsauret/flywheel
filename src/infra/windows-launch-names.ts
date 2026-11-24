/** The Windows names of one owned launch's resources. The launcher creates them and the command supervisor and the
 *  container processor open them, so the names sit below all three. */

/** The name a launch's job object is created under. One namespace, so a stray
 *  container is recognizable, and the ownership token, so the name is used
 *  once. */
export function windowsContainerName(token: string): string {
  return `Flywheel.container.${token}`
}

/** The launcher's control channel for one launch.
 *
 *  Windows has no descriptor a child can inherit beyond its three streams, so
 *  the channel is a named pipe. The name is the ownership token for the same
 *  reason the container's is: it belongs to exactly one launch, so no two
 *  launches can reach each other's channel. */
export function windowsControlChannelName(token: string): string {
  return String.raw`\\.\pipe\Flywheel.control.` + token
}
