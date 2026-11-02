import { createRuntimeChatKernel } from "../../src/orchestration/app-service/runtime-chat-kernel.js"
import { assembleProjectRuntime, type RuntimeCompositionOptions } from "../../src/orchestration/app-service/project-execution-runtime.js"

/** Builds the in-process runtime used by integration tests: the production
 * composition over an in-process kernel instead of the state Worker. */
export async function createTestRuntimeComposition(options: RuntimeCompositionOptions) {
  return assembleProjectRuntime(
    options,
    (scope, backgroundLane) => createRuntimeChatKernel(options, scope, backgroundLane),
  )
}
