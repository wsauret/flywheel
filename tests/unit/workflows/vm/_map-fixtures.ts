import { Schema } from "effect"
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import type { SkillRegistryRevision } from "../../../../src/workflows/skill-schema.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import type { SqliteVmDriver } from "./_sqlite-vm-driver.js"

const text = (description: string) => ({ type: "string", description }) as const

/** One item field of a map source list: objects keyed by `id`, at most
 *  `max` of them. */
export function itemList(max: number) {
  return {
    type: "list",
    description: "The items to fan out over.",
    max,
    unique: "id",
    of: { type: "object", fields: { id: text("The item id."), title: text("The item title.") } },
  } as const
}

/** The records of the stream of the map fixtures: each item is implemented
 *  and then reviewed, and the review's join writes one durable artifact. */
const implementRecord = { brief: "Implement one item.", name: "Implement", output: { summary: "What changed." }, writes: [{ id: "change", lifetime: "transient" }] }
const reviewRecord = { brief: "Review one item.", name: "Review", output: { summary: "The review." }, writes: [{ id: "review", lifetime: "transient" }] }
const tailRecord = { brief: "Summarize the reviews.", name: "Tail", output: { summary: "The summary." }, writes: [] }
const reviewsJoin = { reducer: "collect", write: { id: "reviews", lifetime: "durable", supersedes: [] } }

/** A workflow whose plan phase lists items, a stream implements and then
 *  reviews each item, a `collect` join folds the items, and a tail phase
 *  reads the join. */
export const mapWorkflow: WorkflowDefinition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "mapped",
  name: "Mapped",
  phases: [
    { phase: "plan", brief: "List the items.", name: "Plan", output: { summary: "The plan.", fields: { items: itemList(3) } }, writes: [{ id: "plan", lifetime: "durable", supersedes: [] }] },
    { phase: "implement", over: "plan.items", label: "title", ...implementRecord },
    { phase: "review", over: "implement", ...reviewRecord, join: reviewsJoin },
    { phase: "tail", ...tailRecord },
  ],
})

/** A workflow that takes its items as launch input: a stream over
 *  `input.items` implements and reviews each item, a `collect` join folds
 *  them, and a tail phase reads the join. The launch expands the list. */
export const inputMapWorkflow: WorkflowDefinition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "input-mapped",
  name: "Input mapped",
  input: { fields: { items: itemList(3), goal: text("What the run must reach.") } },
  phases: [
    { phase: "implement", over: "input.items", label: "title", ...implementRecord },
    { phase: "review", over: "implement", ...reviewRecord, join: reviewsJoin },
    { phase: "tail", ...tailRecord },
  ],
})

/** The workflow with the author's `max_parallel`, which caps how many of
 *  its attempts run at once. */
export function withMaxParallel(workflow: WorkflowDefinition, maxParallel: number): WorkflowDefinition {
  return { ...workflow, guardrails: { ...workflow.guardrails, max_parallel: maxParallel } }
}

/** The workflow with the author's `max_parallel: 1`, so its attempts run
 *  one at a time in graph order, for a test that stands the run at one
 *  serial position. */
export function oneAtATime(workflow: WorkflowDefinition): WorkflowDefinition {
  return withMaxParallel(workflow, 1)
}

export const INPUT_GROUP = "input-mapped:node:1"
export const INPUT_TAIL = "input-mapped:node:3"
export const inputBranch = (ordinal: number) => `${INPUT_GROUP}:item:${ordinal}`
export const inputStage = (ordinal: number, position: number) => `${inputBranch(ordinal)}:phase:${position}`

export const mapSkills: SkillRegistryRevision = testSkillRevision(["plan", "implement", "review", "tail"].map((id) => testSkill(id)))

export const MAP_GROUP = "mapped:node:2"

export const items = (...ids: readonly string[]) => ids.map((id) => ({ id, title: `Item ${id}` }))

export const PLAN = "mapped:node:1"
export const TAIL = "mapped:node:4"
export const branch = (ordinal: number) => `${MAP_GROUP}:item:${ordinal}`
export const stage = (ordinal: number, position: number) => `${branch(ordinal)}:phase:${position}`
export const attemptOf = (nodeId: string) => `${nodeId}:attempt:1`

/** Initialize the run unless it is, then start and complete the plan step
 *  with `list` as its items. */
export async function completePlan(vm: SqliteVmDriver, list: readonly unknown[], initialized = false) {
  if (!initialized) await vm.initialize()
  await vm.startAttempt("after", "conversation-plan")
  return vm.completeAttempt("after", { summary: "The plan.", items: list })
}

