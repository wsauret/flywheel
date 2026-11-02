import { trackWorkerClose } from "./worker-termination.js"

export const WORKER_GENERATION_BUDGETS = {
  "runtime-background": 3,
  "streaming-edit-validation": 1,
  "bash-private-copy": 1,
  "models-document": 1,
  "code-mode-invocation": 1,
  "runtime-maintenance": 1,
  "project-state": 3,
  "project-state-standby": 1,
  "process-watchdog": 1,
  "hard-exit-clock": 1,
  "update-installer": 1,
} as const

export type WorkerRole = keyof typeof WORKER_GENERATION_BUDGETS

export class WorkerGenerationBudgetExhausted extends Error {
  override readonly name = "WorkerGenerationBudgetExhausted"

  constructor(
    readonly role: WorkerRole,
    readonly maxGenerations: number,
  ) {
    super(`${role} exhausted its ${maxGenerations}-generation Worker budget`)
  }
}

export class WorkerRoleAlreadyLive extends Error {
  override readonly name = "WorkerRoleAlreadyLive"
  constructor(readonly role: WorkerRole) {
    super(`${role} already has a live Worker`)
  }
}

/** Creates tracked Workers until the role's owner-lifetime budget is spent.
 *
 * The counter advances before construction because a constructor that throws
 * can still have crossed the native allocation boundary. Exhaustion occurs
 * before another constructor call, so repeated recovery cannot consume an
 * unbounded number of native handles. */
export function createBoundedWorkerSpawner(role: WorkerRole): (specifier: string | URL, options?: WorkerOptions) => Worker {
  const maxGenerations = WORKER_GENERATION_BUDGETS[role]
  let generations = 0
  let live = false
  const exhausted = new WorkerGenerationBudgetExhausted(role, maxGenerations)
  return (specifier, options) => {
    if (role === "project-state" && live) throw new WorkerRoleAlreadyLive(role)
    if (generations >= maxGenerations) throw exhausted
    generations += 1
    const worker = trackWorkerClose(new globalThis.Worker(specifier, options))
    if (role === "project-state") {
      live = true
      worker.addEventListener("close", () => { live = false }, { once: true })
    }
    return worker
  }
}

function createEmbeddedWorkerSpawner(maxGenerations: number, role: string) {
  let generations = 0
  return (specifier: string, options?: WorkerOptions): Worker => {
    if (generations >= maxGenerations) throw new Error(`${role} exhausted its ${maxGenerations}-generation Worker budget`)
    generations += 1
    return new Worker(specifier, options)
  }
}

/** Returns a self-contained constructor authority for generated Worker source. */
export function embeddedWorkerSpawnerSource(role: WorkerRole): string {
  return `(${createEmbeddedWorkerSpawner.toString()})(${WORKER_GENERATION_BUDGETS[role]}, ${JSON.stringify(role)})`
}