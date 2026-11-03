import { Schema } from "effect"
import { RoleAssignmentSnapshotSchema } from "../../infra/role-settings.js"
import { ToolPresentationSchema } from "../../infra/output-blocks.js"
import { RuntimeAuthViewSchema } from "../auth-status-protocol-schemas.js"
import { ActivitySchema } from "../session-catalog-protocol-schemas.js"
import { defineProtocolDomain, defineProtocolModule, defineProtocolMutation } from "../protocol-module.js"
import type { FrontendWorkflowView, WorkflowLiveView, WorkflowTree } from "../workflow-view-protocol-types.js"
import type { RuntimeWorkflowCursorIdentity } from "../runtime-ui-protocol-types.js"

export function workflowViewCursor(workflowId: string): RuntimeWorkflowCursorIdentity & { readonly domain: "workflow_view" } {
  return { scope: "workflow", domain: "workflow_view", workflowId }
}
export function workflowLiveCursor(workflowId: string): RuntimeWorkflowCursorIdentity & { readonly domain: "workflow_live" } {
  return { scope: "workflow", domain: "workflow_live", workflowId }
}

const Id = Schema.NonEmptyString
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const state = Schema.Literals(["idle", "running", "completed", "failed", "paused"])
const node = {
  id: Schema.String, label: Schema.String, parentId: Schema.NullOr(Schema.String),
  disposition: Schema.Literals(["pending", "conditional", "running", "completed", "failed", "skipped"]),
  reason: Schema.optionalKey(Schema.String),
}
const WorkflowTreeSchema: Schema.Codec<WorkflowTree> = Schema.Struct({
  nodes: Schema.Array(Schema.Union([
    Schema.Struct({
      ...node, kind: Schema.Literal("phase"), form: Schema.Literals(["single", "parallel", "list"]), phaseId: Schema.String,
      round: Schema.optionalKey(Schema.Struct({ number: Count, outcome: Schema.optionalKey(Schema.Literals(["next", "dry", "bound"])) })),
      list: Schema.optionalKey(Schema.Struct({ id: Schema.String, expanded: Schema.Boolean })),
      join: Schema.optionalKey(Schema.Struct({
        reducer: Schema.String, state: Schema.Literals(["pending", "settled"]),
        slots: Count, completed: Count, failed: Count, pending: Count, missing: Count,
        coverage: Schema.optionalKey(Schema.Struct({
          status: Schema.Literals(["full", "partial", "empty"]),
          required: Schema.Struct({ surveyed: Count, total: Count }), unsurveyed: Schema.Array(Schema.String),
        })),
        selection: Schema.optionalKey(Schema.Struct({ verb: Schema.Literals(["kept", "passed"]), kept: Count, dropped: Count })),
      })),
    }),
    Schema.Struct({
      ...node, kind: Schema.Literal("agent"), definitionId: Schema.String, attempts: Count,
      currentAttemptId: Schema.optionalKey(Schema.String),
      evidence: Schema.optionalKey(Schema.Struct({ summary: Schema.optionalKey(Schema.String) })),
      item: Schema.optionalKey(Schema.Struct({ nodeId: Schema.String, key: Schema.String, label: Schema.String, ordinal: Count, text: Schema.String })),
      nodeId: Schema.optionalKey(Schema.String), waitsOn: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
    Schema.Struct({
      ...node, kind: Schema.Literal("repeat"),
      loop: Schema.Struct({ iteration: Count, maxIterations: Count, outcome: Schema.optionalKey(Schema.Literals(["dry", "bound", "stuck"])) }),
    }),
  ])),
  currentAgentNodeId: Schema.optionalKey(Schema.String),
})
const FrontendAttemptSchema = Schema.Struct({
  id: Schema.String, definitionId: Schema.String, briefId: Schema.String, name: Schema.String,
  agentNodeId: Schema.optionalKey(Id),
  persona: Schema.optionalKey(Schema.Struct({ id: Schema.String, roles: Schema.Array(Schema.String) })),
  status: Schema.Literals(["pending", "running", "completed", "blocked", "failed", "skipped"]),
  startedAt: Schema.optionalKey(Schema.Number), completedAt: Schema.optionalKey(Schema.Number), toolUses: Schema.optionalKey(Count),
  sessionId: Schema.optionalKey(Id),
  conversationId: Schema.optionalKey(Id),
  history: Schema.Array(Schema.Struct({ sessionId: Id, conversationId: Id })),
})
const WorkflowViewSchema: Schema.Codec<FrontendWorkflowView> = Schema.Union([
  Schema.Struct({
    attempts: Schema.Array(FrontendAttemptSchema), attemptsStatus: Schema.Literal("loaded"),
    state: Schema.optionalKey(state), tree: WorkflowTreeSchema, followUp: Schema.optionalKey(Schema.Literal(true)),
    followUpSessionId: Schema.optionalKey(Id), name: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ attempts: Schema.Tuple([]), attemptsStatus: Schema.Literal("unavailable") }),
])
const WorkflowAgentLiveSchema = Schema.Struct({
  attemptId: Id, sessionId: Id, operations: Schema.optionalKey(Count), activity: Schema.optionalKey(ToolPresentationSchema), runtimeActivity: Schema.optionalKey(ActivitySchema),
  interruptedAt: Schema.optionalKey(Schema.Number), duration: Count, activeStartedAt: Schema.optionalKey(Schema.Number), revision: Count,
})
const WorkflowLiveViewSchema: Schema.Codec<WorkflowLiveView> = Schema.Struct({ agents: Schema.Array(WorkflowAgentLiveSchema) })

/** One change of a workflow's live view. Each agent replaces the agent of
 *  its session. `order`, present when the set or the order of the agents
 *  changed, names the session of every agent that the view holds now, in
 *  order. A change carries only the agents that moved, so a change of one
 *  agent costs the same whatever the number of agents. */
export interface WorkflowLiveChange {
  readonly agents: WorkflowLiveView["agents"]
  readonly order?: readonly string[]
}

/** The live view after `change`, from the view a client holds, or from no
 *  agents before the run had a view. */
export function foldWorkflowLiveChange(current: WorkflowLiveView | null | undefined, change: WorkflowLiveChange): WorkflowLiveView {
  const agents = new Map((current?.agents ?? []).map((agent) => [agent.sessionId, agent]))
  for (const agent of change.agents) agents.set(agent.sessionId, agent)
  const order = change.order ?? (current?.agents ?? []).map(({ sessionId }) => sessionId)
  return { agents: order.flatMap((sessionId) => agents.get(sessionId) ?? []) }
}
const usage = Schema.Struct({
  totalCost: Schema.Number, totalBilledCost: Schema.Number, priceUnavailable: Schema.Boolean,
  totalInputTokens: Schema.Number, totalOutputTokens: Schema.Number,
})
const change = Schema.Struct({
  component: Schema.Literals(["workflow", "graph", "agent", "version", "skill", "persona"]),
  id: Schema.optionalKey(Schema.String), aspect: Schema.optionalKey(Schema.Literals(["policy", "content", "output"])),
})
const WorkflowDetailSchema = Schema.Struct({
  workflowId: Id,
  title: Schema.String, shortTitle: Schema.optionalKey(Schema.String),
  workflowDefinitionId: Id, createdAt: Schema.String, lastUpdated: Schema.String,
  executionCwd: Schema.String, roleAssignments: RoleAssignmentSnapshotSchema,
  launchedFrom: Schema.Struct({ parentSessionId: Id, conversationId: Id, toolUseId: Id, workflowDefinitionId: Schema.optionalKey(Id), description: Schema.optionalKey(Schema.String) }),
  stoppedBy: Schema.optionalKey(Schema.Literals(["person", "agent"])),
  authProfileId: Schema.optionalKey(Id),
  auth: Schema.NullOr(RuntimeAuthViewSchema),
  workflowState: Schema.optionalKey(state),
  /** Present while a planned replacement's successor owes the run its
   *  continuation: committed control can read paused, and the run still
   *  goes on (ARCH-SESSIONS-039). */
  continuationOwed: Schema.optionalKey(Schema.Literal(true)),
  readability: Schema.Literals(["readable", "unavailable"]),
  definitionDrift: Schema.optionalKey(Schema.Struct({ workflowDefinitionId: Id, changes: Schema.Array(change) })),
  admittedActions: Schema.Array(Schema.Literals(["workflow.send", "workflow.interrupt", "workflow.resume", "workflow.restart", "workflow.stop", "workflow.delete"])),
  totals: usage, policyUsage: usage,
  attribution: Schema.Literals(["available", "partial"]),
  durationMs: Count,
  streamingStartedAt: Schema.NullOr(Schema.Number),
  activeIntervals: Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number })),
  totalsLoading: Schema.Boolean,
})
export type WorkflowDetail = typeof WorkflowDetailSchema.Type
const WorkflowDetailPatchSchema = Schema.Struct({ kind: Schema.Literal("workflow_detail.changed"), view: Schema.NullOr(WorkflowDetailSchema) })
const WorkflowViewPatchPayloadSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("workflow_view.updated"), workflowView: WorkflowViewSchema }),
  Schema.Struct({ kind: Schema.Literal("workflow_view.removed") }),
])
const WorkflowLivePatchPayloadSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("workflow_live.changed"), agents: Schema.Array(WorkflowAgentLiveSchema), order: Schema.optionalKey(Schema.Array(Id)) }),
  Schema.Struct({ kind: Schema.Literal("workflow_live.removed") }),
])
const BasicResult = Schema.Union([Schema.Struct({ ok: Schema.Literal(true) }), Schema.Struct({ ok: Schema.Literal(false), error: Schema.String })])
const addressed = { workflowId: Id, targets: Schema.optionalKey(Schema.Array(Id)) }

