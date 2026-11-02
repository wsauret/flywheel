import * as fs from "node:fs"

import type { ServeLane } from "../../infra/cli-subprocess.js"
import { ContainedDirectory } from "../../infra/descriptor-directory.js"
import { FLYWHEEL_DIR_NAME } from "../../infra/directory-authorities.js"
import { Log } from "../../infra/log.js"
import { registerSharedHolderIn, releaseSharedHolderIn, sharedHoldersIn, withLockIn, type SharedHold } from "../../infra/ownership-file-lock.js"
import { ACCOUNT_DRAIN_HARD_EXIT_MS } from "./runtime-shutdown.js"

const log = Log.create({ service: "project-serving-lane" })

const otherLane = (lane: ServeLane): ServeLane => lane === "installed" ? "dev" : "installed"

const servingGate = (lane: ServeLane): string => `project-serving.${lane}.lock`
const executionGate = "project-execution.lock"
const headlessGate = "project-execution.headless.lock"

const SAME_LANE_POLL_MS = 50

function openFlywheelDirectory(projectRoot: string): ContainedDirectory {
  // The base must exist before a contained operation can open it; a project
  // opened for the first time keeps the user's own mode on its root, and
  // everything Flywheel owns below it is private.
  fs.mkdirSync(projectRoot, { recursive: true })
  return ContainedDirectory.open(projectRoot, [FLYWHEEL_DIR_NAME], { privateDirectories: true })
}

/** The live processes of `lane` that serve the project now. A read only: a
 *  project whose directory or state directory is absent has no server, and
 *  the read creates neither, so asking about a project the person deleted
 *  never brings it back. */
export function projectServingPids(projectRoot: string, lane: ServeLane): readonly number[] {
  const flywheel = ContainedDirectory.openExisting(projectRoot, [FLYWHEEL_DIR_NAME])
  if (flywheel === undefined) return []
  try {
    return sharedHoldersIn(flywheel, servingGate(lane)).pids
  } finally {
    flywheel.close()
  }
}

function refuseExecutionHolder(flywheel: ContainedDirectory, projectRoot: string, gate: string, owner: string): void {
  const { pids, unreadable } = sharedHoldersIn(flywheel, gate)
  if (pids.length === 0 && unreadable === 0) return
  const holders = [
    ...(pids.length > 0 ? [`pid ${pids.join(", ")}`] : []),
    ...(unreadable > 0 ? [`${unreadable} ${unreadable === 1 ? "holder" : "holders"} whose record cannot be read`] : []),
  ]
  throw new Error(`${projectRoot} is open in ${owner} (${holders.join("; ")}); close it there or open it from that lane`)
}

/** Owns the claim's directory until release, including failed acquisition. */
async function claimProjectExecution(projectRoot: string, acquire: (flywheel: ContainedDirectory, register: (gate: string) => void) => Promise<void>): Promise<() => void> {
  const flywheel = openFlywheelDirectory(projectRoot)
  let hold: SharedHold | undefined
  try {
    await acquire(flywheel, (gate) => { hold = registerSharedHolderIn(flywheel, gate) })
  } catch (error) {
    try {
      if (hold) releaseSharedHolderIn(flywheel, hold)
    } finally {
      flywheel.close()
    }
    throw error
  }
  return () => {
    if (!hold) return
    releaseSharedHolderIn(flywheel, hold)
    hold = undefined
    flywheel.close()
  }
}

/** Claims exclusive headless project execution before opening project state.
 * Refuses every live or unreadable served or headless holder, including this
 * process's other hosts. The caller releases only after runtime settlement. */
export function claimHeadlessProjectExecution(projectRoot: string): Promise<() => void> {
  return claimProjectExecution(projectRoot, async (flywheel, register) => {
    await withLockIn(flywheel, executionGate, () => {
      refuseExecutionHolder(flywheel, projectRoot, headlessGate, "headless execution")
      for (const lane of ["dev", "installed"] as const) {
        refuseExecutionHolder(flywheel, projectRoot, servingGate(lane), `the ${lane} lane`)
      }
      register(headlessGate)
    })
  })
}

