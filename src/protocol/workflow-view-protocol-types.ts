import type { SystemBlock, ToolPresentation, UserMessageBlock } from "../infra/output-blocks.js"
import type { FrontendActivity } from "./app-service-types.js"

/** One subagent seat a brief declares: the role it fills and the personas
 *  the compiler resolved for it. Compiled from brief frontmatter plus persona
 *  metadata, and carried to clients so command catalogs and agent views can
 *  name the seats a launch will staff. */
export interface BriefPersonaSlot {
  readonly role: string
  readonly personas: readonly string[]
}

type FrontendWorkflowState = "idle" | "running" | "completed" | "failed" | "paused"
/** Attempt status. Work without an attempt belongs only to the tree. */
export type FrontendAttemptStatus = "pending" | "running" | "completed" | "blocked" | "failed" | "skipped"

/** The persona that an agent record names: its id, such as
 *  `reviewer-code-security`, and the roles whose seats it reads, narrowest
 *  first: the role of the installed persona, such as `reviewer-security`,
 *  then the role it falls back to, such as `reviewer`. Each role names a
 *  persona seat under the agent's brief (`brief.<brief>.persona.<role>`)
 *  and a seat of its own. A persona that this build does not install reads
 *  no role. */
export interface WorkflowAgentPersona {
  readonly id: string
  readonly roles: readonly string[]
}

/** One attempt of an agent of the workflow. */
export interface FrontendAttempt {
  readonly id: string
  readonly agentNodeId?: string
  readonly sessionId?: string
  readonly conversationId?: string
  readonly history: readonly { readonly sessionId: string; readonly conversationId: string }[]
  /** The agent record that the attempt runs. */
  readonly definitionId: string
  /** The brief that the attempt runs, which names its model seat. */
  readonly briefId: string
  /** The persona that the attempt's agent record names, read from the
   *  record that the run recorded. */
  readonly persona?: WorkflowAgentPersona
  readonly name: string
  readonly status: FrontendAttemptStatus
  readonly startedAt?: number
  readonly completedAt?: number
  readonly toolUses?: number
}

/** Where one node of a workflow tree stands. It is separate from
 *  {@link FrontendAttemptStatus}: an attempt row is one try, and a tree node
 *  is one agent, phase, or repeat, whose retries are attempts of one agent.
 *  - `pending`: it has not run yet. An agent that an interrupt parked is
 *    pending until it runs again.
 *  - `running`: an agent whose attempt runs now, or a phase or a repeat
 *    that holds work that has not finished.
 *  - `completed`, `failed`: its committed outcome. A failed agent of a list
 *    stops only the agents that follow it in its stream.
 *  - `skipped`: it never runs, because its `if` was false, its repeat
 *    stopped, or work it depends on failed or was replaced. Its reason says
 *    why.
 *  - `conditional`: a handoff has not decided whether this work runs. */
export type WorkflowTreeDisposition = "pending" | "conditional" | "running" | "completed" | "failed" | "skipped"

/** The breadth coverage that a coverage reducer reports for its join. It
 *  comes only from the reducer's settled output; no reader computes it.
 *  `full` holds only when the survey reached every required target, and
 *  `empty` means the list had no targets. */
export interface WorkflowTreeCoverage {
  readonly status: "full" | "partial" | "empty"
  /** The required targets that the survey reached, out of all of them. */
  readonly required: { readonly surveyed: number; readonly total: number }
  /** The keys of the required targets that the survey did not reach, in
   *  stable key order. */
  readonly unsurveyed: readonly string[]
}

/** What a selecting reducer kept and dropped at its join. It comes only from
 *  the reducer's settled output; no reader computes it. `verb` names the
 *  kept entries: `kept` for a filter or a ranking, such as dedupe or top,
 *  and `passed` for the verdicts of a vote, such as quorum, whose dropped
 *  verdicts did not pass. */
export interface WorkflowTreeSelection {
  readonly verb: "kept" | "passed"
  readonly kept: number
  readonly dropped: number
}

