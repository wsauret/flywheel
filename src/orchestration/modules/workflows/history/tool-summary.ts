import type { AsyncEventStateReadSurface } from "../../../../infra/event-store-types.js"
import { formatAgentFailureDisplay } from "../../../../infra/output/output-formatter.js"
import { Log } from "../../../../infra/log.js"
import { containSessionReads } from "../../../../infra/session-read-containment.js"
import { createReadQueue } from "../../../../infra/read-queue.js"
import type { StoppedBy } from "../../../../protocol/app-service-types.js"
import type { WorkflowView } from "../../../../workflows/view/types.js"
import { loadQueueSnapshotFromReader } from "../../../../workflows/view/view-store.js"
import { workflowCard, workflowCardCut, workflowCardSettled } from "../../../../protocol/client/workflow-card.js"
import { workflowOutline, type WorkflowRunActivity } from "../../../../protocol/client/workflow-outline.js"
import { frontendAttempts, readWorkflowRunRecords, type WorkflowRunRecords } from "../../../workflow-host/frontend-attempts.js"
import { workflowAggregateId } from "../../../../workflows/vm/session-facts.js"
import type { AgentFailureDisplay, PausedBy } from "../../../../infra/output-blocks.js"
import type { SessionToolSummaryReader, SessionToolSummarySnapshot, ToolHistorySummary } from "../../../module-seams.js"
import { readChatTurnEnd, readChildStop } from "../../../session/chat-session-run-evidence.js"
import { isVisibleTurnEnd, waitsForPerson, type ChatTurnEnd } from "../../../session/conversation/turn-end-record.js"
import { createWorkflowRunReader } from "../run-record.js"
import { createWorkflowDurationReader } from "../duration.js"
import { readHeldWorkflowMemberTotals, readWorkflowMemberTotals, type WorkflowMemberTotals } from "../../../workflow-host/member-totals.js"
import { memoizeSuccess } from "../../../../infra/success-memo.js"
import { workflowMembershipReader, type WorkflowMember } from "../../../session/workflow-membership.js"

/** Resolve workflow cards from current ownership, independent of invocation origin.
 * The parent tool result remains the settlement owner; until it settles, the
 * card states the workflow's own state (`workflowCardState`). A Stop's result
 * states the card as the parent's builder will settle it, at once.
 * Workflows, not the chat's child sessions, own these cards. */
