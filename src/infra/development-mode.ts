/** Whether this process runs from the source tree rather than a compiled
 *  build. Compiled builds embed their identity as FLYWHEEL_APP_VERSION; a
 *  source run has none. Build provenance keys off this one decision; the
 *  development tooling itself is a module the source entry installs, not a
 *  branch on it. */
export function isDevelopmentBuild(): boolean {
  return process.env.FLYWHEEL_APP_VERSION === undefined;
}
