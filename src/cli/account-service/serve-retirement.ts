/** The decisions that keep the account service up or retire it: its
 *  residency once it listens, and the checks of its build tick. */

import * as fs from "node:fs"

import type { ServeLane } from "../../infra/cli-subprocess.js"
import { errnoCode, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { ReplacementTrigger } from "../../orchestration/app-service/replacement-owner.js"
import type { InstalledBuild } from "../../orchestration/app-service/runtime-executable.js"
import type { ServiceRegistrationRefresh } from "../../orchestration/app-service/service-registration-refresh.js"

const log = Log.create({ service: "serve" })

/** Whether a serve stays up while nothing holds it, and whether that
 *  follows the account's registration. */
export interface ServeResidency {
  readonly resident: boolean
  /** An installed service that a client started in the login home. The
   *  registered job is that home's resident owner, so such a service is
   *  resident only while no registration exists: the build tick reads the
   *  registration again. */
  readonly followsRegistration: boolean
  /** Once nothing holds it, the service asks the manager to start its lane's
   *  registered job, which answers false when none exists. Every service that
   *  follows its registration does, and so does a dev service that a client
   *  started, which no registration makes resident (ARCH-RUNTIME-081). */
  readonly startsRegisteredJob: boolean
}

/** Decides whether this serve stays up while nothing holds it. A service is
 *  resident when its lane's service manager started it: the manager starts
 *  it at login and restarts it, and a phone wakes its projects through it. A
 *  dev service that something else started is never resident. An installed
 *  service that something else started, such as a client, is
 *  resident only when the account database proves its account home is the
 *  login home and no registration exists there, enabled or disabled: a
 *  registration names the job that serves that home. In any other account
 *  home, such as a test's or a harness's, nothing is registered, so a service
 *  there is restarted by nothing and serves nobody once its clients leave. It
 *  retires when unheld, as the dev lane's does. A login home or registration
 *  that cannot be read proves nothing, so it never keeps a service resident
 *  that its manager did not start. A harness that exercises the resident
 *  service in an isolated home sets FLYWHEEL_INTERNAL_RESIDENT_SERVICE=1. */
export async function serveResidency(input: {
  readonly lane: ServeLane
  readonly env: { readonly [name: string]: string | undefined }
  readonly startedByManager: () => boolean
  readonly isLoginHome: () => Promise<boolean | undefined>
  readonly registered: () => Promise<boolean>
}): Promise<ServeResidency> {
  // Residency decides whether the service ever retires, so every outcome
  // records once, with the evidence it rests on.
  const retires = { resident: false, followsRegistration: false, startsRegisteredJob: false }
  if (input.startedByManager()) {
    log.info("account service is resident: its service manager started it")
    return { resident: true, followsRegistration: false, startsRegisteredJob: false }
  }
  // A dev service that a client started runs one fixed snapshot, so only
  // the lane's registered job keeps a dev service up (ARCH-RUNTIME-081).
  if (input.lane === "dev") {
    log.info("account service is not resident: a dev-lane service stays up only under its registered job, so this one retires once nothing holds it and then asks the service manager to start that job")
    return { resident: false, followsRegistration: false, startsRegisteredJob: true }
  }
  if (input.env.FLYWHEEL_INTERNAL_RESIDENT_SERVICE === "1") {
    log.info("account service is resident: FLYWHEEL_INTERNAL_RESIDENT_SERVICE is set")
    return { resident: true, followsRegistration: false, startsRegisteredJob: false }
  }
  let login: boolean | undefined
  try {
    login = await input.isLoginHome()
  } catch (error) {
    log.warn("the login home could not be read; the account service was not started by its service manager, so it retires once nothing holds it", { error: errorMessage(error) })
    return retires
  }
  if (login !== true) {
    log.info(login === false
      ? "account service is not resident: this account home is not the login home, so it retires once nothing holds it"
      : "account service is not resident: the platform did not name the login home and no service manager started it, so it retires once nothing holds it")
    return retires
  }
  let registered: boolean
  try {
    registered = await input.registered()
  } catch (error) {
    // The build tick asks again and owns the one warning of such a streak.
    log.info("account service is not resident: whether a registration exists in the login home could not be read, so it retires once nothing holds it, and the build tick asks again", { error: errorMessage(error) })
    return { resident: false, followsRegistration: true, startsRegisteredJob: true }
  }
  log.info(registered
    ? "account service is not resident: a registration exists in the login home, so it retires once nothing holds it and then asks the service manager to start the registered job"
    : "account service is resident: this account home is the login home and no registration exists there")
  return { resident: !registered, followsRegistration: true, startsRegisteredJob: true }
}

/** The build tick's residency check of a service whose residency follows the
 *  registration: a registration that appears ends the residency, so the
 *  service retires once nothing holds it, and one that disappears makes the
 *  service resident again. The lifetime owns the residency and answers
 *  whether it changed, and each change records once. A read that does not
 *  answer keeps the residency, logs one warning for each streak of such
 *  reads, and the next tick asks again. Nothing is read before the residency
 *  is decided. */
export function createRegistrationFollower(options: {
  readonly followsRegistration: () => boolean
  readonly registered: () => Promise<boolean>
  readonly setResident: (resident: boolean) => boolean
}): () => Promise<void> {
  let unanswered = false
  return async () => {
    if (!options.followsRegistration()) return
    let registered: boolean
    try {
      registered = await options.registered()
    } catch (error) {
      if (!unanswered) log.warn("whether a registration exists could not be read; the account service keeps its residency, and the next build tick asks again", { error: errorMessage(error) })
      unanswered = true
      return
    }
    unanswered = false
    if (!options.setResident(!registered)) return
    log.info(registered
      ? "a registration now exists in the login home; the account service is no longer resident, so it retires once nothing holds it and then asks the service manager to start the registered job"
      : "no registration exists in the login home any more; the account service is resident")
  }
}

/** The service's one login-home question, which residency, the
 *  registration refresh, and the registration that residency follows share. It keeps only an answer: a question that did
 *  not answer, or that threw, proves nothing and is asked again by the next
 *  caller. Callers that ask while a question is in flight share it. */
export function rememberAnsweredLoginHome(ask: () => Promise<boolean | undefined>): () => Promise<boolean | undefined> {
  let memo: Promise<boolean | undefined> | undefined
  return () => (memo ??= ask().then(
    (login) => {
      if (login === undefined) memo = undefined
      return login
    },
    (error: unknown) => {
      memo = undefined
      throw error
    },
  ))
}

/** What the build tick reads of the account home. Only a file system that
 *  states the home is missing (ENOENT, or ENOTDIR for a path through a file)
 *  proves it gone. Any other failure, such as a permission, proves nothing,
 *  so the service keeps serving and the next tick asks again. The first
 *  unanswered read and the read that answers again are recorded; the reads
 *  between them are not. */
export function accountHomeWatch(accountHome: string, stat: (path: string) => void = fs.statSync): () => "present" | "gone" | "unknown" {
  let unanswered = false
  return () => {
    try {
      stat(accountHome)
    } catch (error) {
      const code = errnoCode(error)
      if (code === "ENOENT" || code === "ENOTDIR") return "gone"
      if (!unanswered) log.warn("the account home could not be read; the account service keeps serving and asks again at the next build tick", { accountHome, code: code ?? errorMessage(error) })
      unanswered = true
      return "unknown"
    }
    if (unanswered) log.info("the account home can be read again", { accountHome })
    unanswered = false
    return "present"
  }
}

/** Creates the service-owned cutover decision: the request path into the
 *  account's replacement owner. It re-reads the active build on every call.
 *  An unchanged build, or no build identity at all, answers `busy` and asks
 *  nothing; a newer build requests replacement by both builds, and the owner
 *  answers `busy` while blockers remain and `retiring` once the drain begins. */
export function createSupersededRetirementDecision(options: {
  readonly ownBuild: string | undefined
  readonly currentBuild: () => InstalledBuild | undefined
  readonly request: (trigger: ReplacementTrigger, beforeRetire?: () => Promise<void>) => Promise<"busy" | "retiring">
}): (beforeRetire?: () => Promise<void>) => Promise<"busy" | "retiring"> {
  return (beforeRetire) => {
    const currentBuild = options.currentBuild()
    if (options.ownBuild === undefined || currentBuild === undefined || currentBuild.buildId === options.ownBuild) return Promise.resolve("busy")
    return options.request({ kind: "newer build installed", ownBuild: options.ownBuild, installedBuild: currentBuild.buildId }, beforeRetire)
  }
}

/** The build tick's registration check: a resident service whose
 *  registration changed on disk applies what applies in place and, where
 *  only a restart applies it, requests its own planned replacement. */
export function createRegistrationRetirement(options: {
  readonly resident: Promise<boolean>
  readonly refresh: Pick<ServiceRegistrationRefresh, "atBuildTick"> | undefined
  readonly request: () => Promise<"busy" | "retiring">
}): () => Promise<void> {
  return async () => {
    if (options.refresh === undefined || !(await options.resident)) return
    if (await options.refresh.atBuildTick()) await options.request()
  }
}
