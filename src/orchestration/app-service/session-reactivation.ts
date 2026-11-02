import { isVisibleMessageBlock, type AnyBlock } from "../../infra/output-blocks.js"
import { readTranscript, readReconciledTranscript } from "../session/conversation/conversation-tree-handle.js"
import { recoverSessionHistory } from "../modules.js"
import { reconcileAgentInput } from "../session/agent-input-reconciliation.js"
import { createSessionToolExecutionStore, repairInterruptedToolExecutions } from "../session/tool-execution-store.js"
import { createToolExecutionProjection } from "../session/tool-execution-projection.js"
import { createSessionFactWriter } from "../session/session-fact-writer.js"
import { recordedExecutionCwd } from "../session/session-execution-directory.js"
import { turnInFlight, type ChatSessionView } from "../session-store/view.js"
import { Log } from "../../infra/log.js"
import { durationMs } from "../../infra/operation-log.js"
import { reactivationShellOptions } from "./reactivation-shell-options.js"
import type { SessionRuntimeActorContext } from "./session-runtime-actor-types.js"

const log = Log.create({ service: "session-reactivation" })

// Display seed at reactivation: enough to fill the viewport and the first
// scroll pages; older history is served by derived history queries.
const REACTIVATION_SEED_BLOCKS = 64

type ReactivationDeps = Pick<SessionRuntimeActorContext, "sessionStore" | "manager" | "eventStore" | "projectionReader" | "eventWriter" | "sessionViewLoader" | "directories" | "transcriptCache" | "reconcileChildSessionCompletions">
type DisplaySeedDeps = Pick<SessionRuntimeActorContext, "eventStore"> & {
  readonly transcriptCache: Pick<SessionRuntimeActorContext["transcriptCache"], "read">
}
type OpenDisplayDeps = DisplaySeedDeps & Pick<SessionRuntimeActorContext, "sessionStore" | "manager" | "directories">
type DisplaySeed = Awaited<ReturnType<typeof readBoundedChatDisplaySeed>>

export type DurableChatActivation =
  | { readonly status: "already-active" | "unavailable" }
  | { readonly status: "opened"; readonly completedLeaf: boolean }

/** Load a durable chat's view and open its shell with a bounded display tail.
 *  Callers serialize this (the actor mailbox), so the has-check is authoritative
 *  against concurrent activations. */
export async function activateDurableChat(deps: ReactivationDeps, sessionId: string): Promise<DurableChatActivation> {
  // A resident chat is already reconciled: every child-finish path sweeps a
  // resident parent itself, so a reattach or tab switch pays no sweep.
  if (deps.sessionStore.has(sessionId)) return { status: "already-active" }
  const start = performance.now()
  // The completion sweep and the repair below read the same calls through
  // this one projection, so a reopen folds the chat's tool history once even
  // when other sessions churn the registry's tool-execution family between them.
  const parentTools = createToolExecutionProjection(deps.projectionReader, sessionId)
  const childWorkflows = await deps.reconcileChildSessionCompletions?.(sessionId, { parentTools })
    ?? { reconciledCount: 0, workflowAggregateReads: 0 }
  const reconciliationDurationMs = durationMs(start)
  const view = await deps.sessionViewLoader?.load(sessionId)
  if (!view || view.kind !== "chat") return { status: "unavailable" }
  const executionCwd = recordedExecutionCwd(await deps.manager.read(sessionId), deps.directories.projectRoot)
  const treeOptions = {
    conversationId: view.conversationId,
    sessionId: view.id,
    store: deps.eventStore,
    writer: deps.eventWriter,
    projectRoot: deps.directories.projectRoot,
  }
  const agentInput = await reconcileAgentInput(treeOptions)
  const protectedToolUseIds = new Set([
    ...agentInput.protectedToolUseIds,
    ...(childWorkflows.linkedNonterminalWorkflowToolUseIds ?? []),
  ])
  await recoverSessionHistory({
    sessionId,
    reader: deps.eventStore,
    projectionReader: deps.projectionReader,
    writer: deps.eventWriter,
    projectRoot: deps.directories.projectRoot,
    fallbackConversationId: view.conversationId,
    protectedToolUseIds,
  })
  const tools = createSessionToolExecutionStore({ sessionId, projectionReader: deps.projectionReader, projection: parentTools })
  const facts = createSessionFactWriter({ sessionId, writer: deps.eventWriter })
  try {
    await repairInterruptedToolExecutions(tools, facts, protectedToolUseIds)
  } finally {
    tools.dispose()
    facts.dispose()
  }
  const transcriptStart = performance.now()
  if (!agentInput.protectedPending && !agentInput.completedLeaf) {
    await readReconciledTranscript({ ...treeOptions, protectedToolUseIds })
  } else {
    await readTranscript(treeOptions)
  }
  const seed = await readBoundedChatDisplaySeed(deps, view, executionCwd)
  deps.sessionStore.openSessionRuntime(reactivationShellOptions(
    view,
    [],
    seed.blockCount,
    seed.visibleMessageCountPrefix + seed.visibleMessageCountSuffix,
  ))
  replaceDisplaySeed(deps, sessionId, seed)
  log.info("session activated", {
    sessionId,
    conversationId: view.conversationId,
    blocks: seed.tail.length,
    durationMs: durationMs(start),
    reconciliationDurationMs,
    workflowAggregateReads: childWorkflows.workflowAggregateReads,
    transcriptBuildDurationMs: durationMs(transcriptStart),
  })
  return { status: "opened", completedLeaf: agentInput.completedLeaf }
}

