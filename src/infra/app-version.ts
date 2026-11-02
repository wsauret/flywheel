/** This build's version, as every host reports it. The environment override is
 *  what a build that is not running from its own package tree sets, so a
 *  standalone executable and a source checkout answer the same question the
 *  same way. */
export async function readAppVersion(): Promise<string> {
  if (process.env.FLYWHEEL_APP_VERSION) return process.env.FLYWHEEL_APP_VERSION

  const packageJson: object = await Bun.file(new URL("../../package.json", import.meta.url)).json()
  const version = "version" in packageJson ? packageJson.version : undefined
  return typeof version === "string" ? version : "0.0.0"
}