/** The join of one phase: the items of a list, or the named agents of a
 *  phase. Every slot is in exactly one of `completed`, `failed`, `pending`,
 *  or `missing`, so the four always add up to `slots`, and an empty list has
 *  zero slots. */
export interface WorkflowTreeJoin {
  /** The reducer that folds the join, as `<id>@<version>`. */
  readonly reducer: string
  /** `settled` once the reducer folded every slot. */
  readonly state: "pending" | "settled"
  readonly slots: number
  readonly completed: number
  readonly failed: number
  /** Slots whose agents have not finished yet. */
  readonly pending: number
  /** Slots that the list names but whose agents control does not hold. */
  readonly missing: number
  /** Present only for a join whose reducer reports coverage. */
  readonly coverage?: WorkflowTreeCoverage
  /** Present only for a settled join whose reducer selects entries. */
  readonly selection?: WorkflowTreeSelection
}

/** What an agent's committed work reports, beside its disposition. */
interface WorkflowTreeEvidence {
  /** The first line of the summary that the agent's completed attempt
   *  handed off. */
  readonly summary?: string
}

/** Where one round of a repeat stands: its 1-based number, and, once the
 *  repeat decided, how the round ended. `next`: a later round runs. `dry`:
 *  the field that the repeat reads was empty, so the repeat stopped.
 *  `bound`: the round was the last one that the repeat allows, and it was
 *  not dry. */
export interface WorkflowTreeRound {
  readonly number: number
  readonly outcome?: "next" | "dry" | "bound"
}

/** State of a repeat. The outcome is absent until the committed control
 *  establishes why the repeat stopped. */
export interface WorkflowTreeLoop {
  readonly iteration: number
  readonly maxIterations: number
  readonly outcome?: "dry" | "bound" | "stuck"
}

/** The item that an agent of a phase over a list works on. */
interface WorkflowTreeItem {
  /** The control node of the item, which a message to the item names. */
  readonly nodeId: string
  /** The item key, with `#<vote>` for a vote, such as `src/a.ts:42#2`. */
  readonly key: string
  /** The item's display name: its label field or its key, with ` #<vote>`
   *  for a vote. */
  readonly label: string
  /** The 1-based position of the item in its list. */
  readonly ordinal: number
  /** The item on one line, as the agent receives it. */
  readonly text: string
}

interface WorkflowTreeNodeFields {
  readonly id: string
  readonly label: string
  /** The owning phase or repeat, or null for a node that the workflow owns. */
  readonly parentId: string | null
  readonly disposition: WorkflowTreeDisposition
  /** Why the node failed or is skipped. */
  readonly reason?: string
}

/** One phase of the workflow, or one round of a phase of a repeat. A phase
 *  holds its agents as children: one for a `single` phase, the named agents
 *  of a `parallel` phase, and one for each item or vote of a `list` phase.
 *  The phases of one stream share `list`, in stream order, and an agent of
 *  a later phase follows the agent of the phase before with the same item
 *  key. The id is the id of the control node that holds the phase, or,
 *  where none holds it alone, the id of its agent with `:phase` or of its
 *  list with `:phase:<n>`. */
export interface WorkflowTreePhase extends WorkflowTreeNodeFields {
  readonly kind: "phase"
  readonly form: "single" | "parallel" | "list"
  /** The phase id that the workflow file declares. */
  readonly phaseId: string
  /** The round of a phase that a round of a repeat holds. */
  readonly round?: WorkflowTreeRound
  /** The list of a `list` phase: its control node, and whether it read its
   *  items. A list that has not read them holds no agents yet. */
  readonly list?: { readonly id: string; readonly expanded: boolean }
  /** The join, on the last phase of a stream once its list read its items,
   *  and on a phase of named agents that declares one. */
  readonly join?: WorkflowTreeJoin
}

