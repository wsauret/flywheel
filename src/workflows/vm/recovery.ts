import type { CommittedWorkflowControl } from "./committed-control.js"
import { CorruptEventRowError } from "../../infra/event-store-types.js"
import { isUnknownWorkflowFamilyType, replayWorkflowControl, replayWorkflowControlFrom } from "./fact-fold.js"
import { parseWorkflowSessionFact, workflowRootControl, WORKFLOW_CONTROL_FACT_TYPES, WORKFLOW_SESSION_FACT_DESCRIPTORS, type WorkflowRecoveryDegradationReason } from "./session-facts.js"
import { selectNewestWorkflowRoot } from "../workflow-root.js"
import { WORKFLOW_RUN_FACT_TYPES } from "../run-facts.js"
import { parseDefinitionProvenanceFact, type DefinitionDriftRejectedPayload } from "../definition-provenance-facts.js"

const controlTypes: ReadonlySet<string> = new Set(WORKFLOW_CONTROL_FACT_TYPES)
const sessionTypes: ReadonlySet<string> = new Set(WORKFLOW_SESSION_FACT_DESCRIPTORS.map(({ type }) => type))

interface ExecutableWorkflowRecoveryPlan {
  readonly kind: "executable"
  readonly executable: true
  readonly control: CommittedWorkflowControl
  readonly rootSeq: number
}

interface PausedWorkflowRecoveryPlan {
  readonly kind: "recovery"
  readonly executable: false
  readonly status: "paused"
  readonly control: null
  readonly reasons: readonly WorkflowRecoveryDegradationReason[]
}

export type WorkflowRecoveryPlan = ExecutableWorkflowRecoveryPlan | PausedWorkflowRecoveryPlan

/** Prove all control semantics from the newest root, preserving stored positions.
 * Companion bodies, including the facts of workflow-owned requests, do not
 * determine control. Unprovable control returns null, never an earlier prefix
 * that could repeat already settled work.
 * Unstored fixtures must pass strict replay; damaged ones have no position proof. */
export function workflowRecoveryBasis(facts: readonly unknown[]): CommittedWorkflowControl | null {
  const root = selectNewestWorkflowRoot(facts)
  if (!root) return null
  try {
    if (root.seq === null) return replayWorkflowControl(facts)
    const fact = parseWorkflowSessionFact(factPayload(facts[root.index]))
    if (fact.type !== "workflow.control.initialized" && fact.type !== "workflow.control.recovered") return null
    const initial = workflowRootControl(fact)
    if (!Number.isInteger(root.seq) || root.seq < 0 || initial.aggregateSeq <= root.seq) return null
    // The root batch is proved by its root alone. Every later fact replays
    // by position, so a companion between batches advances the sequence that
    // the next proposal identity names.
    const suffix: unknown[] = []
    let lastSeq = root.seq
    for (let index = root.index + 1; index < facts.length; index += 1) {
      const value = facts[index]
      const seq = storedSequence(value, -1)
      if (seq <= lastSeq) return null
      lastSeq = seq
      const envelope = looseEnvelope(value)
      if (!envelope) return null
      if (isUnknownWorkflowFamilyType(envelope.type)) return null
      if (seq >= initial.aggregateSeq) {
        suffix.push(value)
        continue
      }
      if (!controlTypes.has(envelope.type)) continue
      const companion = parseWorkflowSessionFact(factPayload(value))
      if (fact.type !== "workflow.control.recovered" || companion.type !== "attempt.recovered") return null
    }
    return replayWorkflowControlFrom(initial, suffix)
  } catch {
    return null
  }
}

/** Tolerantly classify durable workflow control. Executable control is returned only when strict replay from the newest recognized root succeeds. */
export function recoverWorkflowControl(facts: readonly unknown[]): WorkflowRecoveryPlan {
  const root = selectNewestWorkflowRoot(facts)
  if (!root) {
    const runOnly = facts.every((fact) => WORKFLOW_RUN_FACT_TYPES.includes(looseEnvelope(fact)?.type ?? ""))
    return paused(runOnly ? [{ kind: "missing_root" }] : [{ kind: "malformed_fact", seq: 0 }])
  }
  const versions = WORKFLOW_SESSION_FACT_DESCRIPTORS.filter(({ type }) => type === root.type).map(({ version }) => version)
  const expectedVersion = Math.max(...versions)
  if (typeof root.version === "number" && !versions.includes(root.version)) {
    return paused([{
      kind: root.version < expectedVersion ? "recognized_legacy_version" : "recognized_newer_version",
      seq: root.seq ?? root.index,
      type: root.type,
      version: root.version,
    }])
  }
  try {
    parseWorkflowSessionFact(factPayload(facts[root.index]))
  } catch {
    return paused([{ kind: "malformed_fact", seq: storedSequence(facts[root.index], root.index) }])
  }
  try {
    return {
      kind: "executable",
      executable: true,
      control: replayWorkflowControl(facts),
      rootSeq: storedSequence(facts[root.index], root.index),
    }
  } catch {
    const malformed = malformedSuffixReason(facts, root.index + 1)
    return paused([malformed ?? { kind: "invalid_suffix", seq: storedSequence(facts.at(-1), facts.length - 1) }])
  }
}

