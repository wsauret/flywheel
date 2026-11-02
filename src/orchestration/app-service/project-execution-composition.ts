import { assembleRuntimeChatKernel, type RuntimeChatKernel } from "./runtime-chat-kernel.js"
import { createProjectExecutionState } from "./project-execution-state.js"
import type { ProjectStateClient } from "./project-state-client.js"
import { assembleProjectRuntime, type RuntimeComposition, type RuntimeCompositionOptions } from "./project-execution-runtime.js"
import type { RuntimeOwnership } from "./runtime-ownership.js"
import { runningDisplayBuildId } from "./runtime-executable.js"
import { resolveProjectionFoldCacheDbFile } from "../../infra/paths.js"
import { attachProjectionFoldCache, openProjectionFoldCache } from "../../infra/projection-fold-cache.js"

/** Composes execution over state-worker authority without acquiring its generation.
 * The caller keeps state alive until disposal completes. No startup maintenance
 * or public protocol listener is started here: the account owns both. */
export async function createProjectExecutionRuntime(
  options: RuntimeCompositionOptions & { readonly state: ProjectStateClient },
): Promise<RuntimeComposition> {
  return await assembleProjectRuntime(options, (scope, backgroundLane) =>
    createProjectExecutionKernel(options.projectRoot, options.state, scope, backgroundLane))
}

/** Owns only the executor's reader, write queue, runner pool, and projections. */
export async function createProjectExecutionKernel(
  projectRoot: string,
  state: ProjectStateClient,
  scope: RuntimeOwnership,
  backgroundLane: import("./runtime-background-lane.js").RuntimeBackgroundLane,
): Promise<RuntimeChatKernel> {
  const execution = await createProjectExecutionState(state)
  const runtime = scope.own("event-store-runtime", execution.eventStoreRuntime, (owned) => owned.dispose())
  scope.own("event-store-writer-lane", execution.writerLane, async (lane) => {
    const result = await lane.dispose()
    if (result.kind === "failed") throw new Error(`execution writer lane drain failed: ${result.error.message}`)
  })
  // A fold is reused only by the code that folded it. A process whose code
  // cannot be named, such as a live checkout, keeps no fold cache.
  const buildId = runningDisplayBuildId()
  if (buildId !== null) {
    const cache = scope.own("projection-fold-cache", openProjectionFoldCache(resolveProjectionFoldCacheDbFile(projectRoot), `${buildId}:${Bun.revision}`), (owned) => owned.close())
    // Closed first, so no fold is saved while the runtime shuts down.
    scope.shutdown("projection-fold-cache", "stop-runners")
    attachProjectionFoldCache([state, execution.eventStore], cache, "executor")
  }
  return await assembleRuntimeChatKernel(projectRoot, scope, backgroundLane, {
    runtime,
    eventReader: execution.eventReader,
    projectionReader: state,
    eventStore: execution.eventStore,
    eventWriter: execution.eventWriter,
    manager: execution.sessionManager,
    stateReleaseResources: ["event-store-runtime"],
  })
}
