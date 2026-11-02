import type { RuntimeStartupPhase } from "./app-service-types.js"

/** Every blocking step of a start, in the order a start reaches it, with the
 *  words a person reads. Producers in four places (the client that finds the
 *  account service, the account service, the project control runtime, and
 *  the state Worker) report a step by its id, and this list alone gives the
 *  step its label and its place on the one startup progress bar. A start
 *  that does not run a step, such as one that finds the account service
 *  already serving or one where nothing was stored since the fact upgrades
 *  last ran, passes over it: each step keeps its own place, so the bar moves
 *  forward to the next step that runs and never stops short of the end. Add
 *  a step at the place where a start reaches it, or the bar moves backward. */
const STARTUP_STEPS = {
  "account-service": "Starting account service",
  "project": "Preparing project",
  "project-module-preparation": "Preparing project modules",
  "state-worker": "Starting project state worker",
  "workspace-state": "Preparing workspace state",
  // Runs once on a store from an older release, for minutes on a large one.
  "event-index": "Building event index",
  "stored-facts": "Upgrading stored facts",
  "event-store": "Opening event store",
  "sessions": "Opening sessions",
  // The start only claims each interrupted session here, with no history
  // read; the recovery itself runs later, so the step does not say it recovers.
  "interrupted-sessions": "Checking interrupted sessions",
  "project-modules": "Opening project modules",
  "project-runtime": "Opening project runtime",
  "project-transports": "Opening project transports",
} as const

/** The steps in catalog order: an object keeps the insertion order of its
 *  string keys, so this is the order of the list above. */
const ORDER: readonly string[] = Object.keys(STARTUP_STEPS)

export type StartupStep = keyof typeof STARTUP_STEPS

/** One pass of a step that runs a known number of passes, such as one fact
 *  upgrade of the stored-fact step. `step` counts from 1. */
interface StartupPass {
  readonly label: string
  readonly step: number
  readonly total: number
}

/** The step a start has reached, as producers of one build hand it to each
 *  other, across the state Worker's port included. It carries no words a
 *  person reads: only `startupPhase` gives it those, so no producer can
 *  report a label the catalog does not hold. */
export interface StartupReached {
  readonly step: StartupStep
  readonly pass?: StartupPass
}

/** Whether `value` names a step of this build's catalog. */
export function isStartupStep(value: unknown): value is StartupStep {
  return typeof value === "string" && Object.hasOwn(STARTUP_STEPS, value)
}

/** The phase a reader shows when a start reaches a step: the step's label
 *  and its place among all steps. A pass names itself and its own count
 *  inside the step's label and leaves the bar at the step, so the bar's
 *  count always counts steps of the whole start. The phase keeps the wire
 *  shape every reader of this protocol decodes (a label and an optional
 *  count), so a client of any build that speaks it shows the bar. */
export function startupPhase({ step, pass }: StartupReached): RuntimeStartupPhase {
  const label = STARTUP_STEPS[step]
  return {
    label: pass === undefined ? label : `${label}, pass ${pass.step} of ${pass.total}: ${pass.label}`,
    progress: { step: ORDER.indexOf(step) + 1, total: ORDER.length },
  }
}
