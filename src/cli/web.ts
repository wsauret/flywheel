import { readFileSync } from "node:fs"

import type { StartupDirectories } from "../infra/directory-authorities.js"
import { errorMessage } from "../infra/error-message.js"
import type { ExternalUrlOpener } from "../infra/open-external-url.js"
import { accountHubOrigin } from "../infra/paths.js"
import { releaseHarnessHub } from "./release-harness.js"
import type { AccountRuntimeAttach } from "./runtime-attach.js"

const USAGE = `Usage: flywheel web

Open this account's projects in the local browser.

Options:
  -h, --help    Show this help and exit.`

export interface WebCommandDependencies {
  readonly log: (message: string) => void
  readonly error: (message: string) => void
  /** The environment that states whether the release harness moved the hub. */
  readonly env?: { readonly [name: string]: string | undefined }
}

const defaultDependencies: WebCommandDependencies = { log: console.log, error: console.error }

/** The hub address of the service this command ensured: its lane's fixed
 *  address, or under the release harness the address the service recorded.
 *  A harness hub without a record has no address a client can know, so the
 *  command opens nothing rather than the person's own hub. */
function hubOrigin(lane: AccountRuntimeAttach["lane"], env: { readonly [name: string]: string | undefined }): string | undefined {
  const harness = releaseHarnessHub(env)
  if (harness === undefined) return accountHubOrigin(lane)
  return harness.record === undefined ? undefined : readFileSync(harness.record, "utf8").trim()
}

/** Ensures the resident account service and opens its local wake page. */
export async function runWeb(
  args: readonly string[],
  _directories: StartupDirectories,
  attach: AccountRuntimeAttach,
  openBrowser: ExternalUrlOpener,
  dependencies: WebCommandDependencies = defaultDependencies,
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    dependencies.log(USAGE)
    return
  }
  const unexpected = args[0]
  if (unexpected !== undefined) {
    dependencies.error(`Unknown web argument: ${unexpected}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }

  await attach.ensure(() => {})
  // The service opens the project and its web client before it answers, so
  // a project that cannot serve the page is named here and no browser opens.
  try {
    await attach.openProject()
  } catch (error) {
    dependencies.error(`flywheel web: ${errorMessage(error)}`)
    process.exitCode = 1
    return
  }
  const hub = hubOrigin(attach.lane, dependencies.env ?? process.env)
  if (hub === undefined) {
    dependencies.error("flywheel web: the release harness hub records no address. Set FLYWHEEL_INTERNAL_RELEASE_HUB_RECORD.")
    process.exitCode = 1
    return
  }
  const origin = `${hub}/`
  if (await openBrowser(origin)) dependencies.log(`Opened ${origin} in your browser.`)
  else {
    dependencies.log(origin)
    dependencies.error("Could not open the browser. Open the URL above manually.")
  }
}
