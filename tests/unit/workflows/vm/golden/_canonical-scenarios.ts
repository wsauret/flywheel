import { Schema } from "effect"
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../../src/workflows/workflow-schema.js"
import type { AttemptRunOutcome } from "../../../../../src/workflows/vm/attempt-runner.js"
import type { ReassessmentProposal } from "../../../../../src/workflows/vm/events.js"

interface CanonicalContent {
  readonly [key: string]: unknown
}
export type CanonicalOutcome =
  | { readonly kind: "success"; readonly handoff: CanonicalContent; readonly reassessment?: ReassessmentProposal }
  | { readonly kind: Exclude<AttemptRunOutcome["kind"], "success">; readonly reason: string; readonly content?: CanonicalContent }

export type CanonicalAction = "run" | "pause-before" | "abort-resume" | "abort" | "crash-recover" | "poison"

export interface CanonicalScenario {
  readonly id: string
  readonly area: string
  readonly enduringSemantics: string
  readonly retiredRuntimeEnvelope: readonly string[]
  readonly workflow: WorkflowDefinition
  readonly outcomes: readonly CanonicalOutcome[]
  readonly action?: CanonicalAction
  readonly guardrails?: { readonly maxAttempts: number; readonly maxMutationsPerAttempt: number; readonly maxInserts: number }
  readonly expected: {
    readonly invocations: readonly string[]
    readonly status: "completed" | "failed" | "paused" | "running"
    readonly attempts: readonly string[]
    readonly completed: number
    readonly failed: number
    readonly resumeRevertCounts?: readonly number[]
  }
}

/** One element of a scenario's phases: a phase, which the scenario gives a
 *  brief and an output, or a repeat of phases. */
type ScenarioPhase =
  | { readonly phase: string; readonly [key: string]: unknown }
  | { readonly repeat: { readonly [key: string]: unknown }; readonly phases: readonly ScenarioPhase[] }

/** The output fields that a scenario's phases declare, by phase id. A phase
 *  that is not named declares only its summary. */
type ScenarioFields = { readonly [phaseId: string]: { readonly [field: string]: unknown } }

function scenario(input: Omit<CanonicalScenario, "workflow"> & {
  readonly phases: readonly ScenarioPhase[]
  readonly fields?: ScenarioFields
}): CanonicalScenario {
  const { phases, fields = {}, ...authored } = input
  // The reassess phase of a repeat declares no output: the VM owns its
  // contract.
  const record = (entry: ScenarioPhase, reassess?: unknown): object => "phase" in entry
    ? {
      brief: `Do the ${entry.phase} work.`, name: entry.phase, writes: [],
      ...(entry.phase === reassess ? {} : { output: { summary: "Result", ...(fields[entry.phase] ? { fields: fields[entry.phase] } : {}) } }),
      ...entry,
    }
    : { ...entry, phases: entry.phases.map((phase) => record(phase, entry.repeat.reassess)) }
  return {
    ...authored,
    workflow: Schema.decodeUnknownSync(WorkflowDefinitionSchema)({ id: input.id, name: input.id, phases: phases.map((phase) => record(phase)) }),
  }
}

const success = (handoff: CanonicalContent = { summary: "done" }): CanonicalOutcome => ({ kind: "success", handoff })
const failed = (kind: Exclude<AttemptRunOutcome["kind"], "success">, reason: string, content?: CanonicalContent): CanonicalOutcome => ({ kind, reason, ...(content ? { content } : {}) })
const defaultEnvelope = ["event ids and timestamps", "queue cursor and mutation-log shape", "retired stage result envelope"] as const
const reason = { type: "string", nullable: true } as const
const findings = { type: "list", optional: true, of: { type: "string" } } as const
const itemsField = { items: { type: "list", max: 5, unique: "id", of: { type: "object", fields: { id: { type: "string" } } } } } as const

