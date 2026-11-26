import { errorMessage } from "../../../infra/diagnostics/error-message.js"
import {
  WorkflowHostLifecycleError,
  type WorkflowVmHostDisposeResult,
  type WorkflowVmHostLifecycle,
} from "./host-types.js"
import { toPublicFailure } from "./host-failures.js"

export async function disposeWorkflowHostLifecycle(
  lifecycle: WorkflowVmHostLifecycle,
  settleWorker: () => Promise<void>,
  settleHost: () => Promise<void>,
): Promise<WorkflowVmHostDisposeResult> {
  const failures: string[] = []
  await finalize("worker", settleWorker, failures)
  await finalize("host commits", settleHost, failures)
  await finalize("background settlement", lifecycle.settleBackground, failures)
  await finalize("event bus drain", lifecycle.drainEventBus, failures)
  await finalize("writer drain", lifecycle.drainWriter, failures)
  await finalize("projection dispose", lifecycle.disposeProjections, failures)
  await finalize("remaining handles", lifecycle.disposeRemaining, failures)
  if (failures.length === 0) return { kind: "disposed" }
  const failure = toPublicFailure(new WorkflowHostLifecycleError({
    operation: "dispose",
    message: "Workflow host disposal failed",
    failures,
  }))
  if (failure.kind !== "lifecycle") throw new Error("Lifecycle failure mapping changed")
  return { kind: "failed", failure }
}

async function finalize(
  name: string,
  finalizer: () => void | Promise<void>,
  failures: string[],
): Promise<void> {
  try {
    await finalizer()
  } catch (error) {
    failures.push(`${name}: ${errorMessage(error)}`)
  }
}
