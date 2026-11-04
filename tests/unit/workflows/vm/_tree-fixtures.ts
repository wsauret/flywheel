import { Schema } from "effect"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { completeAttempt, failAttempt, prepareExecution, admissibleExecutionInput, startExecution } from "../../../../src/workflows/vm/attempt-transitions.js"
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js"
import { initializeWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import type { ResolvedAgent } from "../../../../src/workflows/agent-resolution.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { frontendAttempts } from "../../../../src/orchestration/workflow-host/frontend-attempts.js"
import type { LoadedWorkflowView, WorkflowTree } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { parseProjectionFact } from "../../../../src/infra/event-projection.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { createMemoryStore, initialFacts, testHost } from "./host-test-support.js"
import { attemptOf, DRY_FILES, dryAnswer, dryWorkflow, FINDINGS_FILES, findingsAnswer, findingsWorkflow, inputMapWorkflow, itemList, items, mapSkills, mapWorkflow, stage, surveyAnswer, surveyWorkflow, type SurveyTarget } from "./_map-fixtures.js"

/** The input-mapped workflow with room for 100 items, so a launch can fan
 *  out to about 85 branches. */
export const wideMapWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  ...Schema.encodeSync(WorkflowDefinitionSchema)(inputMapWorkflow),
  input: { fields: { items: itemList(100), goal: { type: "string", description: "What the run must reach." } } },
})

const LAUNCH_LIMITS = { maxAttempts: 400, maxMutationsPerAttempt: 3, maxInserts: 20 }

const record = (id: string) => ({ brief: `Do the ${id} work.`, name: id.charAt(0).toUpperCase() + id.slice(1), output: { summary: "Result" }, writes: [] })

/** Two agents and a tail. With `concurrent`, the two agents are the named
 *  agents of one phase, so they run at the same time; otherwise each is a
 *  phase of its own, and the second waits on the first. */
export function phaseWorkflow(concurrent: boolean) {
  return Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: concurrent ? "side-by-side" : "in-turn",
    name: concurrent ? "Side by side" : "In turn",
    phases: [
      ...(concurrent
        ? [{ phase: "build", agents: [{ agent: "implement", ...record("implement") }, { agent: "review", ...record("review") }] }]
        : [{ phase: "implement", ...record("implement") }, { phase: "review", ...record("review") }]),
      { phase: "tail", ...record("tail") },
    ],
  })
}

/** The phase workflow at launch, and the bindings its view reads. */
export function phaseControl(concurrent: boolean): CommittedWorkflowControl {
  const workflow = phaseWorkflow(concurrent)
  return compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: mapSkills })
}

export const phaseBindings = (concurrent: boolean) => resolveWorkflowAgents(phaseWorkflow(concurrent))

export const mapBindings = resolveWorkflowAgents(mapWorkflow)
export const wideBindings = resolveWorkflowAgents(wideMapWorkflow)

/** Long item titles, so a client must keep each branch name in its width. */
export const targets = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `t${index + 1}`, title: `Target ${index + 1} of the survey with a deliberately long descriptive title` }))

/** A launch that expands the wide map over `count` items. */
export function wideControl(count: number): CommittedWorkflowControl {
  return compileWorkflowControl(wideMapWorkflow, wideBindings, { skills: mapSkills }, LAUNCH_LIMITS, { items: targets(count), goal: "Survey every target." })
}

/** Four lanes of two steps over the wide map: lane t1 finished both steps,
 *  lane t2 runs its first, and lanes t3 and t4 have not started. */
export function fourLaneControl(): CommittedWorkflowControl {
  const group = "input-mapped:node:1"
  const finished = [`${group}:item:1:phase:1:attempt:1`, `${group}:item:1:phase:2:attempt:1`]
  const control = drive(wideControl(4), () => ({ handoff: { summary: "done" } }), (current) => finished.every((id) => current.attempts.find((attempt) => attempt.id === id)?.state._tag === "completed"))
  return startNext(control)
}

/** The phase-and-map workflow at launch, before its map expands. */
export function mapControl(): CommittedWorkflowControl {
  return compileWorkflowControl(mapWorkflow, mapBindings, { skills: mapSkills })
}

type Outcome = { readonly handoff: { readonly [key: string]: unknown } } | { readonly fail: string }

/** Run ready attempts in order until `until` holds or nothing is ready.
 *  `outcome` answers each attempt by its id. */