/** Puts `seed` in place of the open chat's display in the store. */
export function replaceDisplaySeed(deps: Pick<SessionRuntimeActorContext, "sessionStore">, sessionId: string, seed: DisplaySeed): void {
  deps.sessionStore.replaceChatDisplaySeed(sessionId, seed.tail, seed.blockCount, seed.visibleMessageCountPrefix, seed.visibleMessageCountSuffix)
}

/** The bounded durable display tail of an open chat, read in its execution directory. */
export async function readOpenChatDisplaySeed(deps: OpenDisplayDeps, sessionId: string, conversationId: string): Promise<DisplaySeed> {
  const executionCwd = recordedExecutionCwd(await deps.manager.read(sessionId), deps.directories.projectRoot)
  return readBoundedChatDisplaySeed(deps, { id: sessionId, conversationId }, executionCwd)
}

/** Puts the bounded durable display tail in place of the open chat's display,
 *  in the store and in its runner's block list. The display falls behind the
 *  log when work commits without its runner, such as a child completion that
 *  a reconciliation settles.
 *
 *  With `keep`, a runner whose turn holds a display ahead of the log keeps
 *  it: text that streamed and tools that run reach the log only at the
 *  turn's own commits, and the replacement would drop them for good.
 *  - `turnInFlight`: the turn runs, or it is parked on a question or on
 *    background work. A caller that can come at any moment uses it, because
 *    a turn reports its park before its last commit lands.
 *  - `runningTurn`: the turn runs, or it waits on a question. A caller that
 *    follows a commit of the runner's own writer uses it: that writer commits
 *    after the turn's output, so a turn parked on background work shows
 *    nothing the log lacks, and its display takes the new record.
 *  The check runs in the synchronous frame that replaces the display, after
 *  the read, so a turn that starts during the read also keeps its display. */
export async function refreshOpenChatDisplay(deps: OpenDisplayDeps, sessionId: string, options?: { readonly keep: "turnInFlight" | "runningTurn" }): Promise<void> {
  const entry = deps.sessionStore.get(sessionId)
  if (entry?.kind !== "chat") return
  const refreshed = await readOpenChatDisplaySeed(deps, sessionId, entry.conversationId)
  const current = deps.sessionStore.get(sessionId)
  if (current?.kind !== "chat") return
  if (options) {
    const runs = current.runnerState === "streaming" || current.runnerState === "awaiting_user"
    const kept = current.runner !== null && (options.keep === "turnInFlight" ? turnInFlight(current) : runs)
    log.debug("open display refresh", { sessionId, keep: options.keep, runner: current.runner !== null, runnerState: current.runnerState, waitingOnBackgroundWork: current.waitingOnBackgroundWork, refreshed: !kept })
    if (kept) return
  }
  current.runner?.seedDisplayBlocks(refreshed.tail)
  replaceDisplaySeed(deps, sessionId, refreshed)
}

/** Read the bounded display tail from durable projections without repairing or
 * appending any durable state. */
async function readBoundedChatDisplaySeed(
  deps: DisplaySeedDeps,
  view: Pick<ChatSessionView, "id" | "conversationId">,
  executionCwd: string,
): Promise<{ tail: AnyBlock[]; blockCount: number; visibleMessageCountPrefix: number; visibleMessageCountSuffix: number }> {
  const history = await deps.transcriptCache.read(view.id, view.conversationId, executionCwd)
  const blockCount = history?.blockCount ?? 0
  const visibleMessageCount = history?.visibleMessageCount ?? 0
  const start = Math.max(0, blockCount - REACTIVATION_SEED_BLOCKS)
  const tail = history ? await Promise.all(Array.from({ length: blockCount - start }, (_, index) => history.readBlock(start + index))) : []
  const tailVisibleMessageCount = tail.reduce((count, block) => count + (isVisibleMessageBlock(block) ? 1 : 0), 0)
  return {
    tail,
    blockCount,
    visibleMessageCountPrefix: visibleMessageCount - tailVisibleMessageCount,
    visibleMessageCountSuffix: tailVisibleMessageCount,
  }
}