/** Start the attempt the last result prepared and complete it. */
export async function runPrepared(vm: SqliteVmDriver, prepared: Awaited<ReturnType<SqliteVmDriver["drive"]>>, handoff: { [key: string]: unknown }) {
  if (prepared.command.kind !== "prepare_attempt") throw new Error(`Expected a prepared attempt, got ${prepared.command.kind}`)
  await vm.drive({ type: "ATTEMPT_STARTED", attemptId: prepared.command.attempt.attemptId, conversationId: `conversation-${prepared.command.attempt.attemptId}` })
  return vm.completeAttempt("after", handoff)
}

/** The output fields of the survey fixture's inventory step. */
export const surveyInventoryFields = {
  targets: {
    type: "list",
    description: "The targets to survey.",
    max: 8,
    unique: "id",
    of: { type: "object", fields: { id: text("The target id."), title: text("The target title."), priority: { type: "enum", values: ["required", "supporting"], description: "How much the target matters." } } },
  },
  exclusions: { type: "list", description: "The targets that the scope excluded.", of: { type: "object", fields: { id: text("The target id.") } } },
} as const

/** A survey: an inventory phase lists targets with a priority and the
 *  targets its scope excluded, a stream surveys and then verifies each
 *  target, the verify phase reports the outcome, and a `coverage` join feeds
 *  a synthesize phase. */
export const surveyWorkflow: WorkflowDefinition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "survey",
  name: "Survey",
  phases: [
    { phase: "inventory", brief: "List the targets.", name: "Inventory", output: { summary: "The inventory.", fields: surveyInventoryFields } },
    { phase: "survey", over: "inventory.targets", label: "title", brief: "Survey one target.", name: "Survey", output: { summary: "What the survey found." } },
    {
      phase: "verify",
      over: "survey",
      brief: "Verify the survey of one target.",
      name: "Verify",
      output: { summary: "The verdict.", fields: { outcome: { type: "enum", values: ["surveyed", "inaccessible", "excluded"], description: "Whether the target was surveyed." } } },
      join: { reducer: "coverage", with: { priority: "priority", outcome: "outcome", exclusions: "exclusions" } },
    },
    { phase: "synthesize", brief: "Synthesize the survey.", name: "Synthesize", output: { summary: "The synthesis." } },
  ],
})

export const SURVEY_INVENTORY = "survey:node:1"
export const SURVEY_GROUP = "survey:node:2"
export const SURVEY_SYNTHESIZE = "survey:node:4"
export const surveyStage = (ordinal: number, position: number) => `${SURVEY_GROUP}:item:${ordinal}:phase:${position}`

/** One target of the survey fixture. */
export interface SurveyTarget {
  readonly id: string
  readonly priority: "required" | "supporting"
  /** What its verify stage reports, or `fail` when its survey stage fails. */
  readonly report: "surveyed" | "inaccessible" | "excluded" | "fail"
}

/** The inventory handoff of the survey fixture. */
export const surveyInventory = (targets: readonly SurveyTarget[], exclusions: readonly string[] = []) => ({
  summary: "The inventory.",
  targets: targets.map(({ id, priority }) => ({ id, title: `Target ${id}`, priority })),
  exclusions: exclusions.map((id) => ({ id })),
})

/** The answer to one attempt of the survey fixture, by attempt id: the
 *  inventory lists `targets`, each survey stage succeeds unless its target
 *  fails, and each verify stage reports its target's outcome. */
export function surveyAnswer(targets: readonly SurveyTarget[], exclusions: readonly string[] = []) {
  return (attemptId: string): { readonly handoff: { readonly [key: string]: unknown } } | { readonly fail: string } => {
    if (attemptId.startsWith(`${SURVEY_INVENTORY}:`)) return { handoff: surveyInventory(targets, exclusions) }
    const match = /:item:(\d+):phase:(\d+):/.exec(attemptId)
    const target = match === null ? undefined : targets[Number(match[1]) - 1]
    if (target === undefined) return { handoff: { summary: "The synthesis." } }
    if (target.report === "fail") return { fail: "summary is required" }
    return match?.[2] === "1" ? { handoff: { summary: `survey of ${target.id}` } } : { handoff: { summary: `verdict on ${target.id}`, outcome: target.report } }
  }
}

/** The output fields of the review stage of the findings fixture: at most
 *  two findings per file, keyed by `id`. */
export const reviewFindingsFields = {
  findings: {
    type: "list",
    description: "The findings in the file.",
    max: 2,
    unique: "id",
    of: { type: "object", fields: { id: text("The finding id."), title: text("The finding title."), area: text("The area the finding touches.") } },
  },
} as const

