import type { WorkflowController } from "../workflow-host/controller.js"

interface LazyWorkflowControllerDeps {
  readonly create: () => Promise<WorkflowController>
}

/** Defers workflow controller construction until the first workflow request.
 *  Reading a parent's retained launches is not one: the workflows module
 *  reads them through its own codec, so only a commit or a Stop loads the
 *  controller. */
export function createLazyWorkflowController(deps: LazyWorkflowControllerDeps): WorkflowController {
  let loaded: WorkflowController | null = null
  let loading: Promise<WorkflowController> | null = null
  const load = async (): Promise<WorkflowController> => {
    if (loaded) return loaded
    loading ??= deps.create().then((controller) => {
      loaded = controller
      return controller
    })
    return loading
  }

  return {
    restoreLaunchTracking: async (...args: Parameters<WorkflowController["restoreLaunchTracking"]>) => {
      const controller = loaded ?? await loading
      await controller?.restoreLaunchTracking(...args)
    },
    startWorkflow: (...args: Parameters<WorkflowController["startWorkflow"]>) => load().then((controller) => controller.startWorkflow(...args)),
    commitLaunch: (...args: Parameters<WorkflowController["commitLaunch"]>) => load().then((controller) => controller.commitLaunch(...args)),
    stopLaunch: (...args: Parameters<WorkflowController["stopLaunch"]>) => load().then((controller) => controller.stopLaunch(...args)),
    launchCut: (...args: Parameters<WorkflowController["launchCut"]>) => load().then((controller) => controller.launchCut(...args)),
    resumeLaunch: (...args: Parameters<WorkflowController["resumeLaunch"]>) => load().then((controller) => controller.resumeLaunch(...args)),
    resumeWorkflow: (...args: Parameters<WorkflowController["resumeWorkflow"]>) => load().then((controller) => controller.resumeWorkflow(...args)),
    sendWorkflow: (...args: Parameters<WorkflowController["sendWorkflow"]>) => load().then((controller) => controller.sendWorkflow(...args)),
    restartWorkflow: (sessionId: string) => load().then((controller) => controller.restartWorkflow(sessionId)),
  }
}
