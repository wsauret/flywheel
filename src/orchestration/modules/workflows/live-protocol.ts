import { isDeepStrictEqual } from "node:util"
import type { AsyncEventStateReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { recordBackgroundFailure } from "../../../infra/operation-log.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../../protocol/runtime-ui-protocol-types.js"
import type { WorkflowAgentLive, WorkflowLiveView } from "../../../protocol/workflow-view-protocol-types.js"
import { workflowLiveCursor } from "../../../protocol/modules/workflows.js"
import type { StartedAgent } from "../../../workflows/vm/host-commit-controller.js"
import type { SessionEntry, SessionStore } from "../../session-store/types.js"
import { entryActivity } from "../../session-store/activity.js"
import { workflowMembershipReader, type WorkflowMember } from "../../session/workflow-membership.js"
import { workflowRunReader } from "../../module-catalog.js"
import { readStartedAgentsLive, type ConversationLive, type StartedAgentsChange, type StartedAgentStates, type StartedAgentsLive } from "../../workflow-host/started-agent-states.js"
import { readWorkflowMemberDurations } from "../../workflow-host/member-totals.js"
import { agentLive } from "./compact-activity.js"

export interface WorkflowLiveProtocolProjection {
  snapshot(workflowId: string): Promise<WorkflowLiveView | null>
  settled(): Promise<void>
  dispose(): void
}
interface WorkflowLiveProtocolProjectionDeps {
  readonly sessionStore: LiveEntries & Pick<SessionStore, "onChange">
  readonly reader: AsyncEventStateReadSurface
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  /** The owner of each started agent's durable state, which the held detail reads too. */
  readonly agents: Pick<StartedAgentStates, "started" | "conversations" | "onChange" | "onStarted" | "settled">
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch | undefined
}

/** The live entries of members: the view reads their blocks, their active
 *  clock, and, while an attempt runs, the operations it counted. */
interface LiveEntries { get(sessionId: string): (Pick<SessionEntry, "outputBlocks" | "runnerState" | "streamPhase" | "accumulatedActiveMs" | "streamingStartedAt"> & { readonly operations?: number | null }) | undefined }

function countsLive(sessions: LiveEntries | undefined, sessionId: string | undefined): boolean {
  return sessionId !== undefined && typeof sessions?.get(sessionId)?.operations === "number"
}

interface Member { readonly sessionId: string; readonly attemptId: string }

/** One member's live state. A member with a live entry reads its session's
 *  clock there; any other member reads the active time that its session
 *  recorded. Only a started agent, one whose attempt runs or that an
 *  interrupt holds, counts its operations live; a settled agent's count is
 *  its attempt's outcome. Compact activity derives from ordinary member
 *  state, never another transcript buffer. */
function composeAgent(workflow: Pick<HeldWorkflow, "conversationOf" | "durable" | "recorded">, { sessionId, attemptId }: Member, sessions: LiveEntries | undefined): WorkflowAgentLive {
  const entry = sessions?.get(sessionId)
  const prior = workflow.durable.get(attemptId)
  const operations = workflow.conversationOf.has(attemptId) ? entry?.operations ?? prior?.operations ?? 0 : undefined
  if (entry) {
    const time = { duration: entry.accumulatedActiveMs, ...(entry.streamingStartedAt === null ? {} : { activeStartedAt: entry.streamingStartedAt }) }
    return agentLive(sessionId, attemptId, operations, entry.outputBlocks(), entryActivity(entry), time, prior?.interruptedAt)
  }
  return {
    attemptId, sessionId, duration: workflow.recorded.get(sessionId) ?? 0, revision: 0,
    ...(operations === undefined ? {} : { operations }),
    ...(prior?.interruptedAt ? { interruptedAt: prior.interruptedAt } : {}),
  }
}

/** Whether composing the named members reads recorded active time: only a
 *  member with no live entry does. */
function readsRecorded(workflow: Pick<HeldWorkflow, "members">, sessionIds: Iterable<string>, sessions: LiveEntries | undefined): boolean {
  for (const sessionId of sessionIds) if (workflow.members.has(sessionId) && !sessions?.get(sessionId)) return true
  return false
}

/** Reads a workflow's members, or nothing for a run that does not exist.
 *  Members derive from session creation and deletion, and the list keeps
 *  its identity until a fact moves it. */
async function readMemberships(reader: AsyncEventStateReadSurface, workflowId: string): Promise<readonly WorkflowMember[] | null> {
  if (!await workflowRunReader(reader).read(workflowId)) return null
  return await workflowMembershipReader(reader).list(workflowId)
}

/** What the live view holds of one workflow: its members and its started
 *  agents as it last read them, indexes of both, the durable state of each
 *  started agent, and the agents it composed, by session, in member order.
 *  A change advances these in place, so it costs what it moved. */
interface HeldWorkflow {
  memberships: readonly WorkflowMember[]
  /** The list of the agent owner that the started indexes hold. */
  started: readonly StartedAgent[]
  readonly members: Map<string, Member>
  readonly byAttempt: Map<string, Member>
  /** The conversation of each started agent, by attempt, and its attempt, by conversation. */
  readonly conversationOf: Map<string, string>
  readonly attemptOf: Map<string, string>
  /** The durable state of each started agent, by attempt. */
  readonly durable: Map<string, ConversationLive>
  /** The active time that each member's session recorded, which the held
   *  member fold advances in place when it is read. */
  recorded: ReadonlyMap<string, number>
  agents: Map<string, WorkflowAgentLive>
}

/** The members of a membership list in member order. */
function attemptMembers(memberships: readonly WorkflowMember[]): Member[] {
  return memberships.flatMap(({ sessionId, membership }) => membership.kind === "attempt" ? [{ sessionId, attemptId: membership.attemptId }] : [])
}

function indexMembers(workflow: Pick<HeldWorkflow, "members" | "byAttempt">, memberships: readonly WorkflowMember[]): void {
  workflow.members.clear()
  workflow.byAttempt.clear()
  for (const member of attemptMembers(memberships)) {
    workflow.members.set(member.sessionId, member)
    workflow.byAttempt.set(member.attemptId, member)
  }
}

/** Holds the members and the started agents with no durable state read and no agent composed. */
function heldWorkflow(memberships: readonly WorkflowMember[], started: readonly StartedAgent[]): HeldWorkflow {
  const workflow: HeldWorkflow = { memberships, started, members: new Map(), byAttempt: new Map(), conversationOf: new Map(), attemptOf: new Map(), durable: new Map(), recorded: new Map(), agents: new Map() }
  indexMembers(workflow, memberships)
  for (const { attemptId, conversationId } of started) {
    workflow.conversationOf.set(attemptId, conversationId)
    workflow.attemptOf.set(conversationId, attemptId)
  }
  return workflow
}

/** The member whose started agent holds a conversation. */
function memberOfConversation(workflow: HeldWorkflow, conversationId: string): Member | undefined {
  const attemptId = workflow.attemptOf.get(conversationId)
  return attemptId === undefined ? undefined : workflow.byAttempt.get(attemptId)
}

/** Reads the durable state of the named conversations into the workflow.
 *  A running attempt counts its operations on its live entry, so the read
 *  of its conversation leaves the tree out: with 150 agents streaming, a
 *  tree read for each conversation fact replayed every tree from its start.
 *  The tree is read once the attempt stops counting. */
async function readDurable(agents: Pick<StartedAgentsLive, "conversations">, workflowId: string, workflow: HeldWorkflow, conversationIds: readonly string[], sessions: LiveEntries | undefined): Promise<void> {
  if (conversationIds.length === 0) return
  const states = await agents.conversations(workflowId, conversationIds, (conversationId) => !countsLive(sessions, memberOfConversation(workflow, conversationId)?.sessionId))
  for (const [conversationId, live] of states) {
    const attemptId = workflow.attemptOf.get(conversationId)
    if (attemptId !== undefined) workflow.durable.set(attemptId, live)
  }
}

/** Reads a workflow whole, with every agent composed, or nothing for a run that does not exist. */
async function loadWorkflow(reader: AsyncEventStateReadSurface, workflowId: string, agents: Pick<StartedAgentsLive, "started" | "conversations">, sessions: LiveEntries | undefined): Promise<HeldWorkflow | null> {
  if (!await workflowRunReader(reader).read(workflowId)) return null
  const [memberships, started] = await Promise.all([workflowMembershipReader(reader).list(workflowId), agents.started(workflowId)])
  const workflow = heldWorkflow(memberships, started)
  await readDurable(agents, workflowId, workflow, started.map(({ conversationId }) => conversationId), sessions)
  if (readsRecorded(workflow, workflow.members.keys(), sessions)) workflow.recorded = await readWorkflowMemberDurations(reader, workflowId)
  for (const member of workflow.members.values()) workflow.agents.set(member.sessionId, composeAgent(workflow, member, sessions))
  return workflow
}

function liveView(workflow: HeldWorkflow | null): WorkflowLiveView | null {
  return workflow ? { agents: [...workflow.agents.values()] } : null
}

export async function readWorkflowLiveView(reader: AsyncEventStateReadSurface, workflowId: string): Promise<WorkflowLiveView | null> {
  return liveView(await loadWorkflow(reader, workflowId, readStartedAgentsLive(reader), undefined))
}

const WORKFLOW_PREFIX = "workflow:"
const SESSION_PREFIX = "session:"

/** Holds each subscribed workflow's live view and advances it by what each
 *  change moved. A session creation or deletion, or a fact of
 *  `workflow:<id>`, reads the members and composes only the members that
 *  joined or left. A change of the started agents that the agent owner
 *  tells reads and composes only the agents that started or settled. A
 *  change that the agent owner names reads and composes only the agents
 *  whose conversations it names, and not an agent's tree while its attempt
 *  runs. A session store change composes only the members it names, and
 *  reads the tree of an agent whose attempt stopped since a change last
 *  moved that tree. Each publication carries only the agents that moved,
 *  and the order of every agent when the set of agents changed, so a change
 *  of one member costs the same whatever the number of members. A snapshot
 *  loads and installs in the same order as every change, so the snapshot
 *  and the patches after it reach the current state. */
export function createWorkflowLiveProtocolProjection(deps: WorkflowLiveProtocolProjectionDeps): WorkflowLiveProtocolProjection {
  /** Each subscribed workflow, or null for one whose run does not exist. */
  const held = new Map<string, HeldWorkflow | null>()
  /** The workflow of each member session that a held workflow holds. */
  const workflowOf = new Map<string, string>()
  /** The started changes told for each workflow that a snapshot loads and nothing holds yet. */
  const loading = new Map<string, StartedAgentsChange[]>()
  let pending = Promise.resolve()
  let disposed = false

  const hold = (workflowId: string, workflow: HeldWorkflow | null) => {
    for (const sessionId of held.get(workflowId)?.members.keys() ?? []) workflowOf.delete(sessionId)
    for (const sessionId of workflow?.members.keys() ?? []) workflowOf.set(sessionId, workflowId)
    held.set(workflowId, workflow)
  }
  /** Composes the named members from what the workflow holds, and publishes
   *  the agents that moved, with the order of every agent when the set of
   *  agents changed. */
  const compose = (workflowId: string, workflow: HeldWorkflow, sessionIds: Iterable<string>, membershipChanged = false) => {
    const moved: WorkflowAgentLive[] = []
    let reordered = membershipChanged
    for (const sessionId of sessionIds) {
      const member = workflow.members.get(sessionId)
      const kept = workflow.agents.get(sessionId)
      const agent = member && composeAgent(workflow, member, deps.sessionStore)
      if (!agent) {
        if (workflow.agents.delete(sessionId)) reordered = true
        continue
      }
      if (kept === undefined) reordered = true
      workflow.agents.set(sessionId, agent)
      if (!isDeepStrictEqual(agent, kept)) moved.push(agent)
    }
    // An agent that joins or leaves moves the order, which the members
    // state. That is rare beside the changes of one agent.
    if (reordered) workflow.agents = new Map([...workflow.members.keys()].flatMap((sessionId) => { const agent = workflow.agents.get(sessionId); return agent ? [[sessionId, agent] as const] : [] }))
    if (moved.length > 0 || reordered) deps.publish({ cursor: workflowLiveCursor(workflowId), payload: { kind: "workflow_live.changed", agents: moved, ...(reordered ? { order: [...workflow.agents.keys()] } : {}) } })
  }
  /** Advances the held member fold before a compose of the named members
   *  that reads recorded active time. The fold reads only the facts committed
   *  since its last read, so this costs what moved. */
  const readRecorded = async (workflowId: string, workflow: HeldWorkflow, sessionIds: Iterable<string>) => {
    if (readsRecorded(workflow, sessionIds, deps.sessionStore)) workflow.recorded = await readWorkflowMemberDurations(deps.reader, workflowId)
  }
  /** Reads the conversations of the named members whose attempts stopped
   *  counting operations before any read counted them, then composes the
   *  named members. */
  const composeMembers = async (workflowId: string, workflow: HeldWorkflow, sessionIds: readonly string[]) => {
    const uncounted = sessionIds.flatMap((sessionId) => {
      const member = workflow.members.get(sessionId)
      if (!member) return []
      const conversationId = workflow.conversationOf.get(member.attemptId)
      if (conversationId === undefined) return []
      const durable = workflow.durable.get(member.attemptId)
      return durable && durable.operations === undefined && !countsLive(deps.sessionStore, sessionId) ? [conversationId] : []
    })
    await readDurable(deps.agents, workflowId, workflow, uncounted, deps.sessionStore)
    await readRecorded(workflowId, workflow, sessionIds)
    if (!disposed) compose(workflowId, workflow, sessionIds)
  }
  /** Indexes the members again and composes only the members that joined or left. */
  const advanceMembers = async (workflowId: string, workflow: HeldWorkflow, memberships: readonly WorkflowMember[]) => {
    if (memberships === workflow.memberships) return
    workflow.memberships = memberships
    const before = new Map(workflow.members)
    indexMembers(workflow, memberships)
    const touched = new Set<string>()
    for (const [sessionId, member] of before) if (workflow.members.get(sessionId)?.attemptId !== member.attemptId) { touched.add(sessionId); workflowOf.delete(sessionId) }
    for (const [sessionId, member] of workflow.members) if (before.get(sessionId)?.attemptId !== member.attemptId) { touched.add(sessionId); workflowOf.set(sessionId, workflowId) }
    if (touched.size === 0) return
    await readRecorded(workflowId, workflow, touched)
    if (!disposed) compose(workflowId, workflow, touched, true)
  }
  /** Applies one change of the started agents that the workflow holds the
   *  list before of: forgets the agents that settled, reads the agents that
   *  started, and composes only their members. A view that a snapshot read
   *  after the change already holds it. */
  const advanceStarted = async (workflowId: string, workflow: HeldWorkflow, change: StartedAgentsChange) => {
    if (workflow.started !== change.before) return
    workflow.started = change.after
    const touched = new Set<string>()
    const touch = (attemptId: string) => {
      const sessionId = workflow.byAttempt.get(attemptId)?.sessionId
      if (sessionId !== undefined) touched.add(sessionId)
    }
    for (const { attemptId, conversationId } of change.settled) {
      workflow.conversationOf.delete(attemptId)
      workflow.attemptOf.delete(conversationId)
      workflow.durable.delete(attemptId)
      touch(attemptId)
    }
    for (const { attemptId, conversationId } of change.started) {
      workflow.conversationOf.set(attemptId, conversationId)
      workflow.attemptOf.set(conversationId, attemptId)
      workflow.durable.delete(attemptId)
      touch(attemptId)
    }
    await readDurable(deps.agents, workflowId, workflow, change.started.map(({ conversationId }) => conversationId), deps.sessionStore)
    await readRecorded(workflowId, workflow, touched)
    if (!disposed) compose(workflowId, workflow, touched)
  }
  /** Runs `work` after every earlier change and snapshot, and returns its result. */
  const serialized = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = pending.then(work)
    pending = run.then(() => {}, () => {})
    return run
  }
  const sync = (work: () => Promise<void>) => {
    void serialized(async () => { if (!disposed) await work() })
      .catch((error: unknown) => recordBackgroundFailure(Log.create({ service: "workflow-live-protocol" }), "publish workflow activity", { workflows: held.size }, error))
  }
  /** Reads the members of each held workflow that `selects` names again and advances it. */
  const reread = (selects: (workflowId: string) => boolean) => sync(async () => {
    for (const [workflowId, workflow] of held) {
      if (!selects(workflowId)) continue
      if (!workflow) {
        const loaded = await loadWorkflow(deps.reader, workflowId, deps.agents, deps.sessionStore)
        if (disposed) return
        if (!loaded) continue
        hold(workflowId, loaded)
        deps.publish({ cursor: workflowLiveCursor(workflowId), payload: { kind: "workflow_live.changed", agents: [...loaded.agents.values()], order: [...loaded.agents.keys()] } })
        continue
      }
      const memberships = await readMemberships(deps.reader, workflowId)
      if (disposed) return
      if (!memberships) {
        hold(workflowId, null)
        deps.publish({ cursor: workflowLiveCursor(workflowId), payload: { kind: "workflow_live.removed" } })
        continue
      }
      await advanceMembers(workflowId, workflow, memberships)
    }
  })
  const offStore = deps.sessionStore.onChange((changed) => {
    if (held.size === 0) return
    const touched = new Map<string, string[]>()
    if (!changed) {
      for (const [workflowId, workflow] of held) if (workflow) touched.set(workflowId, [...workflow.members.keys()])
    } else {
      for (const sessionId of changed) {
        const workflowId = workflowOf.get(sessionId)
        if (workflowId === undefined) continue
        const sessions = touched.get(workflowId)
        if (sessions) sessions.push(sessionId)
        else touched.set(workflowId, [sessionId])
      }
    }
    if (touched.size === 0) return
    sync(async () => {
      for (const [workflowId, sessionIds] of touched) {
        const workflow = held.get(workflowId)
        if (workflow) await composeMembers(workflowId, workflow, sessionIds)
        if (disposed) return
      }
    })
  }, "workflow-live-protocol")
  const offFacts = deps.onStored((events) => {
    if (held.size === 0) return
    let workflows: Set<string> | undefined
    let membership = false
    // A member that no runner holds states the active time its session
    // recorded, which can land after its runner left the store.
    const recorded = new Map<string, string[]>()
    for (const { aggregateId, type } of events) {
      if (type === "session.created" || type === "session.deleted") membership = true
      if (aggregateId.startsWith(WORKFLOW_PREFIX)) (workflows ??= new Set()).add(aggregateId.slice(WORKFLOW_PREFIX.length))
      if (type !== "session.duration.recorded" || !aggregateId.startsWith(SESSION_PREFIX)) continue
      const sessionId = aggregateId.slice(SESSION_PREFIX.length)
      const workflowId = workflowOf.get(sessionId)
      if (workflowId === undefined || deps.sessionStore.get(sessionId)) continue
      const sessions = recorded.get(workflowId)
      if (sessions) sessions.push(sessionId)
      else recorded.set(workflowId, [sessionId])
    }
    if (recorded.size > 0) {
      sync(async () => {
        for (const [workflowId, sessionIds] of recorded) {
          const workflow = held.get(workflowId)
          if (workflow) await composeMembers(workflowId, workflow, sessionIds)
          if (disposed) return
        }
      })
    }
    if (!membership && !workflows) return
    reread((workflowId) => membership || workflows?.has(workflowId) === true)
  })
  const offStarted = deps.agents.onStarted((workflowId, change) => {
    if (!held.get(workflowId)) {
      loading.get(workflowId)?.push(change)
      return
    }
    sync(async () => {
      const workflow = held.get(workflowId)
      if (workflow) await advanceStarted(workflowId, workflow, change)
    })
  })
  const offAgents = deps.agents.onChange((workflowIds, conversationIds) => {
    if (held.size === 0) return
    sync(async () => {
      for (const workflowId of workflowIds) {
        const workflow = held.get(workflowId)
        if (!workflow) continue
        const moved = [...conversationIds].filter((conversationId) => workflow.attemptOf.has(conversationId))
        await readDurable(deps.agents, workflowId, workflow, moved, deps.sessionStore)
        const sessionIds = moved.flatMap((conversationId) => memberOfConversation(workflow, conversationId)?.sessionId ?? [])
        await readRecorded(workflowId, workflow, sessionIds)
        if (disposed) return
        compose(workflowId, workflow, sessionIds)
      }
    })
  })
  return {
    snapshot: (workflowId) => serialized(async () => {
      const changes: StartedAgentsChange[] = []
      loading.set(workflowId, changes)
      try {
        const workflow = await loadWorkflow(deps.reader, workflowId, deps.agents, deps.sessionStore)
        if (disposed) return liveView(workflow)
        hold(workflowId, workflow)
        // A change told while the load read can postdate what it read.
        if (workflow) for (const change of changes) await advanceStarted(workflowId, workflow, change)
        return liveView(workflow)
      } finally {
        loading.delete(workflowId)
      }
    }),
    async settled() {
      await deps.agents.settled()
      await pending
    },
    dispose() { disposed = true; offStore(); offFacts(); offStarted(); offAgents(); held.clear(); workflowOf.clear() },
  }
}