export const canonicalScenarios: readonly CanonicalScenario[] = [
  scenario({
    id: "linear-three-phase-completion", area: "linear completion", enduringSemantics: "Three phases run once in order and complete.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "one" }, { phase: "two" }, { phase: "three" }], outcomes: [success(), success(), success()],
    expected: { invocations: ["one", "two", "three"], status: "completed", attempts: ["one:completed", "two:completed", "three:completed"], completed: 3, failed: 0 },
  }),
  scenario({
    id: "nested-conditions", area: "condition", enduringSemantics: "A phase whose condition field is not empty runs, and so does the phase whose condition names its field.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "source" }, { phase: "follow", if: "source.needs_followup" }, { phase: "residual", if: "follow.needs_residual" }],
    fields: { source: { needs_followup: reason }, follow: { needs_residual: reason } },
    outcomes: [success({ summary: "source", needs_followup: "the source left a gap" }), success({ summary: "follow", needs_residual: "the follow-up left a gap" }), success()],
    expected: { invocations: ["source", "follow", "residual"], status: "completed", attempts: ["source:completed", "follow:completed", "residual:completed"], completed: 3, failed: 0 },
  }),
  scenario({
    id: "condition-skip", area: "condition", enduringSemantics: "An empty condition field skips its phase, and the phases after it still run.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "source" }, { phase: "follow", if: "source.findings" }, { phase: "tail" }], fields: { source: { findings } },
    outcomes: [success({ summary: "clean", findings: [] }), success()],
    expected: { invocations: ["source", "tail"], status: "completed", attempts: ["source:completed", "follow:skipped", "tail:completed"], completed: 2, failed: 0 },
  }),
  ...([
    ["repeat-converges", "A bounded repeat runs one repair round and then converges.", 3, true, [["finding"], []]],
    ["repeat-stuck", "An unchanged normalized signal stops a repeat that sets stuck.", 3, true, [["same"], ["same"]]],
  ] as const).map(([id, enduringSemantics, max, stuck, signals]) => scenario({
    id, area: "bounded repeat", enduringSemantics, retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ repeat: { while: "review.findings", max, stuck }, phases: [{ phase: "review" }, { phase: "fix" }] }], fields: { review: { findings } },
    outcomes: [success({ summary: "review", findings: signals[0] }), success(), success({ summary: "review", findings: signals[1] })],
    expected: { invocations: ["review", "fix", "review"], status: "completed", attempts: ["review:completed", "fix:completed", "review:completed", "fix:skipped"], completed: 3, failed: 0 },
  })),
  scenario({
    id: "repeat-max", area: "bounded repeat", enduringSemantics: "Persistent findings at the bound end the repeat on its last review, and no fix follows that review.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ repeat: { while: "review.findings", max: 2 }, phases: [{ phase: "review" }, { phase: "fix" }] }], fields: { review: { findings } },
    outcomes: [success({ summary: "review", findings: ["first"] }), success(), success({ summary: "review", findings: ["second"] })],
    expected: { invocations: ["review", "fix", "review"], status: "completed", attempts: ["review:completed", "fix:completed", "review:completed", "fix:skipped"], completed: 3, failed: 0 },
  }),
  scenario({
    id: "each-three-items", area: "repeat each", enduringSemantics: "List order determines the order of the rounds, one for each item.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "source" }, { repeat: { each: "source.items" }, phases: [{ phase: "body" }, { phase: "follow" }] }], fields: { source: itemsField },
    outcomes: [success({ summary: "items", items: [{ id: "a" }, { id: "b" }, { id: "c" }] }), success(), success(), success(), success(), success(), success()],
    expected: { invocations: ["source", "body", "follow", "body", "follow", "body", "follow"], status: "completed", attempts: ["source:completed", "body:completed", "follow:completed", "body:completed", "follow:completed", "body:completed", "follow:completed"], completed: 7, failed: 0 },
  }),
  scenario({
    id: "each-empty-list", area: "repeat each", enduringSemantics: "An empty source completes the repeat without work.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "source" }, { repeat: { each: "source.items" }, phases: [{ phase: "body" }] }], fields: { source: itemsField },
    outcomes: [success({ summary: "none", items: [] })],
    expected: { invocations: ["source"], status: "completed", attempts: ["source:completed", "body:skipped"], completed: 1, failed: 0 },
  }),
  scenario({
    id: "evaluation-retry-succeeds", area: "retry", enduringSemantics: "An authored retry runs once after invalid evidence and then completes.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work", retry: { max: 2, stuck: true } }], outcomes: [failed("invalid_handoff", "verification evidence is missing", { raw: true }), success()],
    expected: { invocations: ["work", "work"], status: "completed", attempts: ["work:failed", "work:completed"], completed: 1, failed: 1 },
  }),
  scenario({
    id: "evaluation-retry-exhausted", area: "retry", enduringSemantics: "Invalid evidence at the retry bound fails the agent without another invocation, and the run fails, because the parent reads the last phase's output.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work", retry: { max: 1, stuck: true } }], outcomes: [failed("invalid_handoff", "verification evidence is missing", { raw: true })],
    expected: { invocations: ["work"], status: "failed", attempts: ["work:failed"], completed: 0, failed: 1 },
  }),
  ...(["transient", "fatal", "fatal"] as const).map((kind, index) => scenario({
    id: ["ordinary-transient-failure", "ordinary-unknown-failure", "ordinary-fatal-failure"][index] ?? kind,
    area: "worker failure", enduringSemantics: "A classified worker failure fails its agent, and the run fails, because the parent reads the last phase's output.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work" }], outcomes: [failed(kind, `${kind} worker failure`)],
    expected: { invocations: ["work"], status: "failed", attempts: ["work:failed"], completed: 0, failed: 1 },
  })),
  scenario({
    id: "context-overflow-fails-agent", area: "context overflow", enduringSemantics: "Context overflow fails only its agent.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work" }], outcomes: [failed("context_overflow", "context overflow")],
    expected: { invocations: ["work"], status: "failed", attempts: ["work:failed"], completed: 0, failed: 1 },
  }),
  scenario({
    id: "resume-poison-cap", area: "recovery", enduringSemantics: "A fourth automatic recovery pauses the poisoned attempt without invoking or failing it.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work" }], outcomes: [], action: "poison",
    expected: { invocations: [], status: "paused", attempts: ["work:pending"], completed: 0, failed: 0, resumeRevertCounts: [3] },
  }),
  scenario({
    id: "pause-before-worker", area: "lifecycle", enduringSemantics: "Pre-attempt policy durably pauses before worker acquisition.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work" }], outcomes: [], action: "pause-before",
    expected: { invocations: [], status: "paused", attempts: ["work:pending"], completed: 0, failed: 0 },
  }),
  scenario({
    id: "operator-shutdown-resume", area: "lifecycle", enduringSemantics: "The runtime's teardown interrupts active work at once and resume runs it again in its own attempt, then the remaining work.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "one" }, { phase: "two" }], outcomes: [success(), success()], action: "abort-resume",
    expected: { invocations: ["one", "one", "two"], status: "completed", attempts: ["one:completed", "two:completed"], completed: 2, failed: 0 },
  }),
  scenario({
    id: "cancel-shutdown-before-boundary", area: "lifecycle", enduringSemantics: "With no accepted pause, both authored attempts run once.", retiredRuntimeEnvelope: ["requestShutdown/cancelShutdown method pair", ...defaultEnvelope],
    phases: [{ phase: "one" }, { phase: "two" }], outcomes: [success(), success()],
    expected: { invocations: ["one", "two"], status: "completed", attempts: ["one:completed", "two:completed"], completed: 2, failed: 0 },
  }),
  scenario({
    id: "abort-active-worker", area: "lifecycle", enduringSemantics: "Abort awaits the active child and restores resumable pending work.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work" }], outcomes: [], action: "abort",
    expected: { invocations: ["work"], status: "paused", attempts: ["work:pending"], completed: 0, failed: 0 },
  }),
  scenario({
    id: "crash-after-committed-start", area: "lifecycle", enduringSemantics: "Crash recovery reruns only the incomplete attempt and then completes remaining work.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "one" }, { phase: "two" }], outcomes: [success(), success()], action: "crash-recover",
    expected: { invocations: ["one", "two", "two"], status: "completed", attempts: ["one:completed", "two:completed"], completed: 2, failed: 0, resumeRevertCounts: [0, 1] },
  }),
  scenario({
    id: "missing-required-handoff", area: "handoff", enduringSemantics: "Missing required handoff fails only its agent.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work" }], outcomes: [failed("missing_handoff", "missing handoff")],
    expected: { invocations: ["work"], status: "failed", attempts: ["work:failed"], completed: 0, failed: 1 },
  }),
  scenario({
    id: "invalid-handoff-authored-retry-chain", area: "handoff", enduringSemantics: "Each invalid handoff contributes ordered retry feedback before success.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work", retry: { max: 3, stuck: true } }], outcomes: [failed("invalid_handoff", "missing constraint", { raw: 1 }), failed("invalid_handoff", "missing branch", { raw: 2 }), success()],
    expected: { invocations: ["work", "work", "work"], status: "completed", attempts: ["work:failed", "work:failed", "work:completed"], completed: 1, failed: 2 },
  }),
  scenario({
    id: "reassess-respecification", area: "reassessment", enduringSemantics: "An accepted replacement and insertion change the remaining items, and each runs as its own round.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "source" }, { repeat: { each: "source.items", reassess: "replan" }, phases: [{ phase: "build" }, { phase: "replan" }] }], fields: { source: itemsField },
    outcomes: [
      success({ summary: "items", items: [{ id: "a" }, { id: "b" }] }),
      success(),
      { kind: "success", handoff: { summary: "adjust", changes: [] }, reassessment: {
        proposalId: "proposal",
        ownerNodeId: "reassess-respecification:node:2:round:1:node:2",
        reason: "revise the items",
        changes: [
          { kind: "insert_item", repeatNodeId: "reassess-respecification:node:2", afterItemId: "b", item: { id: "c" }, reason: "insert item c" },
          { kind: "replace_item", repeatNodeId: "reassess-respecification:node:2", itemId: "b", item: { id: "b-revised" }, reason: "replace item b" },
        ],
      } },
      success(), success({ summary: "confirm", changes: [] }), success(), success({ summary: "confirm", changes: [] }),
    ],
    expected: { invocations: ["source", "build", "replan", "build", "replan", "build", "replan"], status: "completed", attempts: ["source:completed", "build:completed", "replan:completed", "build:completed", "replan:completed", "build:completed", "replan:completed"], completed: 7, failed: 0 },
  }),
  scenario({
    id: "reassess-confirmed", area: "reassessment", enduringSemantics: "A confirmed reassessment is inert and leaves downstream work unchanged.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "review" }, { phase: "tail" }], outcomes: [success(), success()],
    expected: { invocations: ["review", "tail"], status: "completed", attempts: ["review:completed", "tail:completed"], completed: 2, failed: 0 },
  }),
  scenario({
    id: "retry-bypasses-insert-budget", area: "guardrail accounting", enduringSemantics: "Definition-authored remediation remains available when the insert budget is zero.", retiredRuntimeEnvelope: defaultEnvelope,
    phases: [{ phase: "work", retry: { max: 2, stuck: true } }], outcomes: [failed("invalid_handoff", "retry", { raw: true }), success()], guardrails: { maxAttempts: 50, maxMutationsPerAttempt: 3, maxInserts: 0 },
    expected: { invocations: ["work", "work"], status: "completed", attempts: ["work:failed", "work:completed"], completed: 1, failed: 1 },
  }),
]