export function createWorkflowToolSummaryReader(reader: AsyncEventStateReadSurface, sessionId: string): SessionToolSummaryReader {
  const runs = createWorkflowRunReader(reader)
  const durationOf = createWorkflowDurationReader(reader)
  const members = workflowMembershipReader(reader)
  const summaries = new Map<string, ToolHistorySummary>()
  // What each card was last read from: its members, workflow control, and
  // its current agent's conversation, where an interrupt records the agent's
  // turn end. A member's own work moves none of these: it moves only the
  // totals, which one held fold of every member advances. The membership
  // owner answers with the same members until a membership fact moves them.
  const sequences = new Map<string, { readonly key: string; readonly members: readonly WorkflowMember[] }>()
  const cards = new Map<string, CardEntry>()
  // The card behind each published summary that states no members' totals
  // yet. Its measurement totals and folds that card once per summary.
  const unmeasured = new WeakMap<ToolHistorySummary, CardEntry>()
  const measurements = new WeakMap<ToolHistorySummary, ToolHistorySummary>()
  // The member times that each published card folded, by the version of the
  // held member fold's durations, so a card folds again only when they move.
  const timed = new Map<string, number>()
  const agentConversations = new Map<string, string | undefined>()
  const launches = new Map<string, string>()
  // Who stopped each child, read at the parent sequence named beside it. A
  // Stop is a fact of this session, so it is read again only when this
  // session moves, never on another session's write.
  const stops = new Map<string, { readonly at: number; readonly by: StoppedBy | undefined }>()
  // A child whose attempt rows this build cannot read shows no outline, and
  // the parent's transcript still reads.
  const queueReads = containSessionReads(log, "read workflow view")
  // What each child's launch recorded once: the run's name and the persona
  // of each agent record.
  const records = new Map<string, WorkflowRunRecords>()
  async function recordsOf(childId: string): Promise<WorkflowRunRecords | undefined> {
    const known = records.get(childId)
    if (known !== undefined) return known
    const read = await queueReads.read(childId, () => readWorkflowRunRecords(reader, childId), undefined)
    if (read !== undefined) records.set(childId, read)
    return read
  }
  let position = 0
  // The store's head when the last read ran: one card per transcript block
  // asks again, and an unmoved head has nothing new to read.
  let readThrough = -1
  // A transcript refresh asks again while a slow read runs; the refreshes
  // that wait share the next read, so a burst reads the children once more.
  return { replay: createReadQueue(replay).read }

  async function stopOf(childId: string, toolUseId: string, at: number): Promise<StoppedBy | undefined> {
    const known = stops.get(childId)
    if (known?.at === at) return known.by
    const by = await readChildStop(reader, { parentSessionId: sessionId, toolUseId })
    stops.set(childId, { at, by })
    return by
  }

  async function replay(): Promise<SessionToolSummarySnapshot> {
    const head = await reader.capturePosition()
    if (head === readThrough) return { position, summaries, changedToolUseIds: new Set(), measure }
    const changedToolUseIds = new Set<string>()
    const sequence = await reader.aggregateSeq(`session:${sessionId}`)
    const owned = await runs.listForParent(sessionId)
    const children = owned.map(({ workflowId }) => workflowId)
    for (const { workflowId, run } of owned) launches.set(workflowId, run.launchedFrom.toolUseId)
    const resolveChild = async (childId: string) => {
      const toolUseId = launches.get(childId)
      if (toolUseId === undefined) return null
      // The agent is the one the last read found. A new agent moves the
      // workflow aggregate too, so the card is read again and learns it.
      // Every sequence is read before the facts it guards, so a fact
      // written during the reads moves the key and is read next time.
      const knownConversation = agentConversations.get(childId)
      const registration = await runs.read(childId)
      if (!registration) return null
      // A Stop is the launching call's result, in this session, not the
      // child's: it lands before the Stop's teardown moves the child.
      const [workflowSeq, knownConversationSeq, stoppedBy, memberships] = await Promise.all([
        reader.aggregateSeq(workflowAggregateId(childId)),
        conversationSeq(knownConversation),
        stopOf(childId, toolUseId, sequence),
        members.list(childId),
      ])
      const stop = stoppedBy ?? "none"
      const known = sequences.get(childId)
      if (known?.members === memberships && known.key === `${workflowSeq}:${knownConversationSeq}:${stop}`) return { toolUseId, changed: false as const }
      const [queueRead, cut] = await Promise.all([
        queueReads.read(childId, () => loadQueueSnapshotFromReader(reader, childId), UNREADABLE_QUEUE),
        runs.readCut(childId),
      ])
      const queue = queueRead === UNREADABLE_QUEUE ? null : queueRead
      const current = queue?.attempts[queue.cursor]?.lastConversationId
      const [run, currentSeq, agentTurnEnd] = await Promise.all([
        recordsOf(childId),
        current === knownConversation ? knownConversationSeq : conversationSeq(current),
        current === undefined ? undefined : readChatTurnEnd(reader, current),
      ])
      // The key names the agent this read found, so the next replay compares
      // the same conversation and an unmoved card is not read again.
      const key = `${workflowSeq}:${currentSeq}:${stop}`
      const cardState: WorkflowCardState = stoppedBy
        ? { status: stoppedBy === "person" ? "stopped" : "cancelled" }
        : queueRead === UNREADABLE_QUEUE ? UNREADABLE_PROGRESS_STATE : workflowCardState(queue?.status, agentTurnEnd, cut?.by)
      const summary: UntotalledSummary = {
        toolUseId,
        linkUri: `flywheel://workflow/${childId}`,
        memberSessionIds: memberships.map((membership) => membership.sessionId),
        ...cardState,
        ownsSettlement: false,
        ...(run === undefined ? {} : { label: run.name }),
      }
      const plan: CardPlan | undefined = queue === null ? undefined : {
        view: { attempts: frontendAttempts(queue, run?.personas), tree: queue.tree },
        status: cardState.status,
      }
      return { toolUseId, childId, current, key, memberships, summary, plan, changed: true as const }
    }
    const retained = new Set<string>()
    // Cards whose own evidence states something new in this read.
    const restated = new Set<string>()
    // Unbounded reads delayed a control request by seconds on populated
    // sessions. Four children keep the expensive history reads bounded.
    for (let offset = 0; offset < children.length; offset += 4) {
      const resolved = await Promise.all(children.slice(offset, offset + 4).map(resolveChild))
      for (const result of resolved) {
        if (!result) continue
        const { toolUseId } = result
        retained.add(toolUseId)
        if (!result.changed) continue
        const { childId, current, key, memberships, summary, plan } = result
        agentConversations.set(childId, current)
        sequences.set(childId, { key, members: memberships })
        // A card is read again only when its own evidence moved, never on a
        // member's work.
        restated.add(toolUseId)
        cards.set(childId, { summary, plan, members: memberships })
      }
    }
    // The totals of every member and descendant come from one held fold,
    // which reads only the facts committed since its last read. A card that
    // no reader measured yet states only its own evidence, so a replay seeds
    // no card's members: `measure` does, for the cards a client reads.
    for (const childId of children) {
      const toolUseId = launches.get(childId)
      const card = cards.get(childId)
      if (toolUseId === undefined || card === undefined || !retained.has(toolUseId)) continue
      const published = summaries.get(toolUseId)
      const totals = await readHeldWorkflowMemberTotals(reader, childId)
      if (totals === undefined) {
        if (published && !restated.has(toolUseId)) continue
        const untotalled: ToolHistorySummary = { ...card.summary, totalToolCount: 0 }
        unmeasured.set(untotalled, card)
        summaries.set(toolUseId, untotalled)
        changedToolUseIds.add(toolUseId)
        continue
      }
      // A card folds again when its own evidence moved, or when a member's
      // recorded time moved, which happens once at the end of each episode
      // of a member's work. A member's tool and stream facts move only the
      // totals, so they cost no fold.
      const refold = !published || restated.has(toolUseId) || timed.get(childId) !== totals.durations.version
      if (!refold && published.totalToolCount === totals.toolCount && published.totalTokens === tokensOf(totals)) continue
      timed.set(childId, totals.durations.version)
      const next = !refold ? { ...published, ...figuresOf(totals) } : await totalled(childId, card, totals)
      if (published && JSON.stringify(published) === JSON.stringify(next)) continue
      summaries.set(toolUseId, next)
      changedToolUseIds.add(toolUseId)
    }
    for (const id of summaries.keys()) {
      if (!retained.has(id)) {
        summaries.delete(id)
        changedToolUseIds.add(id)
      }
    }
    for (const id of sequences.keys()) if (!children.includes(id)) sequences.delete(id)
    for (const id of agentConversations.keys()) if (!children.includes(id)) agentConversations.delete(id)
    for (const id of launches.keys()) if (!children.includes(id)) launches.delete(id)
    for (const id of records.keys()) if (!children.includes(id)) records.delete(id)
    for (const id of cards.keys()) if (!children.includes(id)) cards.delete(id)
    for (const id of timed.keys()) if (!children.includes(id)) timed.delete(id)
    if (changedToolUseIds.size > 0) position += 1
    readThrough = head
    return { position, summaries, changedToolUseIds, measure }
  }

  /** The card's members' totals, its fold, and its active time, measured
   *  when the card is drawn rather than when its evidence is read. The first
   *  measurement of a card seeds its members in the held fold, and every
   *  replay after it restates the card as they move. */
  async function measure(summary: ToolHistorySummary, live = false): Promise<ToolHistorySummary> {
    // SAFETY: resolveChild sets this URI on every summary; the history registry routes measurements only to their publishing owner.
    const childId = summary.linkUri!.slice("flywheel://workflow/".length)
    const card = unmeasured.get(summary)
    const [measured, time] = await Promise.all([
      card === undefined ? summary : memoizeSuccess(measurements, summary, async () => totalled(childId, card, await readWorkflowMemberTotals(reader, childId))),
      durationOf(childId, live),
    ])
    if (!live) return time.durationMs > 0 ? { ...measured, duration: time.durationMs } : measured
    return { ...measured, duration: time.durationMs, ...(time.streamingStartedAt === null ? {} : { activeStartedAt: time.streamingStartedAt }) }
  }

  /** The card with its members' totals and the fold of its plan, with each
   *  started agent timed by the active time that its session recorded. A
   *  card that a client does not fold itself is one whose run does not run,
   *  so its phases read the run's intervals with no open one. */
  async function totalled(childId: string, card: CardEntry, totals: WorkflowMemberTotals): Promise<ToolHistorySummary> {
    const folded = card.plan === undefined ? undefined : foldCard(card.plan, card.members, totals.durations.bySession, await durationOf(childId, false))
    return { ...card.summary, ...(folded === undefined ? {} : { card: folded }), ...figuresOf(totals) }
  }

  async function conversationSeq(conversationId: string | undefined): Promise<number> {
    return conversationId === undefined ? -1 : await reader.aggregateSeq(`conversation:${conversationId}`)
  }

}