export function drive(control: CommittedWorkflowControl, outcome: (attemptId: string) => Outcome, until: (control: CommittedWorkflowControl) => boolean = () => false): CommittedWorkflowControl {
  let current = control
  while (!until(current)) {
    const prepared = prepareExecution(current).control
    const next = admissibleExecutionInput(prepared)
    if (next === null) return prepared
    current = startExecution(prepared, next.attemptId, `conversation-${next.attemptId}`).control
    const answer = outcome(next.attemptId)
    current = "fail" in answer
      ? failAttempt(current, { type: "ATTEMPT_FAILED", failure: { attemptId: next.attemptId, kind: "invalid_handoff", reason: answer.fail, conversationId: `conversation-${next.attemptId}`, content: {}, issues: [{ path: "summary", message: answer.fail }] } }).committed
      : completeAttempt(current, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: next.attemptId, conversationId: `conversation-${next.attemptId}`, handoff: answer.handoff, reassessment: null } }).committed
  }
  return current
}

/** The plan lists `list`; every stage succeeds except those `failing` names. */
export function mapOutcome(list: readonly unknown[], failing: ReadonlySet<string> = new Set()) {
  return (attemptId: string): Outcome => {
    if (failing.has(attemptId)) return { fail: "summary is required" }
    return attemptId.startsWith("mapped:node:1:") ? { handoff: { summary: "## Plan\n\n**The plan.**", items: list } } : { handoff: { summary: "done" } }
  }
}

/** Three items of the phase-and-map workflow, where item b's first step
 *  failed and item c has not started. */
export function failedBranch(): LoadedWorkflowView {
  const failing = new Set([attemptOf(stage(2, 1))])
  return frontendView(drive(mapControl(), mapOutcome(items("a", "b", "c"), failing), (control) => control.attempts.some(({ state }) => state._tag === "failed")), mapBindings)
}

/** Start the next ready attempt and leave it running. */
export function startNext(control: CommittedWorkflowControl): CommittedWorkflowControl {
  const prepared = prepareExecution(control).control
  const next = admissibleExecutionInput(prepared)
  if (next === null) throw new Error("No attempt is ready")
  return startExecution(prepared, next.attemptId, `conversation-${next.attemptId}`).control
}

/** Interrupt the attempt that runs, as a person's Interrupt does. */
export function interrupt(control: CommittedWorkflowControl): CommittedWorkflowControl {
  const result = transitionWorkflow(initializeWorkflow(control).state, { type: "ABORT", reason: "Interrupted by the person" })
  const pending = result.state.context.pending?.proposedCommitted
  if (pending === undefined) throw new Error("The interrupt proposed no control")
  return pending
}

/** The view every client reads of `control`, as the workflow_view domain
 *  publishes it. */
/** The join of a list, which the last phase of its stream carries. */
export function listJoin(tree: WorkflowTree | undefined, listId: string) {
  return tree?.nodes.flatMap((node) => node.kind === "phase" && node.list?.id === listId && node.join !== undefined ? [node.join] : [])[0]
}

export function frontendView(control: CommittedWorkflowControl, bindings: ReadonlyMap<string, ResolvedAgent>): LoadedWorkflowView {
  const view = flattenWorkflowView(control, bindings)
  const status = control.status
  const state = status === "completed" || status === "failed" || status === "paused" ? status : status === "executing" ? "running" : "idle"
  return { attempts: frontendAttempts(view), attemptsStatus: "loaded", state, tree: view.tree }
}

export const surveyBindings = resolveWorkflowAgents(surveyWorkflow)

/** The survey workflow driven until nothing is ready: every target ran, and
 *  the coverage join folded before the synthesize step. */
export function surveyControl(survey: readonly SurveyTarget[], exclusions: readonly string[] = []): CommittedWorkflowControl {
  return drive(compileWorkflowControl(surveyWorkflow, surveyBindings, { skills: mapSkills }), surveyAnswer(survey, exclusions))
}

export const findingsBindings = resolveWorkflowAgents(findingsWorkflow)

/** The findings workflow driven until nothing is ready: the dedupe join kept
 *  two findings and dropped one, and the quorum join passed one area of two.
 *  `until` stops it earlier. */
export function findingsControl(until?: (control: CommittedWorkflowControl) => boolean): CommittedWorkflowControl {
  return drive(compileWorkflowControl(findingsWorkflow, findingsBindings, { skills: mapSkills }, LAUNCH_LIMITS, { files: FINDINGS_FILES }), findingsAnswer, until)
}

export const dryBindings = resolveWorkflowAgents(dryWorkflow(3))

