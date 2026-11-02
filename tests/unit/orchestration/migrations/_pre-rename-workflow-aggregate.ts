/** The pre-rename workflow aggregate this suite migrates: control staged after
 *  the unified skill catalog and before the implementation-first rename, so its
 *  recorded identity is a binding-and-skill identity whose every id is a name the
 *  rename retired.
 *
 *  The fixture states the retired ids itself instead of inverting the migration's
 *  table, so a wrong table in the pass shows up as a failing test rather than as
 *  two mistakes that cancel. Display names, node ids, and attempt ids are what
 *  the pre-rename build minted: a workflow id renamed the minted prefix with it,
 *  and the pass leaves those ids exactly as recorded. */

import { Schema } from "effect"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { isRecord } from "../../../../src/infra/record.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js"
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js"
import { DefinitionIdentitySchema, type LegacyDefinitionIdentity } from "../../../../src/workflows/vm/definition-identity.js"
import { WorkflowControlV10Schema } from "../../../../src/workflows/vm/historical-codecs.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { normalizeWorkflowControlV10 } from "../../../../src/workflows/vm/historical-normalization.js"
import { workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { prePhaseHistory, type PrePhaseControl } from "./_pre-phase-control.js"
import {
  boundSkills,
  compiledControl,
  legacyIdentity,
  processRoot,
  withAuthoredFollowUp,
  withSettledFirstAttempt,
  type SeededFact,
} from "./_legacy-workflow-aggregate.js"

export const RETIRED_WORKFLOW_ID = "flywheel-core"
export const RETIRED_BINDING_IDS = ["plan-create", "plan-review", "implement"] as const
export const RETIRED_SKILL_IDS = ["flywheel.plan-create", "flywheel.plan-review", "flywheel.implement"] as const

const RETIRED_WORKFLOW_IDS: ReadonlyMap<string, string> = new Map([
  ["implement", RETIRED_WORKFLOW_ID],
  ["implement-and-review", "flywheel-full"],
])

const RETIRED_BINDING_ID_BY_CURRENT: ReadonlyMap<string, string> = new Map([
  ["spec-create", "plan-create"],
  ["spec-review", "plan-review"],
])

const RETIRED_SKILL_ID_BY_CURRENT: ReadonlyMap<string, string> = new Map([
  ["fly.spec-create", "flywheel.plan-create"],
  ["fly.spec-review", "flywheel.plan-review"],
  ["gsd.spec-create", "get-stuff-done.plan-create"],
  ["gsd.spec-review", "get-stuff-done.plan-review"],
  ["fly.implementation-spec", "planning"],
])

const RETIRED_SKILL_FAMILIES: readonly (readonly [string, string])[] = [
  ["fly.", "flywheel."],
  ["gsd.", "get-stuff-done."],
  ["ce.", "compound-eng."],
]

const RETIRED_HANDOFF_TYPES: ReadonlyMap<string, string> = new Map([
  ["spec-handoff", "plan-handoff"],
])

/** Members whose string value is a definition id, by the name the recorded shape
 *  gives them. A handoff type is not here: the identity names it `name`, which a
 *  graph node uses for its display name, so the identity is retired member by
 *  member below. */
const RETIRED_BY_MEMBER: ReadonlyMap<string, (recorded: string) => string> = new Map([
  ["workflowDefinitionId", retiredWorkflowId],
  ["definitionId", retiredBindingId],
  ["correctiveDefinitionId", retiredBindingId],
  ["bindingId", retiredBindingId],
  ["step", retiredBindingId],
  ["skillId", retiredSkillId],
  // A queue step names its seat by `contentId` once the step-row-content-id
  // pass, which runs before the identity chain, has rewritten it.
  ["contentId", retiredSkillId],
  // The flattened view names the seat `briefId` before the companions write
  // it as the `contentId` of a version 9 row.
  ["briefId", retiredSkillId],
])

function retiredWorkflowId(current: string): string {
  return RETIRED_WORKFLOW_IDS.get(current) ?? current
}

function retiredBindingId(current: string): string {
  return RETIRED_BINDING_ID_BY_CURRENT.get(current) ?? current
}

function retiredSkillId(current: string): string {
  const renamed = RETIRED_SKILL_ID_BY_CURRENT.get(current)
  if (renamed !== undefined) return renamed
  const family = RETIRED_SKILL_FAMILIES.find(([currentPrefix]) => current.startsWith(currentPrefix))
  return family ? `${family[1]}${current.slice(family[0].length)}` : current
}

function retiredHandoffType(current: string): string {
  return RETIRED_HANDOFF_TYPES.get(current) ?? current
}

/** A node, attempt, or proposal id the compiler minted from the workflow id. */
function retiredMintedId(current: string): string {
  for (const [currentId, retiredId] of RETIRED_WORKFLOW_IDS) {
    if (current.startsWith(`${currentId}:`)) return `${retiredId}${current.slice(currentId.length)}`
  }
  return current
}

/** One recorded value as the JSON a store holds, with every id under the name
 *  the rename retired. Only string values change: a member the table above
 *  names takes its own retired id, and any other string takes the retired
 *  minted prefix. A reader decodes the text with the schema of the shape it
 *  passed in. */
function retiredJson(value: PrePhaseControl | LegacyDefinitionIdentity | EventPayload): string {
  return JSON.stringify(value, (member, entry) => typeof entry === "string" ? (RETIRED_BY_MEMBER.get(member) ?? retiredMintedId)(entry) : entry)
}

function retiredPayload(payload: EventPayload): EventPayload {
  const parsed: unknown = JSON.parse(retiredJson(payload))
  if (!isRecord(parsed)) throw new Error("A retired payload is not an object")
  return parsed
}

const decodeIdentity = Schema.decodeUnknownSync(DefinitionIdentitySchema)
const decodeControl = Schema.decodeUnknownSync(WorkflowControlV10Schema)

function retiredIdentity(identity: LegacyDefinitionIdentity): LegacyDefinitionIdentity {
  return {
    ...legacyIdentity(decodeIdentity(JSON.parse(retiredJson(identity)))),
    handoffRegistry: identity.handoffRegistry.map((entry) => ({ ...entry, name: retiredHandoffType(entry.name) })),
  }
}



export interface PreRenameSeedOptions {
  /** Workflow whose current definitions the fixture retires. */
  readonly workflowId?: string
  readonly status?: "ready" | "paused"
  /** Record the queue and context companions of a run under the retired ids. */
  readonly companions?: boolean
  /** Author an unconditional follow-up on the first position, which is the
   *  continuation a blocked attempt routes to. */
  readonly authoredFollowUp?: boolean
  /** Record the commits a run made after its launch, under the retired ids:
   *  the frozen `rename` history, which needs `authoredFollowUp` and
   *  `companions` and no other change to the control. */
  readonly controlHistory?: boolean
  /** Settle the first attempt and move the frontier on. */
  readonly settledFirstAttempt?: boolean
  /** Omit the context identity members, as a pre-context-migration store does. */
  readonly omitContextMembers?: boolean
  /** Omit the handoff contract revision, as every identity before that member existed did. */
  readonly omitHandoffContractRevision?: boolean
  /** Record a durable session whose workflow id the resume path resolves. */
  readonly sessionMetadata?: boolean
  /** Change the recorded identity after it is retired, to stage drift the rename
   *  table cannot explain. */
  readonly rewriteIdentity?: (identity: LegacyDefinitionIdentity) => LegacyDefinitionIdentity
}

/** Workflow control as a post-catalog, pre-rename build staged it: the run's
 *  queue and context companions, then initialized control whose identity,
 *  graph, and attempts name the retired ids. A driven control history commits on
 *  top of that batch, and the control that the history commits is returned
 *  in the current shape, so a test can compare the frontier a resume folds
 *  against the frontier the run staged. */
export function seedPreRenameAggregate(
  dbFile: string,
  sessionId: string,
  options: PreRenameSeedOptions = {},
): CommittedWorkflowControl | null {
  const workflowId = options.workflowId ?? "implement"
  const bindings = boundSkills(processRoot, workflowId)
  const compiled = compiledControl(processRoot, workflowId)
  const withFollowUp = options.authoredFollowUp ? withAuthoredFollowUp(compiled) : compiled
  const staged = options.settledFirstAttempt ? withSettledFirstAttempt(withFollowUp) : withFollowUp
  const retiredStaged = retiredIdentity(legacyIdentity(staged.definitionIdentity))
  const control: PrePhaseControl = { ...decodeControl(JSON.parse(retiredJson(staged))), definitionIdentity: retiredStaged }
  const identity = options.rewriteIdentity?.(retiredStaged) ?? retiredStaged
  const handoffRegistry = options.omitHandoffContractRevision
    ? identity.handoffRegistry.map(({ contractRevision: _contractRevision, ...entry }) => entry)
    : identity.handoffRegistry
  const persistedIdentity = { ...identity, handoffRegistry }
  const { skills, personas, ...withoutContextMembers } = persistedIdentity
  const recordedIdentity = options.omitContextMembers ? withoutContextMembers : persistedIdentity
  const companions = options.companions ? companionFacts(flattenWorkflowView(normalizeWorkflowControlV10(staged), bindings), workflowId) : []
  const aggregateSeq = companions.length + 1
  const status = options.status ?? control.status
  // The frozen history was driven from the control the row records, under its
  // retired ids and sequence.
  if (options.controlHistory && !(options.authoredFollowUp && options.companions && !options.settledFirstAttempt && workflowId === "implement" && status === "ready")) {
    throw new Error("The frozen rename history holds the ready implement control with companions and an authored follow-up only")
  }
  const history = options.controlHistory ? prePhaseHistory("rename", identity) : null
  const store = createSqliteEventStore(dbFile)
  try {
    for (const fact of companions) {
      store.append({
        aggregateId: workflowAggregateId(sessionId),
        type: fact.type,
        version: fact.version,
        timestamp: 1,
        actor: "flywheel",
        sessionId,
        payload: fact.payload,
      })
    }
    store.append({
      aggregateId: workflowAggregateId(sessionId),
      type: "workflow.control.initialized",
      version: 2,
      timestamp: 1,
      actor: "flywheel",
      sessionId,
      payload: { control: { ...control, issues: [], seals: [], definitionIdentity: recordedIdentity, status, aggregateSeq } },
    })
    for (const fact of history?.facts ?? []) {
      store.append({
        aggregateId: workflowAggregateId(sessionId),
        type: fact.type,
        version: fact.version,
        timestamp: 1,
        actor: "flywheel",
        sessionId,
        payload: fact.payload,
      })
    }
    if (options.sessionMetadata) {
      store.append({
        aggregateId: `session:${sessionId}`,
        type: "session.created",
        version: 3,
        timestamp: 1,
        actor: "flywheel",
        sessionId,
        payload: {
          kind: "workflow",
          command: "workflow",
          workflowDefinitionId: retiredWorkflowId(workflowId),
          label: "Implement the staged spec",
          lastUpdated: new Date(1).toISOString(),
          executionCwd: FIXTURE_EXECUTION_CWD,
          lifecycleState: "inactive",
        },
      })
    }
  } finally {
    store.close()
  }
  return history === null ? null : normalizeWorkflowControlV10(history.final)
}

/** The queue and context companions of one run under the retired ids, from
 *  the queue its control flattens to. The last step arrives through a mutation,
 *  so `insertedSteps` is covered too. */
function companionFacts(
  view: ReturnType<typeof flattenWorkflowView>,
  workflowId: string,
): SeededFact[] {
  const { tree: _tree, attempts, maxAttempts: _maxAttempts, ...queue } = view
  // Version 9 rows named an attempt's brief `contentId` and its item `forItem`.
  const steps = attempts.map(({ briefId, item, ...row }, index) => ({
    ...row, contentId: briefId, ...(item === undefined ? {} : { forItem: item }), status: index === 0 ? "completed" : "pending",
  }))
  const first = steps[0]
  const last = steps.at(-1)
  if (!first || !last || steps.length < 2) throw new Error("Test fixture needs at least two queue steps")
  const facts: SeededFact[] = [
    {
      type: "context.input.seeded",
      version: 1,
      payload: { workflowDefinitionId: workflowId, userRequest: "Implement the staged spec." },
    },
    {
      type: "queue.created",
      version: 9,
      payload: { queue: { ...queue, steps: steps.slice(0, -1), cursor: 1, status: "paused", mutationLog: [] } },
    },
    {
      type: "queue.mutated",
      version: 9,
      payload: {
        mutation: {
          timestamp: 1,
          action: "insert",
          actor: "authored",
          reason: "Workflow control inserted authored attempts",
          stepIds: [last.id],
        },
        insertedSteps: [last],
        insertIndex: steps.length - 1,
      },
    },
    {
      type: "context.accumulated",
      version: 4,
      payload: {
        entry: {
          stepId: first.id,
          stepName: first.name,
          definitionId: first.definitionId,
          workflowDefinitionId: first.workflowDefinitionId,
          recipientStepId: null,
          writes: [{ id: "plan", lifetime: "durable", supersedes: [] }],
          timestamp: 1,
          handoff: { summary: "Spec written" },
        },
      },
    },
  ]
  return facts.map((fact) => ({ ...fact, payload: retiredPayload(fact.payload) }))
}
