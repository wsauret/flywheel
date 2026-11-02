import type { ContainedDirectory } from "../infra/descriptor-directory.js"
import { acquireLockSyncIn, liveSharedHoldersIn, registerSharedHolderIn, releaseLockIn, releaseSharedHolderIn, type LockHold, type SharedHold } from "../infra/ownership-file-lock.js"

/** One project's state generation is the workspace members that belong to one
 *  epoch: the event store, its sidecars, and the session tree. Every process
 *  that reads or writes those members owns the generation for as long as it
 *  holds them open, and a generation nobody owns is the only one that may be
 *  replaced.
 *
 *  Ownership is shared for that normal lifetime and exclusive for the window
 *  that inspects the epoch and, when it is old, moves the members aside. The
 *  exclusive window also serializes inspection, so two starts cannot both
 *  decide to replace the same generation.
 *
 *  The gate and its shared-holder entries live in the one held `.flywheel`
 *  directory the whole lease is bound to, so the lock a start acquires and the
 *  members it then inspects are entries of one directory: a `.flywheel`
 *  replaced after the gate was taken cannot split the lock from the generation
 *  it guards. */
const GENERATION_GATE = "project-generation.lock"

export interface ProjectStateLease {
  release(): void
}

export interface ProjectStateGeneration extends ProjectStateLease {
  /** Whether another process still owns this generation. While one does, no
   *  member may move: its open database handles and session directories name
   *  the files a replacement would rename out from under it. */
  readonly otherOwnersLive: boolean
  /** Trade the exclusive window for shared ownership of the same generation,
   *  which the caller holds for as long as it keeps the store open. */
  downgrade(): ProjectStateLease
}

/** Open the exclusive window over the state generation of the held `.flywheel`
 *  directory. Waits for any other window, and for any exclusive owner, to
 *  finish.
 *
 *  Takes ownership of `flywheel`: the directory stays open for as long as any
 *  lease derived from this window is held, and is closed when the last one is
 *  released, or immediately when the gate cannot be acquired. */
export function acquireProjectStateGeneration(flywheel: ContainedDirectory): ProjectStateGeneration {
  let gate: LockHold
  try {
    gate = acquireLockSyncIn(flywheel, GENERATION_GATE)
  } catch (err) {
    flywheel.close()
    throw err
  }
  let handedOver = false
  return {
    otherOwnersLive: liveSharedHoldersIn(flywheel, GENERATION_GATE) > 0,
    downgrade(): ProjectStateLease {
      // Registered before the gate is released, so a start that acquires the
      // gate next already observes this process as an owner.
      const hold = registerSharedHolderIn(flywheel, GENERATION_GATE)
      handedOver = true
      releaseLockIn(flywheel, gate)
      return sharedLease(flywheel, hold)
    },
    release(): void {
      if (handedOver) return
      releaseLockIn(flywheel, gate)
      flywheel.close()
    },
  }
}

function sharedLease(flywheel: ContainedDirectory, hold: SharedHold): ProjectStateLease {
  let released = false
  return {
    release(): void {
      if (released) return
      released = true
      releaseSharedHolderIn(flywheel, hold)
      flywheel.close()
    },
  }
}