const log = Log.create({ service: "workflow-tool-summary" })

/** The plan of a card that the summary reader folds: the run's attempts and
 *  tree, and the card's state. */
interface CardPlan {
  readonly view: Parameters<typeof workflowOutline>[0]
  readonly status: ToolHistorySummary["status"]
}

/** A card as its own evidence states it, before its members' totals and
 *  times, with the plan that its card folds once those are read. */
interface CardEntry {
  readonly summary: UntotalledSummary
  readonly plan: CardPlan | undefined
  readonly members: readonly WorkflowMember[]
}

/** The bounded fold of a card's plan, with each started agent timed by the
 *  active time that its session recorded, and its phases by when the run was
 *  active. */
function foldCard(plan: CardPlan, members: readonly WorkflowMember[], durations: ReadonlyMap<string, number>, activity: WorkflowRunActivity) {
  const live = members.flatMap(({ sessionId, membership }) => membership.kind === "attempt" ? [{ attemptId: membership.attemptId, sessionId, duration: durations.get(sessionId) ?? 0, revision: 0 }] : [])
  return workflowCard(workflowOutline(plan.view, workflowCardCut(plan.status), live, activity), { settled: workflowCardSettled(plan.status) })
}

function tokensOf(totals: WorkflowMemberTotals): number {
  return totals.display.totalInputTokens + totals.display.totalOutputTokens
}

