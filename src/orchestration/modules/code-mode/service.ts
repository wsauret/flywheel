import { Effect } from "effect"
import { mergeAbortSignals } from "../../../infra/abort.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { createSessionFairAdmission } from "../../../infra/session-fair-admission.js"
import type { ModuleServiceInstance } from "../../app-service/module-service-host.js"
import type { ToolContext, ToolResult } from "../../agent-runtime/tools/types.js"
import { runInvocation, type CodeModeInvocation } from "./invocation-runner.js"
import { CODE_MODE_LIMITS, type CodeModeLimits } from "./limits.js"
import { CODE_MODE_WORKER_POOL, createInvocationWorkerPool, spawnInvocationWorker, type InvocationWorker, type WorkerPoolSettings } from "./worker-pool.js"

/** Four Workers bound the measured memory cost of parallel invocations while
 *  keeping the executor responsive. The allowance is this service's alone:
 *  shell work never consumes it. */
const CODE_MODE_CAPACITY = 4

/** The executor's one owner of Code Mode invocations: a session-fair
 *  admission of four running invocations over a pool of at most four
 *  reusable Workers, which starts with the first invocation. Excess calls
 *  wait, and an abort while waiting removes the call before any batch or
 *  Worker lease exists. */
export interface CodeModeService extends ModuleServiceInstance {
  run(invocation: CodeModeInvocation, context: ToolContext): Promise<ToolResult>
}

export const codeModeService = moduleServiceHandle<CodeModeService>("code-mode")

export interface CodeModeServiceOptions {
  /** Opens a Worker when the pool has no idle one; a real Bun Worker by default. */
  readonly openWorker?: () => InvocationWorker
  readonly limits?: Partial<CodeModeLimits>
  readonly pool?: Partial<WorkerPoolSettings>
}

export function createCodeModeService(options: CodeModeServiceOptions = {}): CodeModeService {
  const admission = createSessionFairAdmission(CODE_MODE_CAPACITY)
  const closed = new AbortController()
  const live = new Set<Promise<ToolResult>>()
  const workers = createInvocationWorkerPool(options.openWorker ?? spawnInvocationWorker, { ...CODE_MODE_WORKER_POOL, ...options.pool })
  const owner = { limits: { ...CODE_MODE_LIMITS, ...options.limits }, workers }

  const admitted = async (invocation: CodeModeInvocation, context: ToolContext): Promise<ToolResult> => {
    const release = await admission.acquire(context.sessionId ?? context.artifactScopeId, mergeAbortSignals(context.signal, closed.signal))
    // Plain try/finally: the permit is released only after every scope
    // finalizer settled, including a failed terminal publication, and no
    // interruption can land between admission and this release. The
    // invocation reads the abort itself and answers with a result that names
    // the nested calls it leaves running (ARCH-TOOLS-050).
    try {
      return await Effect.runPromise(runInvocation(invocation, context, owner))
    } finally {
      release()
    }
  }
  const closeAdmission = (): void => {
    if (!closed.signal.aborted) closed.abort(new Error("Code Mode is shutting down"))
  }

  return {
    run(invocation, context) {
      const settled = admitted(invocation, context)
      live.add(settled)
      const forget = (): void => { live.delete(settled) }
      settled.then(forget, forget)
      return settled
    },
    closeAdmission,
    async dispose() {
      // Shutdown already aborted every running tool's signal; disposal waits
      // for each invocation's own cleanup instead of cutting it short, and
      // then terminates the Workers that the pool still holds.
      closeAdmission()
      await Promise.allSettled(live)
      await workers.close()
    },
  }
}
