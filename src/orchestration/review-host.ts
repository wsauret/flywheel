import type { AttemptRow } from "../workflows/view/types.js"
import type { ConversationMessage } from "./agent-runtime/llm/types.js"
import type { WorkerCallbackDeps } from "./workflow-host/agent-callback.js"
import type { FirstPartyModuleComposition } from "./modules.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"

export interface CapturedModuleConfig { readonly [section: string]: unknown }
interface CompletedWorkerContext { readonly attempt: AttemptRow; readonly conversationId: string; readonly sessionId: string; readonly task: string }
export interface WorkflowReviewHost {
  replay(messages: readonly ConversationMessage[]): Promise<void>
  noteAssistantMessage(content: Extract<ConversationMessage, { kind: "assistant" }>["content"]): void
  dispose(): Promise<void>
  completed(context: CompletedWorkerContext): void
  onTurnCompleted(conversationId: string, config?: CapturedModuleConfig): void
}
export interface WorkflowReviewHostInput { readonly deps: WorkerCallbackDeps; readonly memorySnapshot: string | null }
export interface ModuleReviewContribution {
  readonly workflow?: (input: WorkflowReviewHostInput) => WorkflowReviewHost | undefined
}

const log = Log.create({ service: "module-reviews" })
function report(error: unknown): void { log.warn("module review failed", { error: errorMessage(error) }) }
function invoke(run: () => void): void { try { run() } catch (error) { report(error) } }
async function join(run: () => Promise<void>): Promise<void> { try { await run() } catch (error) { report(error) } }

/** A workflow holds one admitted catalog for its lifetime. */
export function createWorkflowModuleReviews(selection: FirstPartyModuleComposition, input: WorkflowReviewHostInput): WorkflowReviewHost {
  const hosts = selection.contributions.flatMap((entry) => {
    if (entry.domain !== "reviews") return []
    try { const host = entry.value.workflow?.(input); return host ? [host] : [] } catch (error) { report(error); return [] }
  })
  return {
    async replay(messages) { for (const host of hosts) await join(() => host.replay(messages)) },
    noteAssistantMessage: (content) => { for (const host of hosts) invoke(() => host.noteAssistantMessage(content)) },
    completed: (context) => { for (const host of hosts) invoke(() => host.completed(context)) },
    onTurnCompleted: (conversationId, config) => { for (const host of hosts) invoke(() => host.onTurnCompleted(conversationId, config)) },
    dispose: async () => { await Promise.all(hosts.map((host) => join(() => host.dispose()))) },
  }
}