/** The figures a card states from its members' totals. */
function figuresOf(totals: WorkflowMemberTotals): Pick<ToolHistorySummary, "totalToolCount" | "totalTokens"> {
  return { totalToolCount: totals.toolCount, totalTokens: tokensOf(totals) }
}

/** A card as its own evidence states it, before its members' totals. */
type UntotalledSummary = ToolHistorySummary extends infer Summary ? Summary extends unknown ? Omit<Summary, "totalToolCount" | "totalTokens"> : never : never

/** What the queue read answers when this build cannot read the workflow's
 *  saved progress, which differs from a queue that does not exist yet. */
const UNREADABLE_QUEUE = "unreadable" as const

/** Saved progress that this build cannot read cannot run either, so its card
 *  reads as interrupted by the runtime, with no spinner and no ticking time.
 *  The card's notice and Restart come from the row's admission. */
const UNREADABLE_PROGRESS_STATE: WorkflowCardState = { status: "paused", pausedBy: "runtime" }

type WorkflowCardState =
  | { readonly status: "pending" | "active" | "completed" | "stopped" | "cancelled" }
  | { readonly status: "paused"; readonly pausedBy: PausedBy }
  | { readonly status: "error"; readonly failure: AgentFailureDisplay }

/** The card state of a workflow whose launching call has not settled, read
 *  from the workflow's own evidence the way its row reads it: the committed
 *  status, the turn end of its current agent, and whether a runner holds it.
 *  An interrupted workflow is not running, so its card shows no spinner and
 *  no ticking time. Interrupted means paused control, running control that no
 *  runner holds (an unexpected exit), or a recorded interrupt or crash of its
 *  agent. The agent's turn end names who interrupted it; anything else is the
 *  runtime's. A planned replacement's cut of a running workflow reads as the
 *  running workflow that its successor continues, as it does for a subagent.
 *  A Resume records its continuation before the agent's first request, so a
 *  resumed agent reads interrupted here until its first reply commits. This
 *  reader holds only durable evidence; the transcript's card join lays the
 *  child's live run over it, as a row's live status wins over its evidence. */
function workflowCardState(status: WorkflowView["status"] | undefined, agentTurnEnd: ChatTurnEnd | undefined, cut: "person" | "agent" | "runtime" | "replacement" | undefined): WorkflowCardState {
  switch (status) {
    case undefined:
    case "idle":
      return { status: "pending" }
    case "completed":
      return { status: "completed" }
    case "failed":
      return { status: "error", failure: formatAgentFailureDisplay("Workflow failed") }
    case "paused":
      return { status: "paused", pausedBy: interruptedBy(agentTurnEnd) }
    case "running": {
      if (cut !== undefined && cut !== "replacement") return { status: "paused", pausedBy: cut }
      if (!isVisibleTurnEnd(agentTurnEnd?.end)) return { status: "active" }
      return waitsForPerson(agentTurnEnd) ? { status: "paused", pausedBy: interruptedBy(agentTurnEnd) } : { status: "active" }
    }
  }
}

function interruptedBy(agentTurnEnd: ChatTurnEnd | undefined): PausedBy {
  return agentTurnEnd?.end.reason === "paused" ? agentTurnEnd.end.pausedBy : "runtime"
}