const reviewRecordOfFindings = { brief: "Review one file.", name: "Review", output: { summary: "The review.", fields: reviewFindingsFields } }
const verifyRecord = {
  brief: "Verify one finding.",
  name: "Verify",
  output: { summary: "The verdict.", fields: { verdict: { type: "enum", values: ["valid", "refuted", "abstain"], description: "Whether the finding holds." } } },
}
const reportRecord = { brief: "Report the verified findings.", name: "Report", output: { summary: "The report." } }

/** Review, dedupe, and verify each finding: a phase over `input.files`
 *  reviews each file, a `dedupe` join keeps one finding per id, a second
 *  phase over the join's `kept` list verifies each surviving finding, and a
 *  `quorum` join gives each area a verdict before a report phase. */
export const findingsWorkflow: WorkflowDefinition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "findings",
  name: "Findings",
  input: {
    fields: {
      files: { type: "list", description: "The files to review.", max: 3, unique: "path", of: { type: "object", fields: { path: text("The file path.") } } },
    },
  },
  phases: [
    { phase: "reviews", over: "input.files", label: "path", ...reviewRecordOfFindings, join: { reducer: "dedupe", with: { items: "findings", by: "id" } } },
    { phase: "checks", over: "reviews.kept", label: "title", ...verifyRecord, join: { reducer: "quorum", with: { vote: "verdict", min_valid: 1, max_refuted: 0, group_by: "area" } } },
    { phase: "report", ...reportRecord },
  ],
})

export const FINDINGS_REVIEWS = "findings:node:1"
export const FINDINGS_CHECKS = "findings:node:2"
export const FINDINGS_REPORT = "findings:node:3"

/** The files of the findings fixture. b.ts comes before a.ts, so a join
 *  that orders by key does not read them in item order. */
export const FINDINGS_FILES = [{ path: "b.ts" }, { path: "a.ts" }, { path: "c.ts" }] as const

const finding = (id: string, area: string) => ({ id, title: `Finding ${id}`, area })

/** Answers for the findings fixture by attempt id: b.ts and a.ts both report
 *  F1, a.ts also reports F2, the review of c.ts fails, F1 is valid, and F2 is
 *  refuted. */
export function findingsAnswer(attemptId: string): { readonly handoff: { readonly [key: string]: unknown } } | { readonly fail: string } {
  const ordinal = Number(/:item:(\d+):/.exec(attemptId)?.[1]) - 1
  if (attemptId.startsWith(`${FINDINGS_REVIEWS}:`)) {
    const reviews = [[finding("F1", "core")], [finding("F1", "core"), finding("F2", "ui")]]
    const review = reviews[ordinal]
    return review === undefined ? { fail: "summary is required" } : { handoff: { summary: "The review.", findings: review } }
  }
  if (attemptId.startsWith(`${FINDINGS_CHECKS}:`)) return { handoff: { summary: "The verdict.", verdict: ["valid", "refuted"][ordinal] } }
  return { handoff: { summary: "The report." } }
}

/** What a test changes in the repeat fixture: the repeat's bound, a phase
 *  over the kept findings after the repeat, keys that replace or join the
 *  keys of the repeat's loop and of its phase, and the `max` of the input
 *  list. */
export interface DryOptions {
  readonly maxIterations?: number
  readonly verify?: boolean
  readonly loop?: { readonly [key: string]: unknown }
  readonly map?: { readonly [key: string]: unknown }
  readonly filesMax?: number
}

/** The encoded repeat fixture: rounds of a phase over `input.files` hunt
 *  findings in each file, a `dedupe` join keeps each new finding, and the
 *  repeat runs while a round keeps one, at most `maxIterations` rounds. With
 *  `verify`, a phase over every round's kept findings verifies each one
 *  before the report. */
export function dryDefinition({ maxIterations = 3, verify = false, loop = {}, map = {}, filesMax = 3 }: DryOptions = {}) {
  return {
    id: "dry",
    name: "Dry",
    input: { fields: { files: { type: "list", description: "The files to review.", max: filesMax, unique: "path", of: { type: "object", fields: { path: text("The file path.") } } } } },
    phases: [
      {
        repeat: { while: "finds.kept", max: maxIterations, ...loop },
        phases: [{ phase: "finds", over: "input.files", label: "path", brief: "Hunt findings in one file.", name: "Hunt", output: { summary: "The hunt.", fields: reviewFindingsFields }, join: { reducer: "dedupe", with: { items: "findings", by: "id" } }, ...map }],
      },
      ...(verify ? [{ phase: "checks", over: "finds.kept", label: "title", ...verifyRecord }] : []),
      { phase: "report", ...reportRecord },
    ],
  }
}