/** One agent of a phase: one try at its brief, with its retries. */
export interface WorkflowTreeAgent extends WorkflowTreeNodeFields {
  readonly kind: "agent"
  /** The agent record that the agent runs. */
  readonly definitionId: string
  /** How many attempts the agent holds. A planned agent holds none. */
  readonly attempts: number
  /** The attempt that runs now, or else the latest attempt. It is the id of
   *  the agent's row in `FrontendWorkflowView.attempts`. */
  readonly currentAttemptId?: string
  readonly evidence?: WorkflowTreeEvidence
  /** The item of an agent of a list phase. */
  readonly item?: WorkflowTreeItem
  /** The control node that runs the agent, when it differs from `id`: an
   *  agent of a `then` chain, `while`, or `for` of control from before
   *  phases, whose control node runs several agents. Remove after
   *  2027-04-30. */
  readonly nodeId?: string
  /** The agents of the same parallel phase that must complete before this
   *  one runs: only control from before phases orders them. Remove after
   *  2027-04-30. */
  readonly waitsOn?: readonly string[]
}

/** A repeat, which holds the phases of each of its rounds. */
interface WorkflowTreeRepeat extends WorkflowTreeNodeFields {
  readonly kind: "repeat"
  readonly loop: WorkflowTreeLoop
}

/** One operational node in preorder. */
export type WorkflowTreeNode = WorkflowTreePhase | WorkflowTreeAgent | WorkflowTreeRepeat

/** The sole operational hierarchy of every loaded workflow. */
export interface WorkflowTree {
  readonly nodes: readonly WorkflowTreeNode[]
  /** The one agent that runs now, or that an interrupt or a Stop parked:
   *  the agent that Interrupt and Resume act on. Absent when no agent is
   *  current. */
  readonly currentAgentNodeId?: string
}

export interface LoadedWorkflowView {
  readonly attempts: readonly FrontendAttempt[]
  readonly attemptsStatus: "loaded"
  readonly state?: FrontendWorkflowState
  readonly tree: WorkflowTree
  /** Present when the run holds the follow-up conversation that a build
   *  before 2026-10 opened after it completed, which the full-size card
   *  opens read-only. */
  readonly followUp?: true
  readonly followUpSessionId?: string
  /** The run's name: the title that its launch gave it, or the name that
   *  its workflow's file gives it when the launch gave none. The full-size
   *  card and the agent view show it, and the inline card's block carries
   *  the same name as its label. Absent for a run whose recorded definition
   *  this build cannot read. */
  readonly name?: string
}

/** Unreadable history has no operational hierarchy or attempt rows. Clients
 *  narrow this discriminator before rendering a workflow. */
export type FrontendWorkflowView = LoadedWorkflowView | {
  readonly attempts: readonly []
  readonly attemptsStatus: "unavailable"
}

/** What one agent of a workflow does now, beyond what its attempt row
 *  holds: how many tools and subagents it has run, its newest call, when an
 *  interrupt cut it, the time its session worked, and its live tail, the
 *  pending messages and system lines that its durable conversation does not
 *  hold yet. `revision` moves each time the agent's conversation settles a
 *  block, so a client that shows the agent's transcript reads it again. The
 *  runtime holds one for each attempt that started, in any kind of phase. */
export interface WorkflowAgentLive {
  readonly attemptId: string
  readonly sessionId: string
  /** The operations that the agent counts live: present while it runs, while
   *  an interrupt holds it, or while the runtime holds its runner. A settled
   *  agent's attempt outcome counts them otherwise. */
  readonly operations?: number
  /** The agent's newest call, its detail cut to what a line can show. */
  readonly activity?: ToolPresentation
  /** The session owner's current activity, including before the first call. */
  readonly runtimeActivity?: FrontendActivity
  readonly interruptedAt?: number
  /** The active time of the agent's session before its open episode, as the
   *  session's own clock counts it: an interrupt or a wait adds none. */
  readonly duration: number
  /** When the session's open episode started, only while it works. */
  readonly activeStartedAt?: number
  readonly tail?: readonly (UserMessageBlock | SystemBlock)[]
  readonly revision: number
}

/** The live state of every agent of one workflow that started. */
export interface WorkflowLiveView {
  readonly agents: readonly WorkflowAgentLive[]
}


