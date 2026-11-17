import { errorMessage } from "../../infra/error-message.js"
import type { HeadlessChatOutcome } from "../../protocol/headless-chat.js"
import { assembleProjectRuntime, type RuntimeComposition, type RuntimeCompositionOptions } from "../app-service/project-execution-runtime.js"
import { createRuntimeChatKernel } from "../app-service/runtime-chat-kernel.js"
import { claimHeadlessProjectExecution } from "../app-service/project-serving-lane.js"
import type { AgentToolInput } from "../agent-runtime/types.js"
import { createChatInvocationCompletion } from "../chat/runner-completion.js"
import { jsonlFraming, runHeadlessChatChannel, type ChatTransport } from "./headless-chat-channel.js"

/** Hosts the full production Chat runtime locally, without a public listener.
 * Owns runtime disposal, not the launcher's or persistent process manager's
 * lifetime. The CLI releases those after this function has flushed output.
 * Returns 0 for a drained conversation, 1 for failure, and 2 for a conversation
 * that needs more input. The JSONL contract is in protocol/headless-chat.ts;
 * the ACP framing is in acp-chat.ts.
 */
export async function runHeadlessChat(options: RuntimeCompositionOptions & ChatTransport): Promise<number> {
  let runtime: RuntimeComposition | undefined
  let releaseExecution: (() => void) | undefined
  let sessionId: string | null = null
  let outcome: HeadlessChatOutcome = "failed"
  let handoff: AgentToolInput | undefined
  let root: string | undefined
  const turnEnded = options.framing?.turnEnded
  const oneShot = options.oneShot === true || options.unattended === true
  const completion = oneShot || turnEnded ? {
    invocation: createChatInvocationCompletion(oneShot ? (content) => { handoff = content } : undefined, turnEnded, options.unattended),
    bind: (id: string) => { root = id },
    result: () => handoff,
  } : undefined
  try {
    releaseExecution = await claimHeadlessProjectExecution(options.projectRoot)
    runtime = await assembleProjectRuntime({
      ...options,
      ...(completion ? { rootChatCompletion: (id: string) => id === root ? completion.invocation : undefined } : {}),
    }, (scope, lane) => createRuntimeChatKernel(options, scope, lane))
    const result = await runHeadlessChatChannel(runtime, { ...options, oneShot, completion })
    sessionId = result.sessionId
    outcome = result.outcome
  } catch (error) {
    options.progressWriter?.(`Headless chat failed: ${errorMessage(error)}`)
  } finally {
    if (runtime) {
      try {
        const disposed = await runtime.dispose({ clientsHold: true })
        if (disposed.kind === "blocked") {
          outcome = "failed"
          options.progressWriter?.(`Headless chat shutdown blocked in ${disposed.phase}`)
        } else {
          releaseExecution?.()
        }
      } catch (error) {
        outcome = "failed"
        options.progressWriter?.(`Headless chat shutdown failed: ${errorMessage(error)}`)
      }
    }
    // Failed assembly reports rollback errors only to its logger. It proves
    // no settlement here, so its claim stays until this CLI process exits.
  }
  const final = (options.framing ?? jsonlFraming()).final({ sessionId, outcome, ...(handoff ? { handoff } : {}) })
  if (final !== undefined) await options.write(final)
  return outcome === "complete" ? 0 : outcome === "failed" ? 1 : 2
}