/** The decoded loop fixture of {@link dryDefinition}. */
export function dryWorkflow(maxIterations = 3, verify = false, filesMax?: number): WorkflowDefinition {
  return Schema.decodeUnknownSync(WorkflowDefinitionSchema)(dryDefinition({ maxIterations, verify, ...(filesMax === undefined ? {} : { filesMax }) }))
}

export const DRY_LOOP = "dry:node:1"
/** The list of one round of the repeat fixture. */
export const dryRound = (round: number) => `${DRY_LOOP}:round:${round}:node:1`
export const dryStage = (round: number, ordinal: number) => `${dryRound(round)}:item:${ordinal}:phase:1`

/** The files of the loop fixture, in key order: a.ts, then b.ts. */
export const DRY_FILES = [{ path: "a.ts" }, { path: "b.ts" }] as const

/** What each hunt reports, by round and then by file: round 1 finds F1 and
 *  F2 in a.ts and F1 again in b.ts; round 2 repeats F2 and F1 and finds F3;
 *  round 3 repeats F1 and F3, so it keeps nothing. */
export const DRY_HUNTS: readonly (readonly (readonly string[])[])[] = [
  [["F1", "F2"], ["F1"]],
  [["F2"], ["F1", "F3"]],
  [["F1"], ["F3"]],
]

const AREAS = new Map([["F1", "core"], ["F2", "ui"], ["F3", "core"]])
export const dryFinding = (id: string) => finding(id, AREAS.get(id) ?? "core")

/** Answers for the loop fixture by attempt id: each hunt reports the
 *  findings of {@link DRY_HUNTS}, a round past them reports none, each
 *  verify stage says valid, and the report succeeds. */
export function dryAnswer(attemptId: string) {
  const hunt = /:round:(\d+):node:1:item:(\d+):/.exec(attemptId)
  if (hunt !== null) {
    const ids = DRY_HUNTS[Number(hunt[1]) - 1]?.[Number(hunt[2]) - 1] ?? []
    return { handoff: { summary: "The hunt.", findings: ids.map(dryFinding) } }
  }
  if (attemptId.includes(":item:")) return { handoff: { summary: "The verdict.", verdict: "valid" } }
  return { handoff: { summary: "The report." } }
}

/** The encoded findings fixture with an adversarial vote: the phase over
 *  the kept findings casts three votes on each finding, and a `quorum` join
 *  gives each finding its own verdict before the report. */
export function votesDefinition(checks: { readonly [key: string]: unknown } = {}) {
  return {
    ...Schema.encodeSync(WorkflowDefinitionSchema)(findingsWorkflow),
    id: "votes",
    name: "Votes",
    phases: [
      { phase: "reviews", over: "input.files", label: "path", ...reviewRecordOfFindings, join: { reducer: "dedupe", with: { items: "findings", by: "id" } } },
      { phase: "checks", over: "reviews.kept", label: "title", votes: 3, ...verifyRecord, join: { reducer: "quorum", with: { vote: "verdict", min_valid: 2, max_refuted: 1 } }, ...checks },
      { phase: "report", ...reportRecord },
    ],
  }
}

export const votesWorkflow: WorkflowDefinition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)(votesDefinition())

export const VOTES_REVIEWS = "votes:node:1"
export const VOTES_CHECKS = "votes:node:2"
export const VOTES_REPORT = "votes:node:3"

/** The votes on the kept findings of {@link votesWorkflow}, by lane: F1
 *  gets two valid votes and a failed lane, and F2 one valid and two refuted
 *  votes. */
const VOTES_BY_LANE: readonly string[] = ["valid", "valid", "fail", "valid", "refuted", "refuted"]

/** Answers for {@link votesWorkflow} by attempt id: each review answers as
 *  in {@link findingsAnswer}, and each vote lane as {@link VOTES_BY_LANE}. */
export function votesAnswer(attemptId: string): { readonly handoff: { readonly [key: string]: unknown } } | { readonly fail: string } {
  if (attemptId.startsWith(`${VOTES_REVIEWS}:`)) return findingsAnswer(attemptId.replace(VOTES_REVIEWS, FINDINGS_REVIEWS))
  if (attemptId.startsWith(`${VOTES_CHECKS}:`)) {
    const vote = VOTES_BY_LANE[Number(/:item:(\d+):/.exec(attemptId)?.[1]) - 1]
    return vote === undefined || vote === "fail" ? { fail: "summary is required" } : { handoff: { summary: "The vote.", verdict: vote } }
  }
  return { handoff: { summary: "The report." } }
}
