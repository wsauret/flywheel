import type { StoredFact } from "../infra/store/event-store-types.js"
import type { createEmit } from "../infra/event-bus.js"
import { composeModuleRuntimes, type ModuleRuntimes, type ModuleRuntimeHandle } from "../infra/module-runtime.js"
import type { BackgroundExecutionOwner } from "./agent-runtime/background-execution/background-execution-owner.js"
import type { ForegroundBashHoldController } from "./agent-runtime/background-work/foreground-bash-hold.js"
import type { ConversationMessage } from "./agent-runtime/llm/types.js"
import type { ChatSessionDeps, ChatSessionState } from "./chat/types.js"
import type { FirstPartyModuleSnapshot } from "./modules.js"
import type { ChatTurnMailbox } from "./chat/turn-mailbox.js"
import { Log } from "../infra/diagnostics/log.js"
import { errorMessage } from "../infra/error-message.js"

export interface CapturedModuleConfig { readonly [section: string]: unknown }

/** Resources of an attached chat, independent of its logical model turns. */
export interface ChatModuleHostInput {
  readonly deps: ChatSessionDeps
  readonly state: ChatSessionState
  readonly emit: ReturnType<typeof createEmit>
  readonly background: BackgroundExecutionOwner
  readonly foregroundBashHold: ForegroundBashHoldController
  readonly mailbox: Pick<ChatTurnMailbox, "parked" | "enqueueSilentSystem">
  readonly applyNestedStoredFact: (event: StoredFact) => void | Promise<void>
  readonly hasActiveTurn: () => boolean
}

/** An admitted session resource. Disposal must join all work it owns.
 * Hooks observe ordinary chat turns, when the resource needs them. */
export interface ChatModuleHost {
  beforeTurn?(): Promise<void>
  replay?(messages: readonly ConversationMessage[]): Promise<void>
  noteAssistantMessage?(content: Extract<ConversationMessage, { kind: "assistant" }>["content"]): void
  noteUserTurn?(): void
  onTurnCompleted?(config?: CapturedModuleConfig): void
  review?(): boolean
  dispose(): Promise<void>
}

export interface ChatModuleHostContribution {
  readonly handle: ModuleRuntimeHandle<ChatModuleHost>
  readonly create: (input: ChatModuleHostInput) => ChatModuleHost | undefined
}

export interface ChatModuleHosts extends Required<ChatModuleHost>, ModuleRuntimes {}

const log = Log.create({ service: "chat-module-hosts" })
function report(error: unknown): void { log.warn("chat module host failed", { error: errorMessage(error) }) }
function invoke(run: () => void): void { try { run() } catch (error) { report(error) } }
async function join(run: () => Promise<void>): Promise<void> { try { await run() } catch (error) { report(error) } }

/** Constructs the hosts that `selection` contributes at attachment, before any
 * model work. Selection changes retire hosts on the next lookup or hook;
 * disposal joins retired work and active hosts once, and the caller ties it to
 * the chat's background settlement. Factory and hook failures are contained. */
export function createChatModuleHosts(selection: FirstPartyModuleSnapshot, input: ChatModuleHostInput): ChatModuleHosts {
  const active = new Map<ChatModuleHostContribution, ChatModuleHost>()
  const retired = new Set<Promise<void>>()
  const attempted = new Set<ChatModuleHostContribution>()
  let disposal: Promise<void> | undefined
  async function releaseRetired(task: Promise<void>): Promise<void> {
    await task
    retired.delete(task)
  }
  function reconcileHosts(): readonly ChatModuleHost[] {
    if (disposal) return []
    const selected = new Set(selection().contributions.flatMap((entry) => entry.domain === "chatHosts" ? [entry.value] : []))
    for (const contribution of attempted) if (!selected.has(contribution)) attempted.delete(contribution)
    for (const [contribution, host] of active) {
      if (selected.has(contribution)) continue
      active.delete(contribution)
      const done = join(() => host.dispose())
      retired.add(done)
      void releaseRetired(done)
    }
    for (const contribution of selected) {
      if (attempted.has(contribution)) continue
      attempted.add(contribution)
      try { const host = contribution.create(input); if (host) active.set(contribution, host) } catch (error) { report(error) }
    }
    return [...active.values()]
  }
  reconcileHosts()
  const hosts: ChatModuleHosts = {
    get<T>(handle: ModuleRuntimeHandle<T>): T | undefined {
      reconcileHosts()
      return composeModuleRuntimes([...active].map(([contribution, host]) => [contribution.handle.moduleId, host] as const)).get(handle)
    },
    async beforeTurn() { await Promise.all(reconcileHosts().map((host) => join(async () => { await host.beforeTurn?.() }))) },
    async replay(messages) { for (const host of reconcileHosts()) await join(async () => { await host.replay?.(messages) }) },
    noteAssistantMessage: (content) => { for (const host of reconcileHosts()) invoke(() => host.noteAssistantMessage?.(content)) },
    noteUserTurn: () => { for (const host of reconcileHosts()) invoke(() => host.noteUserTurn?.()) },
    onTurnCompleted: (config) => { for (const host of reconcileHosts()) invoke(() => host.onTurnCompleted?.(config)) },
    review() { return reconcileHosts().map((host) => { try { return host.review?.() ?? false } catch (error) { report(error); return false } }).some(Boolean) },
    dispose() {
      if (disposal) return disposal
      const endingHosts = [...active.values()]
      active.clear()
      disposal = Promise.all([...endingHosts.map((host) => join(() => host.dispose())), ...retired]).then(() => {})
      return disposal
    },
  }
  return hosts
}