const debugRecord = (id: string) => ({ brief: `Run ${id}.`, name: id.charAt(0).toUpperCase() + id.slice(1), output: { summary: "Result" }, writes: [] })

const debugWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "debug", name: "Debug",
  phases: [
    { phase: "investigate", ...debugRecord("investigate"), output: { summary: "Result", fields: { hypothesis: { type: "string", nullable: true, description: "The root cause, when one is confirmed." } } } },
    { phase: "fix", if: "investigate.hypothesis", ...debugRecord("fix") },
    { phase: "verify", if: "fix", ...debugRecord("verify") },
  ],
})
export const debugBindings = resolveWorkflowAgents(debugWorkflow)
export const debugControl = () => compileWorkflowControl(debugWorkflow, debugBindings, { skills: mapSkills })

const stepLoopWorkflow = (detectStuck: boolean) => Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "step-loop", name: "Review fixes",
  phases: [{
    repeat: { while: "investigate.findings", max: 5, stuck: detectStuck },
    phases: [
      { phase: "investigate", ...debugRecord("investigate"), output: { summary: "Result", fields: { findings: { type: "list", max: 3, description: "What remains to fix.", of: { type: "string" } } } } },
      { phase: "fix", ...debugRecord("fix") },
    ],
  }],
})
export const stepLoopBindings = resolveWorkflowAgents(stepLoopWorkflow(false))
export const stepLoopControl = (detectStuck = false) => compileWorkflowControl(stepLoopWorkflow(detectStuck), stepLoopBindings, { skills: mapSkills })

const eachWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "each", name: "Each",
  phases: [
    { phase: "source", ...debugRecord("source"), output: { summary: "The items.", fields: { items: { type: "list", description: "The items.", max: 3, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } } } } },
    { repeat: { each: "source.items" }, phases: [{ phase: "work", ...debugRecord("work") }] },
  ],
})
export const eachBindings = resolveWorkflowAgents(eachWorkflow)
/** A source phase, then a repeat that runs one round of `work` for each
 *  item that the source lists. */
export const eachControl = () => compileWorkflowControl(eachWorkflow, eachBindings, { skills: mapSkills })

/** A concurrent phase of two named agents, and a phase after it. */
const concurrentWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "concurrent", name: "Debug",
  phases: [
    { phase: "build", agents: [{ agent: "verify", ...debugRecord("verify") }, { agent: "investigate", ...debugRecord("investigate") }] },
    { phase: "fix", ...debugRecord("fix") },
  ],
})
export const concurrentBindings = resolveWorkflowAgents(concurrentWorkflow)
export const concurrentControl = () => compileWorkflowControl(concurrentWorkflow, concurrentBindings, { skills: mapSkills })

/** The loop-until-dry fixture driven until nothing is ready: three rounds,
 *  the last one dry. `until` stops it earlier. */
export function dryControl(until?: (control: CommittedWorkflowControl) => boolean): CommittedWorkflowControl {
  return drive(compileWorkflowControl(dryWorkflow(3), dryBindings, { skills: mapSkills }, LAUNCH_LIMITS, { files: DRY_FILES }), dryAnswer, until)
}

/** The facts of the survey fixture run to completion through the
 *  production host: the inventory lists `survey`, and the coverage join
 *  folds what each verify stage reports. No target may fail. */
export async function completedSurveyFacts(survey: readonly SurveyTarget[], conversationId?: () => string) {
  return completedFacts(surveyWorkflow, surveyAnswer(survey), conversationId)
}

/** The facts of a live step loop stopped at its bound or by stuck detection. */
export async function stoppedStepLoopFacts(detectStuck: boolean) {
  return completedFacts(stepLoopWorkflow(detectStuck), () => ({ handoff: { summary: "findings", findings: ["the same defect"] } }))
}

async function completedFacts(workflow: WorkflowDefinition, answer: (attemptId: string) => Outcome, conversationId?: () => string) {
  const source = createMemoryStore(initialFacts(workflow, mapSkills))
  await testHost(source, {
    workflow,
    skills: mapSkills,
    ...(conversationId ? { conversationId } : {}),
    attemptRunner: { run: async (attempt, active) => {
      const outcome = answer(attempt.attemptId)
      if ("fail" in outcome) throw new Error("a completed fixture attempt failed")
      return { kind: "success", attemptId: attempt.attemptId, conversationId: active.conversationId, handoff: outcome.handoff, reassessment: null }
    } },
  }).run()
  return source.events.map((event) => parseProjectionFact(event, parseWorkflowSessionFact))
}

export { items } from "./_map-fixtures.js"