/** A release with proof that no other process held this lane at acquisition. */
export type ProjectServingClaim = (() => void) & {
  readonly exclusive: boolean
  /** Releases only the sole holder while the persisted handoff remains eligible,
   * atomically with same-lane registration and the synchronous eligibility read.
   * Call after all writes except optional closed-generation recovery settle.
   * False keeps the claim for recovery and ordinary disposal. */
  readonly releaseForHandoff: (eligible: () => boolean) => Promise<boolean>
}

/** Claims a project for this lane's account service and returns the release and acquisition proof.
 *
 *  A project is open in at most one lane at a time. A clean acquisition also
 *  proves no other process of that lane still serves it. Each lane's service
 *  marks the projects it serves with a shared holder beside the project's
 *  state generation gate, which names the
 *  service by its process identity.
 *  - A live process of the other lane refuses the claim, naming that lane and
 *    pid so the user can close it there or open it from that lane. So does a
 *    holder of the other lane whose record cannot be read, because it is not
 *    proven gone.
 *  - A live process of this lane that is not this one is a predecessor still
 *    closing the project after it withdrew its socket (ARCH-RUNTIME-028): the claim
 *    waits for it to go, for at most the account's drain hard-exit bound,
 *    after which the claim proceeds without exclusive acquisition proof.
 *  A holder proven gone is swept, never honoured, so a crashed service, or a
 *  pid that another process now holds, blocks nothing. Headless execution
 *  always refuses the claim. Checks and registration share a short mutex with
 *  headless claimers; predecessor waits never hold that mutex. */
export async function claimProjectServing(projectRoot: string, lane: ServeLane, waitMs = ACCOUNT_DRAIN_HARD_EXIT_MS): Promise<ProjectServingClaim> {
  let exclusive = false
  const release = await claimProjectExecution(projectRoot, async (flywheel, register) => {
    const other = otherLane(lane)
    const refuseConflicts = (): void => {
      refuseExecutionHolder(flywheel, projectRoot, servingGate(other), `the ${other} lane`)
      refuseExecutionHolder(flywheel, projectRoot, headlessGate, "headless execution")
    }
    const deadline = Date.now() + waitMs
    const claimIfReady = (): boolean => {
      refuseConflicts()
      const { pids, unreadable } = sharedHoldersIn(flywheel, servingGate(lane))
      const predecessors = pids.filter((pid) => pid !== process.pid)
      const held = predecessors.length > 0 || unreadable > 0
      if (held && Date.now() < deadline) return false
      if (held) log.warn("the previous service still holds the project past the shutdown bound; opening it anyway", { projectRoot, pids: predecessors, unreadable })
      exclusive = pids.length === 0 && unreadable === 0
      register(servingGate(lane))
      return true
    }
    let ready = await withLockIn(flywheel, executionGate, claimIfReady)
    if (!ready) log.info("project open waits for the previous service to close it", { projectRoot })
    while (!ready) {
      await new Promise<void>((resolve) => { setTimeout(resolve, SAME_LANE_POLL_MS) })
      ready = await withLockIn(flywheel, executionGate, claimIfReady)
    }
  })
  return Object.assign(release, {
    exclusive,
    async releaseForHandoff(eligible: () => boolean): Promise<boolean> {
      const flywheel = openFlywheelDirectory(projectRoot)
      try {
        return await withLockIn(flywheel, executionGate, () => {
          const { pids, unreadable } = sharedHoldersIn(flywheel, servingGate(lane))
          if (unreadable > 0 || pids.length !== 1 || pids[0] !== process.pid || !eligible()) return false
          release()
          return true
        })
      } finally {
        flywheel.close()
      }
    },
  })
}