/** One sentence that tells a person why the saved workflow cannot run. The raw
 * reason kind, sequence, and version belong in logs, not in this text. */
export function describeWorkflowRecoveryDegradation(reason: WorkflowRecoveryDegradationReason): string {
  switch (reason.kind) {
    case "malformed_fact": return "This workflow's saved progress has a damaged record."
    case "recognized_legacy_version": return "This workflow's saved progress uses an older format that this version of Flywheel cannot run."
    case "recognized_newer_version": return "This workflow's saved progress was written by a newer version of Flywheel."
    case "unknown_version": return "This workflow's saved progress has a record that this version of Flywheel cannot read."
    case "missing_root": return "This workflow's saved progress has no starting record."
    case "missing_companion": return reason.family === "queue.created"
      ? "This workflow's saved progress is missing its plan."
      : "This workflow's saved progress is missing its original request."
    case "invalid_suffix": return "This workflow's saved progress has records that cannot be replayed in order."
  }
}

/** The drift rejection that still holds: the newest `definition.drift_rejected`
 *  fact when no control fact follows it. A Resume that the definition no
 *  longer matches writes the rejection and changes no control, so until
 *  control moves on, such as when a restored definition lets a message resume
 *  the run, the last Resume's answer is the workflow's answer. A value of the
 *  tolerant read that is not a readable fact neither proves nor ends a
 *  rejection. */
export function currentDefinitionDriftRejection(facts: readonly unknown[]): DefinitionDriftRejectedPayload | undefined {
  let rejection: DefinitionDriftRejectedPayload | undefined
  for (const fact of facts) rejection = advanceDefinitionDriftRejection(rejection, fact)
  return rejection
}

/** The drift rejection that holds after one more fact: a control fact ends
 *  it, a `definition.drift_rejected` fact replaces it, and any other fact
 *  keeps it. Folding every fact in order gives `currentDefinitionDriftRejection`. */
export function advanceDefinitionDriftRejection(previous: DefinitionDriftRejectedPayload | undefined, value: unknown): DefinitionDriftRejectedPayload | undefined {
  const envelope = looseEnvelope(value)
  if (!envelope) return previous
  if (controlTypes.has(envelope.type)) return undefined
  if (envelope.type !== "definition.drift_rejected") return previous
  try {
    const fact = parseDefinitionProvenanceFact(factPayload(value))
    return fact.type === "definition.drift_rejected" ? fact.payload : undefined
  } catch {
    return undefined
  }
}

function paused(reasons: readonly WorkflowRecoveryDegradationReason[]): PausedWorkflowRecoveryPlan {
  return { kind: "recovery", executable: false, status: "paused", control: null, reasons }
}

function malformedSuffixReason(facts: readonly unknown[], start: number): WorkflowRecoveryDegradationReason | null {
  for (let index = start; index < facts.length; index += 1) {
    const envelope = looseEnvelope(facts[index])
    if (!envelope) return { kind: "malformed_fact", seq: storedSequence(facts[index], index) }
    // A workflow-owned request records facts of a family this layer does not
    // decode, and control replay never reads their bodies.
    if (!sessionTypes.has(envelope.type)) continue
    try {
      parseWorkflowSessionFact(factPayload(facts[index]))
    } catch {
      return {
        kind: "unknown_version",
        seq: storedSequence(facts[index], index),
        type: envelope.type,
        version: envelope.version,
      }
    }
  }
  return null
}

function looseEnvelope(value: unknown): { readonly type: string; readonly version: number } | null {
  if (value instanceof CorruptEventRowError) return value.row
  if (!value || typeof value !== "object") return null
  const type = "type" in value ? value.type : undefined
  const version = "version" in value ? value.version : undefined
  return typeof type === "string" && typeof version === "number" && Number.isInteger(version)
    ? { type, version }
    : null
}

function storedSequence(value: unknown, fallback: number): number {
  if (value instanceof CorruptEventRowError) return value.row.seq
  if (value && typeof value === "object" && "seq" in value && typeof value.seq === "number" && Number.isInteger(value.seq) && value.seq >= 0) return value.seq
  return fallback
}


interface LooseFactPayload {
  readonly type: unknown
  readonly version: unknown
  readonly actor: unknown
  readonly payload: unknown
}

function factPayload(value: unknown): LooseFactPayload | null {
  if (!value || typeof value !== "object") return null
  return {
    type: "type" in value ? value.type : undefined,
    version: "version" in value ? value.version : undefined,
    actor: "actor" in value ? value.actor : undefined,
    payload: "payload" in value ? value.payload : undefined,
  }
}
