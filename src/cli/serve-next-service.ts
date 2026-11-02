import type { StartupDirectories } from "../infra/directory-authorities.js"
import { errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import type { AccountServiceInstallation } from "../orchestration/app-service/account-service-installation.js"
import { launchAccountRuntime } from "./runtime-attach.js"

const log = Log.create({ service: "serve" })

/** Why a serving account service stopped. An account home that no longer
 *  exists stops it as `unheld`. */
export type ServeStop = "retired" | "signaled" | "unheld"

/** The service that a stopping service starts once its address is free. */
export type NextService = "own successor" | "registered job" | "none"

/** Decides which service follows a stopping one. A resident service retires
 *  for a newer build or a replacement. Its service manager restarts one that
 *  it started. Nothing restarts any other, such as one in the login home
 *  with Process initiation Off, so that service starts its own successor. A
 *  client-started service in the login home whose registration appeared
 *  hands the lane to the registered job once nothing holds it. */
export function nextService(stop: ServeStop, service: { readonly resident: boolean; readonly startedByManager: boolean; readonly followsRegistration: boolean }): NextService {
  if (stop === "retired" && service.resident && !service.startedByManager) return "own successor"
  if (stop === "unheld" && service.followsRegistration) return "registered job"
  return "none"
}

/** Starts the next service once this service's address and hub port are
 *  free. It never throws: a start that fails is recorded, and the next
 *  client starts a service. */
export async function startNextService(next: NextService, start: {
  readonly registration: () => Pick<AccountServiceInstallation, "start">
  readonly successor: () => Promise<void>
}): Promise<void> {
  if (next === "registered job") await startRegisteredJob(start.registration())
  else if (next === "own successor") await start.successor()
}

/** Starts the service that follows a resident service that retired, from the
 *  build a start runs now, as a client starts one. */
export async function startSuccessorService(directories: StartupDirectories, allowPersistentProcesses: boolean): Promise<void> {
  try {
    await launchAccountRuntime({ ...directories, allowPersistentProcesses }, () => {}, new AbortController().signal)
    log.info("the retiring account service started its successor, which is listening")
  } catch (error) {
    log.warn("the retiring account service could not start its successor; the next client starts one", { error: errorMessage(error) })
  }
}

/** A client-started service in the login home that retires because nothing
 *  holds it hands the lane to the registered job with the one start request
 *  a client makes. A disabled or missing registration starts nothing. */
async function startRegisteredJob(registration: Pick<AccountServiceInstallation, "start">): Promise<void> {
  try {
    log.info(await registration.start()
      ? "the account service released its address and asked the service manager to start the registered job"
      : "the account service released its address; no enabled registration exists, so nothing starts in its place")
  } catch (error) {
    log.warn("the service manager did not start the registered job; the next client asks it again", { error: errorMessage(error) })
  }
}
