import { workflowOutline, type WorkflowOutline } from "../../../../src/protocol/client/workflow-outline.js"
import type { LoadedWorkflowView, WorkflowAgentLive, WorkflowTreeAgent, WorkflowTreeDisposition, WorkflowTreeNode } from "../../../../src/protocol/workflow-view-protocol-types.js"

type Attempt = LoadedWorkflowView["attempts"][number]

/** One agent as a fixture states it: its disposition and, once it started,
 *  when it started and finished, in seconds from the run's start. */
export interface AgentFixture {
  readonly disposition: WorkflowTreeDisposition
  readonly startedAt?: number
  readonly completedAt?: number
  readonly summary?: string
  readonly reason?: string
}

const pending: AgentFixture = { disposition: "pending" }
const done = (startedAt: number, completedAt: number, summary?: string): AgentFixture => ({ disposition: "completed", startedAt, completedAt, ...(summary === undefined ? {} : { summary }) })
const running = (startedAt: number): AgentFixture => ({ disposition: "running", startedAt })

export const REVIEW_KEYS = ["agents.ts", "auth.ts", "cache.ts", "config.ts", "db.ts", "events.ts", "flags.ts", "http.ts", "jobs.ts", "logs.ts", "mail.ts", "queue.ts", "search.ts", "users.ts"] as const
const LANE_KEYS = ["api", "cli", "web"] as const

/** The audit's test workflow: a `scout` agent, a `lanes` list of three
 *  items that each run `probe` then `check`, a `reviews` list of 14 items, a
 *  parallel phase `gates` that runs `lint` and `typecheck`, and a `report`
 *  agent. A list whose items are absent has not read them. */
export interface FanoutFixture {
  readonly scout: AgentFixture
  readonly lanes?: readonly (readonly [AgentFixture, AgentFixture])[]
  readonly reviews?: readonly AgentFixture[]
  readonly gates: readonly [AgentFixture, AgentFixture]
  readonly report: AgentFixture
  readonly currentAgentNodeId?: string
}

const capitalized = (id: string) => id.charAt(0).toUpperCase() + id.slice(1)

/** The view of a {@link FanoutFixture}, with each started agent's attempt row. */
export function fanoutView(fixture: FanoutFixture): LoadedWorkflowView {
  const nodes: WorkflowTreeNode[] = []
  const attempts: Attempt[] = []
  const settled = (states: readonly AgentFixture[]) => states.every(({ disposition }) => disposition === "completed" || disposition === "failed" || disposition === "skipped")
  const phaseState = (states: readonly AgentFixture[]): WorkflowTreeDisposition =>
    states.length > 0 && states.every(({ disposition }) => disposition === "skipped") ? "skipped"
      : states.length > 0 && settled(states) ? (states.some(({ disposition }) => disposition === "failed") ? "failed" : "completed")
        : states.some(({ startedAt }) => startedAt !== undefined) ? "running" : "pending"
  const agent = (id: string, definitionId: string, parentId: string, state: AgentFixture, item?: WorkflowTreeAgent["item"]) => {
    const attempt = state.startedAt === undefined ? undefined : `${id}-1`
    nodes.push({
      id, kind: "agent", definitionId, label: capitalized(definitionId), parentId, disposition: state.disposition, attempts: attempt === undefined ? 0 : 1,
      ...(attempt === undefined ? {} : { currentAttemptId: attempt }),
      ...(state.summary === undefined ? {} : { evidence: { summary: state.summary } }),
      ...(state.reason === undefined ? {} : { reason: state.reason }),
      ...(item === undefined ? {} : { item }),
    })
    if (attempt !== undefined) attempts.push({
      history: [],
      id: attempt, definitionId, briefId: definitionId, name: definitionId, status: state.disposition === "completed" ? "completed" : state.disposition === "failed" ? "failed" : state.disposition === "pending" ? "pending" : "running",
      startedAt: state.startedAt! * 1000, ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt * 1000 }),
    })
  }
  const single = (id: string, state: AgentFixture) => {
    nodes.push({ id: `${id}:phase`, kind: "phase", form: "single", phaseId: id, label: capitalized(id), parentId: null, disposition: state.disposition })
    agent(id, id, `${id}:phase`, state)
  }
  /** A stream of one phase for each of `phaseIds` over the list `id`. */
  const list = (id: string, phaseIds: readonly string[], keys: readonly string[], items: readonly (readonly AgentFixture[])[] | undefined) => {
    const streams = items ?? []
    for (const [position, phaseId] of phaseIds.entries()) {
      const states = streams.map((stream) => stream[position]!)
      const last = position === phaseIds.length - 1
      const failed = streams.filter((stream) => stream.some(({ disposition }) => disposition === "failed")).length
      const completed = streams.filter((stream) => stream.every(({ disposition }) => disposition === "completed")).length
      const phase = `${id}:phase:${position + 1}`
      nodes.push({
        id: phase, kind: "phase", form: "list", phaseId, label: capitalized(phaseId), parentId: null, disposition: items === undefined ? "pending" : phaseState(states),
        list: { id, expanded: items !== undefined },
        ...(items === undefined || !last ? {} : { join: { reducer: "collect@1", state: settled(streams.flat()) ? "settled" : "pending", slots: streams.length, completed, failed, pending: streams.length - completed - failed, missing: 0 } }),
      })
      for (const [index, state] of states.entries()) {
        const key = keys[index]!
        agent(`${id}:${index + 1}:${phaseId}`, phaseId, phase, state, { nodeId: `${id}:${index + 1}`, key, label: key, ordinal: index + 1, text: key })
      }
    }
  }
  single("scout", fixture.scout)
  list("lanes", ["probe", "check"], LANE_KEYS, fixture.lanes)
  list("reviews", ["review"], REVIEW_KEYS, fixture.reviews?.map((state) => [state]))
  const gates = fixture.gates
  nodes.push({ id: "gates", kind: "phase", form: "parallel", phaseId: "gates", label: "gates", parentId: null, disposition: phaseState(gates) })
  agent("gates:lint", "lint", "gates", gates[0])
  agent("gates:typecheck", "typecheck", "gates", gates[1])
  single("report", fixture.report)
  return { attemptsStatus: "loaded", attempts, tree: { nodes, ...(fixture.currentAgentNodeId === undefined ? {} : { currentAgentNodeId: fixture.currentAgentNodeId }) } }
}