/** Workflow cursors never activate a session or execute an agent. */
export const workflowsProtocol = defineProtocolModule({
  id: "workflows",
  domains: [
    defineProtocolDomain({
      domain: "workflow_detail", scope: "workflow", delivery: "durable-resnapshot", content: "whole-value",
      snapshot: {
        query: "workflowDetail", deadline: "control",
        result: Schema.Struct({ snapshotPosition: Schema.Number, view: Schema.NullOr(WorkflowDetailSchema) }),
        background: Schema.Struct({ view: Schema.NullOr(WorkflowDetailSchema) }),
      },
      patch: WorkflowDetailPatchSchema,
      view: { snapshot: (result) => result.view, patch: (payload) => payload.view },
    }),
    defineProtocolDomain({
      domain: "workflow_view", scope: "workflow", delivery: "durable-resnapshot", content: "whole-value",
      snapshot: {
        query: "workflowViewSnapshot", deadline: "output",
        result: Schema.Struct({ snapshotPosition: Schema.Number, view: Schema.NullOr(WorkflowViewSchema) }),
        background: Schema.Struct({ view: Schema.NullOr(WorkflowViewSchema) }),
      },
      patch: WorkflowViewPatchPayloadSchema,
      view: { snapshot: (result) => result.view, patch: (payload) => payload.kind === "workflow_view.updated" ? payload.workflowView : null },
    }),
    defineProtocolDomain({
      // A patch carries the agents that moved, so a client that missed one
      // reads the whole view again rather than trusting a later change.
      domain: "workflow_live", scope: "workflow", delivery: "durable-resnapshot", content: "change",
      snapshot: {
        query: "workflowLiveSnapshot", deadline: "control",
        result: Schema.Struct({ snapshotPosition: Schema.Number, view: Schema.NullOr(WorkflowLiveViewSchema) }),
        background: Schema.Struct({ view: Schema.NullOr(WorkflowLiveViewSchema) }),
      },
      patch: WorkflowLivePatchPayloadSchema,
      view: { snapshot: (result) => result.view, patch: (payload, current) => payload.kind === "workflow_live.changed" ? foldWorkflowLiveChange(current, payload) : null },
    }),
  ],
  mutations: [
    defineProtocolMutation({ type: "workflow.send", fields: { ...addressed, input: Schema.String }, result: BasicResult, policy: "lossless" }),
    defineProtocolMutation({ type: "workflow.interrupt", fields: addressed, result: Schema.Struct({ kind: Schema.Literal("interrupt"), interrupted: Schema.Boolean, reason: Schema.optionalKey(Schema.String) }), policy: "lossless", refuse: (reason) => ({ kind: "interrupt" as const, interrupted: false, reason }) }),
    defineProtocolMutation({ type: "workflow.resume", fields: addressed, result: BasicResult, policy: "lossless" }),
    defineProtocolMutation({ type: "workflow.restart", fields: { workflowId: Id }, result: BasicResult, policy: "lossless" }),
    defineProtocolMutation({ type: "workflow.stop", fields: { workflowId: Id }, result: BasicResult, policy: "lossless" }),
    defineProtocolMutation({ type: "workflow.delete", fields: { workflowId: Id }, result: BasicResult, policy: "lossless" }),
    defineProtocolMutation({ type: "workflow.profile.select", fields: { workflowId: Id, profileId: Id }, result: BasicResult, policy: "lossless" }),
  ],
})
