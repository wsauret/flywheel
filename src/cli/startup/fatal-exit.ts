import { importComposing } from "../composition/module-registries.js"
import { installCrashPolicy, type UncaughtKind } from "../../infra/process/crash-policy.js"
import { errorDetail, errorMessage } from "../../infra/diagnostics/error-message.js"
import { Log } from "../../infra/diagnostics/log.js"

/** The entry's one fatal path (ARCH-RUNTIME-030). A failure thrown to the entry's
 *  catch, and an uncaught failure of the account service's thread that its
 *  crash policy does not contain, both end here: one line on standard error,
 *  one `fatal` record, one decision of the lane's failing streak, and one exit
 *  code. */

/** How a fatal failure reached the entry: thrown to the entry's catch, or
 *  uncaught on the account service's thread. */
type FatalKind = "thrown" | UncaughtKind

/** The first failure's exit code, once a failure is deciding it. */
let decision: Promise<number> | undefined

/** Ends the process with the code that the first failure decides, as soon
 *  as it is decided, so a failure that cascades from the first never exits
 *  with a code that restarts a lane the first one parked. The code is 1
 *  when no failure is deciding. The decision always comes: `fatalExitCode`
 *  awaits only module imports, no module of `src/` awaits at its top level,
 *  and an import that fails answers 1. */
async function exitNow(): Promise<void> {
  process.exit(decision === undefined ? 1 : await decision)
}

/** This process's one fatal exit. The first failure is named, recorded, and
 *  decided by `fatalExitCode`, and the process exits with the code that
 *  decision answers once the log is closed. Every later failure is the same
 *  process's end, so it only waits for that code through `exitNow`. */
export async function exitFatally(failure: unknown, kind: FatalKind): Promise<void> {
  if (decision !== undefined) return exitNow()
  decision = fatalExitCode(failure, kind).catch(() => 1)
  const code = await decision
  await Log.closeGlobal().finally(() => { process.exit(code) })
}

/** Contains a floating abort on the account service's thread, and sends
 *  every other uncaught failure to this process's one fatal exit, which the
 *  entry's catch shares. */
export function installAccountCrashPolicy(): void {
  installCrashPolicy({ role: "account-service", log: Log.Default, fatal: exitFatally, exitNow: () => { void exitNow() } })
}

/** Names and records a fatal failure, and answers the code it exits with.
 *  Every thrown failure of a service start ends here, including a failure
 *  before `runServe` handles its own errors and a failure to import the
 *  command's composition or the serve command, and so does every uncaught
 *  failure of the account service's thread. A start of the installed account
 *  service adds its failure to the lane's failing streak, which decides how
 *  loud the fatal record is, and exits with the code that parks the service
 *  when the streak persists. Every other fatal failure exits 1, and so does a
 *  failure to load the modules that decide. */
async function fatalExitCode(error: unknown, kind: FatalKind): Promise<number> {
  const message = errorMessage(error)
  const record = (repeat: boolean): void => {
    const fields = { kind, error: message, errorDetail: errorDetail(error) }
    if (repeat) Log.Default.debug("fatal", fields)
    else Log.Default.error("fatal", fields)
  }
  let failServiceStart
  let serviceListened
  let ServeStartupFailure
  let startHeldByHost
  let SERVE_EXIT
  try {
    ;({ failServiceStart, serviceListened } = await importComposing(() => import("../../orchestration/update/service-start.js")))
    ;({ ServeStartupFailure, startHeldByHost } = await import("../../protocol/runtime/serve-handshake.js"))
    ;({ SERVE_EXIT } = await import("../account-service/serve-contract.js"))
  } catch (loadError) {
    // A process that cannot load the start's own module never listened.
    announce(kind, false, message)
    record(false)
    Log.Default.warn("the failed start could not be added to its lane's failing streak", { error: errorMessage(loadError) })
    return 1
  }
  announce(kind, serviceListened(), message)
  if (!serviceListened() && !startHeldByHost(error) && await returnedToProvedSource(message)) return SERVE_EXIT.restart
  // The command runner throws an error of its own that wraps the command's.
  const failure = [error, error instanceof Error ? error.cause : undefined].find((candidate) => candidate instanceof ServeStartupFailure)
  // Every kind joins the streak as a thrown failure: only a person clears an
  // uncaught failure, as only a person clears a thrown one.
  return failServiceStart({ cause: message, causeKind: "thrown", refusal: failure?.refusal }, record) === "park" ? SERVE_EXIT.parked : 1
}

/** Logging may point to a file, so the failure is also named on standard
 *  error, where a failed start stays visible on the terminal. A thrown
 *  failure before the service listened, and a thrown failure of a command
 *  that starts no service, failed to start. Every other failure is named by
 *  how it reached the entry. */
function announce(kind: FatalKind, listened: boolean, message: string): void {
  const words = kind !== "thrown" ? `fatal ${kind}` : listened ? "fatal thrown failure" : "failed to start"
  process.stderr.write(`flywheel: ${words}: ${message}\n`)
}

/** A dev service start from a snapshot that fails before it listens, for a
 *  cause of its own build, refuses that snapshot and exits to be restarted
 *  on the proved one (`refuseFailedServiceStart`). A failure to import the
 *  CLI itself never reaches this path; the dev entry refuses that one.
 *  Answers whether it refused. */
async function returnedToProvedSource(message: string): Promise<boolean> {
  try {
    const [{ runningSourceSnapshot }, { startsServiceProcess }] = await Promise.all([import("../../infra/platform/cli-subprocess.js"), import("../account-service/serve-contract.js")])
    const snapshot = runningSourceSnapshot()
    if (snapshot === undefined || !startsServiceProcess(process.argv)) return false
    const { refuseFailedServiceStart } = await import("../../infra/update/distribution/source-snapshot.js")
    return refuseFailedServiceStart(snapshot, message)
  } catch (error) {
    Log.Default.warn("the dev service failed to start and its snapshot could not be refused", { error: errorMessage(error) })
    return false
  }
}
