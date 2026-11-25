import { errorMessage } from "../../infra/diagnostics/error-message.js"
import type { ChatSettlementOutcome } from "../../protocol/session/chat-settlement-protocol-types.js"
import { assembleProjectRuntime, type RuntimeComposition, type RuntimeCompositionOptions } from "../app-service/executor/execution/project-execution-runtime.js"
import { createRuntimeChatKernel } from "../app-service/supervisor/runtime-chat-kernel.js"
import { claimHeadlessProjectExecution } from "../app-service/account/projects/project-serving-lane.js"
import type { AgentToolInput } from "../agent-runtime/types.js"
import { createChatInvocationCompletion } from "../chat/runner-completion.js"
import { acpFraming } from "./acp-chat.js"
import { inProcessHeadlessClient, runHeadlessChatChannel, type ChatTransport } from "./headless-chat-channel.js"

interface HeadlessChatOptions extends RuntimeCompositionOptions, Omit<ChatTransport, "framing" | "completion"> {
  /** No person reads the conversation (PI-AGENT-121), so the run is one-shot: its first answered prompt ends it. */
  readonly unattended?: boolean
}

/** Hosts the full production Chat runtime locally, without a public listener,
 * under an exclusive claim of the project, and speaks Agent Client Protocol
 * version 1 for it (acp-chat.ts). This is the host of a run that no person
 * reads and of a run whose tools or credentials differ from the account's;
 * an attended run is a client of the account service instead
 * (ARCH-RUNTIME-004).
 * Owns runtime disposal, not the launcher's or persistent process manager's
 * lifetime. The CLI releases those after this function has flushed output.
 * Returns 0 for a drained conversation, 1 for failure, and 2 for a conversation
 * that needs more input.
 */
export async function runHeadlessChat(options: HeadlessChatOptions): Promise<number> {
  let runtime: RuntimeComposition | undefined
  let releaseExecution: (() => void) | undefined
  let outcome: ChatSettlementOutcome = "failed"
  let handoff: AgentToolInput | undefined
  let root: string | undefined
  const invocation = options.unattended ? createChatInvocationCompletion((content) => { handoff = content }, true) : undefined
  const framing = acpFraming(options.executionCwd)
  try {
    releaseExecution = await claimHeadlessProjectExecution(options.projectRoot)
    runtime = await assembleProjectRuntime({
      ...options,
      ...(invocation ? { rootChatCompletion: (id: string) => id === root ? invocation : undefined } : {}),
    }, (scope, lane) => createRuntimeChatKernel(options, scope, lane))
    runtime.startChatDefault()
    outcome = await runHeadlessChatChannel(inProcessHeadlessClient(runtime.client), {
      ...options, framing,
      ...(invocation ? { completion: { bind: (id: string) => { root = id }, result: () => handoff } } : {}),
    })
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
    framing.close()
  }
  return outcome === "complete" ? 0 : outcome === "failed" ? 1 : 2
}