/** The outline of a {@link FanoutFixture} whose run worked with no pause from
 *  its start, and whose agents worked from their start to their end: each
 *  started agent's session clock, and the run's one open interval. */
export function timedFanoutOutline(fixture: FanoutFixture, cut?: string): WorkflowOutline {
  const view = fanoutView(fixture)
  const live = view.attempts.flatMap(({ id, status, startedAt, completedAt }): WorkflowAgentLive[] => startedAt === undefined ? [] : [{
    attemptId: id, sessionId: `${id}-session`, revision: 0,
    duration: completedAt === undefined ? 0 : completedAt - startedAt,
    ...(status === "running" ? { activeStartedAt: startedAt } : {}),
  }])
  return workflowOutline(view, cut, live, { activeIntervals: [], streamingStartedAt: 0 })
}

const lanesDone = [[done(184, 230), done(230, 250)], [done(184, 240), done(240, 260)], [done(184, 300), done(300, 496)]] as const
const reviewsAt = (finished: number) => REVIEW_KEYS.map((_, index) => index < finished ? done(500, 569 + index % 6, `Reviewed ${REVIEW_KEYS[index]}.`) : running(507))
/** Once an interrupt settles, the runtime returns each agent it cut to
 *  pending; the attempt that started stays. */
const cutAt = (finished: number) => reviewsAt(finished).map((state) => state.disposition === "running" ? { disposition: "pending" as const, startedAt: 507 } : state)

/** The run at each point the card's mockups draw. Times are in seconds. */
export const FANOUT = {
  launched: { scout: pending, gates: [pending, pending], report: pending },
  scout: { scout: running(0), gates: [pending, pending], report: pending, currentAgentNodeId: "scout" },
  lanes: {
    scout: done(0, 184, "The wait command exited 0 after 3m 4s; gates/scout exists."),
    lanes: [[running(191), pending], [done(184, 270), running(290)], [done(184, 271), running(291)]],
    gates: [pending, pending], report: pending,
  },
  reviews: { scout: done(0, 184), lanes: lanesDone, reviews: reviewsAt(3), gates: [pending, pending], report: pending },
  /** T4 to T7: two reviews done, one failed, and eleven running. */
  reviewsFailing: {
    scout: done(0, 5, "Gate scout present; changed no files"), lanes: lanesDone,
    reviews: REVIEW_KEYS.map((key, index) => key === "db.ts" ? { disposition: "failed" as const, startedAt: 500, completedAt: 540, reason: "Type check failed: db.ts:42 expects a Pool" } : index < 2 ? done(500, 560, `Reviewed ${key}.`) : running(507)),
    gates: [pending, pending], report: pending,
  },
  reviewsCut: { scout: done(0, 184), lanes: lanesDone, reviews: cutAt(3), gates: [pending, pending], report: pending, currentAgentNodeId: "reviews:4:review" },
  gates: { scout: done(0, 184), lanes: lanesDone, reviews: reviewsAt(14), gates: [done(580, 620), running(582)], report: pending },
} as const satisfies { readonly [point: string]: FanoutFixture }

/** The run failed: one review failed, so the gates and the report never ran. */
export const FANOUT_FAILED: FanoutFixture = {
  scout: done(0, 184, "The wait command exited 0 after 3m 4s; gates/scout exists."),
  lanes: lanesDone,
  reviews: REVIEW_KEYS.map((key) => key === "db.ts" ? { disposition: "failed", startedAt: 500, completedAt: 560, reason: "the step ended without a handoff" } : done(500, 569)),
  gates: [{ disposition: "skipped" }, { disposition: "skipped" }],
  report: { disposition: "skipped" },
}

/** The run completed. */
export const FANOUT_COMPLETED: FanoutFixture = {
  scout: done(0, 184, "The wait command exited 0 after 3m 4s; gates/scout exists."),
  lanes: lanesDone,
  reviews: reviewsAt(14),
  gates: [done(580, 620), done(582, 677)],
  report: done(680, 681, "The report gate file exists, so the wait exited 0."),
}
