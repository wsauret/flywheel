import { isDeepStrictEqual } from "node:util"
import { parseProjectionFact } from "../../infra/event-projection.js"
import { CorruptEventRowError, type StoredFact } from "../../infra/event-store-types.js"
import { SESSION_RUNTIME_FACT_DEFINITIONS } from "../../infra/runtime-fact-types.js"
import { type CommittedWorkflowControl, parseCommittedWorkflowControl } from "./committed-control.js"
import {
  definitionIdentityMigrationOrder,
  definitionIdentityMismatches,
  isContentOnlyIdentityChange,
  type DefinitionIdentity,
  type DefinitionIdentityMigration,
  type DefinitionIdentityMismatch,
} from "./definition-identity.js"
import {
  committedWorkflowEvent,
  parseWorkflowControlFact,
  parseWorkflowSessionFact,
  replayComparableFact,
  workflowRootControl,
  WORKFLOW_CONTROL_FACT_TYPES,
  WORKFLOW_SESSION_FACT_DESCRIPTORS,
  type WorkflowControlFact,
  type WorkflowSessionFact,
} from "./session-facts.js"
import { retriableFailedNodes } from "./attempt-continuation.js"
import { inheritGraphTopology } from "./graph-topology.js"
import { replayDecodedWorkflow, transitionDecodedWorkflow } from "./transition.js"
import { selectNewestWorkflowRoot, workflowFamilyEvents } from "../workflow-root.js"

const controlFactTypes: ReadonlySet<string> = new Set(WORKFLOW_CONTROL_FACT_TYPES)
const workflowFamilyTypes: ReadonlySet<string> = new Set(WORKFLOW_SESSION_FACT_DESCRIPTORS.map(({ type }) => type))
const runtimeFactTypes: ReadonlySet<string> = new Set(SESSION_RUNTIME_FACT_DEFINITIONS.map(({ type }) => type))
// Runtime companions share model/budget ownership with requests. Context
// requests also share context., so workflow ownership starts at its subdomain.
const workflowFamilyPrefixes = [...new Set(WORKFLOW_SESSION_FACT_DESCRIPTORS
  .filter(({ type }) => !runtimeFactTypes.has(type))
  .map(({ type }) => `${type.split(".").slice(0, type.startsWith("context.") ? 2 : 1).join(".")}.`))]
/** The aggregate also holds the session facts of workflow-owned requests,
 *  such as the learning review that follows a handoff. That family belongs to
 *  the request owner, so replay keeps only the position of such a fact. */
const OTHER_FAMILY = "other-family"

/** A fact that no proposal batch carries: workflow usage and run facts, the
 *  memory and improvement audit that the memory tool and the inspiration
 *  reconciler record, the definition drift rejection that replay records
 *  before it refuses, and every fact of another family. Its own transaction
 *  lands between batches, so it advances the aggregate sequence before the
 *  next proposal folds, and that proposal's identity stays its committed one. */
function isIndependentCompanion(type: WorkflowCompanionEnvelope["type"] | WorkflowControlFact["type"]): boolean {
  return type === OTHER_FAMILY
    || type.startsWith("budget.") || type.startsWith("workflow.run.") || type === "model.usage.measured"
    || type.startsWith("memory.") || type.startsWith("improvement.") || type === "definition.drift_rejected"
}

/** Read a committed insertion refusal from the current recovery generation. Returns undefined when no refusal exists; malformed current facts throw. */
export function workflowInsertionRefusalReason(events: readonly StoredFact[]): string | undefined {
  const event = workflowFamilyEvents(events).findLast((fact) => fact.type === "attempt.insertion_rejected")
  if (!event) return undefined
  const fact = parseProjectionFact(event, parseWorkflowSessionFact)
  return fact.type === "attempt.insertion_rejected" ? fact.payload.reason : undefined
}

/** Whether a person's Resume runs failed workflow `control` again, which
 *  replays `events`. A run fails this way only from encoding 8, where an
 *  agent that fails fails only itself: the proposal that ended the run is of
 *  encoding 8 or later, no refusal of an insertion or of a list's expansion
 *  ended it, and it holds a failed agent to run again
 *  (`retriableFailedNodes` at that encoding). A refusal would repeat on a run again. A run
 *  that failed at encoding 7 or earlier failed on such a refusal or on a
 *  recorded blocked attempt, so it stays failed as it did then. */
export function resumesFailedAgents(events: readonly StoredFact[], control: CommittedWorkflowControl): boolean {
  return resumesFailedAgentsWith(workflowFamilyEvents(events).reduce(advanceRetryEvidence, NO_RETRY_EVIDENCE), control)
}

/** What the family's facts say about running failed agents again: the
 *  encoding of the proposal that ended the run, and whether a refusal of an
 *  insertion or of a list's expansion was recorded. A held fold advances it
 *  one family fact at a time, so it never reads the family again. */
export interface FailedAgentRetryEvidence {
  readonly endingVersion: number | undefined
  readonly refused: boolean
}

export const NO_RETRY_EVIDENCE: FailedAgentRetryEvidence = { endingVersion: undefined, refused: false }

export function advanceRetryEvidence(evidence: FailedAgentRetryEvidence, event: StoredFact): FailedAgentRetryEvidence {
  if (event.type === "workflow.control.committed") return { ...evidence, endingVersion: event.version }
  if (event.type === "attempt.insertion_rejected" || event.type === "group.expansion_rejected") return { ...evidence, refused: true }
  return evidence
}

/** `resumesFailedAgents` for a caller that holds the family's retry evidence. */
export function resumesFailedAgentsWith({ endingVersion, refused }: FailedAgentRetryEvidence, control: CommittedWorkflowControl): boolean {
  return endingVersion !== undefined && endingVersion >= 8 && !refused
    && control.status === "failed" && retriableFailedNodes(control, endingVersion).length > 0
}

/** A known workflow fact that is not control: a view, context, provenance,
 *  handoff, or memory companion, or a fact of another family. Control replay
 *  reads it by its type and position only, so its body never decides control
 *  (ARCH-WORKFLOWS-006). */
interface WorkflowCompanionEnvelope {
  readonly type: Exclude<WorkflowSessionFact["type"], WorkflowControlFact["type"]> | typeof OTHER_FAMILY
  readonly companion: true
}

interface ParsedWorkflowFact {
  readonly fact: WorkflowControlFact | WorkflowCompanionEnvelope
  readonly seq: number | null
}

interface ParsedWorkflowStream {
  readonly facts: readonly ParsedWorkflowFact[]
}

/** Fold one complete atomic proposal batch into its resulting control. */
export function foldWorkflowControl(
  previous: CommittedWorkflowControl | null,
  facts: readonly unknown[],
): CommittedWorkflowControl {
  const parsed = parseFacts(facts, previous?.aggregateSeq ?? 0)
  return foldParsedWorkflowControl(previous, parsed.facts)
}

/** Replay control history from one initialization snapshot and semantic proposal batches. */
export function replayWorkflowControl(
  facts: readonly unknown[],
): CommittedWorkflowControl {
  const root = selectNewestWorkflowRoot(facts)
  if (!root) throw new Error("Workflow control replay requires a recognized root")
  const suffix = facts.slice(root.index)
  const expectedStart = storedSeq(suffix[0]) ?? 0
  const parsed = parseFacts(suffix, expectedStart)
  const rootEntry = parsed.facts[0]
  if (!rootEntry) throw new Error("Workflow control replay requires a recognized root")
  const initialEnd = rootEntry.fact.type === "workflow.control.initialized"
    ? rootEntry.fact.payload.control.aggregateSeq
    : rootEntry.fact.type === "workflow.control.recovered"
      ? rootEntry.fact.payload.control.aggregateSeq
      : -1
  const initialBoundary = initialBatchLength(parsed.facts, initialEnd)
  if (initialBoundary < 1) throw new Error(`Workflow control replay rejected root sequence ${initialEnd}`)
  const control = replayParsedWorkflowControl(
    foldParsedWorkflowControl(null, parsed.facts.slice(0, initialBoundary), false),
    parsed.facts,
    initialBoundary,
  )
  return parseCommittedWorkflowControl(control)
}

/** Replay a newly committed suffix from an already validated committed prefix. */
export function replayWorkflowControlFrom(
  previous: CommittedWorkflowControl,
  facts: readonly unknown[],
): CommittedWorkflowControl {
  const parsed = parseFacts(facts, previous.aggregateSeq)
  // Independent envelopes change only the sequence. The prefix's graph,
  // attempts, and guardrails are already validated and stay shared.
  if (parsed.facts.every(({ fact }) => isIndependentCompanion(fact.type))) {
    return foldParsedWorkflowControl(previous, parsed.facts, false)
  }
  const replayed = replayParsedWorkflowControl(previous, parsed.facts, 0)
  const control = parseCommittedWorkflowControl(replayed)
  // The strict decode copies every node. The copy keeps the structure, and
  // the derived frontier, of the graph that the transitions left, so a
  // commit that changes node states never builds the structure again.
  inheritGraphTopology(replayed.graph, control.graph, [])
  return control
}

function replayParsedWorkflowControl(
  previous: CommittedWorkflowControl,
  facts: readonly ParsedWorkflowFact[],
  start: number,
): CommittedWorkflowControl {
  let control = previous
  let offset = start
  let adoptedOrder = -1
  while (offset < facts.length) {
    const boundary = facts[offset]
    if (boundary?.fact.type === "workflow.definition_identity.migrated") {
      const order = definitionIdentityMigrationOrder(boundary.fact.payload.migrationId)
      if (order <= adoptedOrder) {
        throw new Error(`Workflow control replay rejected out-of-order migration ${boundary.fact.payload.migrationId}`)
      }
      control = adoptDefinitionIdentity(control, boundary.fact.payload, nextAggregateSeq(control.aggregateSeq, [boundary]))
      adoptedOrder = order
      offset += 1
      continue
    }
    if (boundary?.fact.type === "workflow.definition_identity.adopted") {
      control = adoptContentOnlyIdentity(
        control,
        boundary.fact.payload,
        nextAggregateSeq(control.aggregateSeq, [boundary]),
      )
      offset += 1
      continue
    }
    let terminalOffset = offset
    while (terminalOffset < facts.length) {
      const type = facts[terminalOffset]?.fact.type
      if (type === "workflow.control.committed"
        || type === "workflow.definition_identity.migrated"
        || type === "workflow.definition_identity.adopted") break
      terminalOffset += 1
    }
    // Identity facts stand alone. A preceding diagnostic suffix advances the
    // sequence first; an incomplete semantic proposal still fails strict fold.
    const end = facts[terminalOffset]?.fact.type === "workflow.control.committed" ? terminalOffset + 1 : terminalOffset
    control = foldParsedWorkflowControl(control, facts.slice(offset, end), false)
    offset = end
  }
  return control
}

interface ContentOnlyAdoption {
  readonly prior: DefinitionIdentity
  readonly adopted: DefinitionIdentity
  readonly evidence: readonly DefinitionIdentityMismatch[]
}

function adoptContentOnlyIdentity(
  previous: CommittedWorkflowControl,
  adoption: ContentOnlyAdoption,
  aggregateSeq: number,
): CommittedWorkflowControl {
  if (!isDeepStrictEqual(previous.definitionIdentity, adoption.prior)) {
    throw new Error("Workflow control replay rejected definition identity adoption against a different prior identity")
  }
  const evidence = definitionIdentityMismatches(adoption.prior, adoption.adopted)
  if (!isDeepStrictEqual(evidence, adoption.evidence)) {
    throw new Error("Workflow control replay rejected definition identity adoption evidence")
  }
  if (!isContentOnlyIdentityChange(adoption.prior, adoption.adopted, evidence)) {
    throw new Error("Workflow control replay rejected structural definition identity adoption")
  }
  return { ...previous, definitionIdentity: adoption.adopted, aggregateSeq }
}

/** Apply the one semantic act the migration fact states: replace the recorded
 *  identity with the adopted one. The fact stands alone at an aggregate tail
 *  boundary, so it carries no proposal and moves no other control state. */
function adoptDefinitionIdentity(
  previous: CommittedWorkflowControl,
  migration: DefinitionIdentityMigration,
  aggregateSeq: number,
): CommittedWorkflowControl {
  if (!isDeepStrictEqual(previous.definitionIdentity, migration.prior)) {
    throw new Error(`Workflow control replay rejected migration ${migration.migrationId} against a different prior identity`)
  }
  if (!isDeepStrictEqual(definitionIdentityMismatches(migration.prior, migration.adopted), migration.evidence)) {
    throw new Error(`Workflow control replay rejected migration ${migration.migrationId} evidence`)
  }
  return {
    ...previous,
    definitionIdentity: migration.adopted,
    aggregateSeq,
  }
}

function foldParsedWorkflowControl(
  previous: CommittedWorkflowControl | null,
  entries: readonly ParsedWorkflowFact[],
  validateControl = true,
): CommittedWorkflowControl {
  const independent = entries.findIndex(({ fact }) => !isIndependentCompanion(fact.type))
  if (previous && independent > 0) {
    return foldParsedWorkflowControl(
      foldParsedWorkflowControl(previous, entries.slice(0, independent), false),
      entries.slice(independent), validateControl,
    )
  }
  const facts = entries.map(({ fact }) => fact)
  if (facts.length === 0) {
    if (!previous) throw new Error("Workflow control replay requires workflow.control.initialized")
    return validateControl ? parseCommittedWorkflowControl(previous) : previous
  }
  const roots = facts.filter(({ type }) => type === "workflow.control.initialized" || type === "workflow.control.recovered")
  if (!previous) {
    if (roots.length !== 1) throw new Error("Workflow control replay must start with one recognized root")
    const fact = roots[0]
    if (fact?.type !== "workflow.control.initialized" && fact?.type !== "workflow.control.recovered") {
      throw new Error("Workflow control replay must start with one recognized root")
    }
    const invalidRootCompanion = facts.some(({ type }) => controlFactTypes.has(type)
      && type !== fact.type
      && !(fact.type === "workflow.control.recovered" && type === "attempt.recovered"))
    if (invalidRootCompanion) {
      throw new Error(fact.type === "workflow.control.initialized"
        ? "Workflow control replay rejected proposal facts in the initialization batch"
        : "Workflow control replay rejected control facts in the recovery root batch")
    }
    // A stored initialization batch may end with pruned replace-only
    // companions, so its retained facts can stop short of the position the
    // root recorded. That batch holds no control fact but its root, so a gap
    // can only be a companion. A recovery batch must keep every
    // attempt.recovered companion, and unstored facts are complete.
    const aggregateSeq = nextAggregateSeq(0, entries)
    const recorded = fact.payload.control.aggregateSeq
    const prunedTail = fact.type === "workflow.control.initialized" && entries.at(-1)?.seq !== null && aggregateSeq < recorded
    if (recorded !== aggregateSeq && !prunedTail) {
      throw new Error(`Workflow control replay rejected sequence ${fact.payload.control.aggregateSeq}; expected ${aggregateSeq}`)
    }
    const control = workflowRootControl(fact)
    return validateControl ? parseCommittedWorkflowControl(control) : control
  }
  if (roots.length > 0) throw new Error("Workflow control replay rejected repeated workflow control root")

  const terminals = facts.filter(({ type }) => type === "workflow.control.committed")
  if (terminals.length === 0) {
    if (facts.some(({ type }) => controlFactTypes.has(type))) {
      throw new Error("Workflow control replay requires a terminal workflow.control.committed fact")
    }
    const next = { ...previous, aggregateSeq: nextAggregateSeq(previous.aggregateSeq, entries) }
    return validateControl ? parseCommittedWorkflowControl(next) : next
  }
  const terminal = facts.at(-1)
  if (terminals.length !== 1 || terminal?.type !== "workflow.control.committed") {
    throw new Error("Workflow control replay requires one terminal workflow.control.committed fact")
  }

  const event = committedWorkflowEvent(terminal)
  const replayed = transitionDecodedWorkflow(replayDecodedWorkflow(previous), event, terminal.version)
  const pending = replayed.state.context.pending
  if (replayed.command.kind !== "commit" || !pending) {
    throw new Error(`Workflow control replay rejected ${terminal.payload.event.type} while ${previous.status}`)
  }
  if (replayed.command.proposal.proposalId !== terminal.payload.proposalId) {
    throw new Error(`Workflow control replay rejected proposal identity "${terminal.payload.proposalId}"`)
  }
  validateProposalFacts(entries, replayed.command.proposal.facts)
  return {
    ...pending.proposedCommitted,
    aggregateSeq: nextAggregateSeq(previous.aggregateSeq, entries),
  }
}

function parseFacts(
  facts: readonly unknown[],
  expectedStart: number,
): ParsedWorkflowStream {
  const sequences = facts.map(storedSeq)
  const allStored = sequences.every((seq): seq is number => seq !== null)
  if (allStored) {
    let previousSeq = expectedStart - 1
    for (const seq of sequences) {
      if (seq < expectedStart || seq <= previousSeq) {
        throw new Error(`Workflow control replay rejected stored sequence ${seq}; expected an ordered sequence at or after ${expectedStart}`)
      }
      previousSeq = seq
    }
  } else if (sequences.some((seq) => seq !== null)) {
    throw new Error("Workflow control replay rejected mixed stored and unstored facts")
  }
  return {
    facts: facts.map((fact, index) => ({
      fact: allStored ? storedControlOrCompanion(fact) : strictControlOrCompanion(factEnvelope(fact)),
      seq: sequences[index] ?? null,
    })),
  }
}

/** Decode a stored control fact strictly. Known companions and other families keep only
 *  its type and position: its body is display, context, or request evidence,
 *  which the owning projection decodes and salvages. The workflow aggregate
 *  also holds the session facts of workflow-owned requests, a family this
 *  layer does not own. Their unreadable bodies never stop a run (ARCH-SUBSTRATE-013).
 *  An unreadable control fact or unknown workflow-family type fails. */
function storedControlOrCompanion(value: unknown): WorkflowControlFact | WorkflowCompanionEnvelope {
  if (value instanceof CorruptEventRowError) {
    if (controlFactTypes.has(value.row.type) || isUnknownWorkflowFamilyType(value.row.type)) throw value
    return companionEnvelope(value.row.type)
  }
  const envelope = factEnvelope(value)
  if (controlFactTypes.has(envelope.type)) return parseWorkflowControlFact(envelope)
  return companionEnvelope(envelope.type)
}

function companionEnvelope(type: string): WorkflowCompanionEnvelope {
  if (isUnknownWorkflowFamilyType(type)) throw new Error(`Workflow control replay rejected unknown workflow-family fact type "${type}"`)
  return { type: isFamilyCompanionType(type) ? type : OTHER_FAMILY, companion: true }
}

/** Whether a stored type occupies a workflow-owned namespace without a registered codec. */
export function isUnknownWorkflowFamilyType(type: string): boolean {
  return !workflowFamilyTypes.has(type) && workflowFamilyPrefixes.some((prefix) => type.startsWith(prefix))
}

function isFamilyCompanionType(type: string): type is Exclude<WorkflowCompanionEnvelope["type"], typeof OTHER_FAMILY> {
  return workflowFamilyTypes.has(type) && !controlFactTypes.has(type)
}

/** Facts that no store positioned, such as a batch a writer composes, carry
 *  no history to salvage, so every body parses strictly. */
function strictControlOrCompanion(envelope: ParsedFactEnvelope): WorkflowControlFact | WorkflowCompanionEnvelope {
  const fact = parseWorkflowSessionFact(envelope)
  return isControlFact(fact) ? fact : { type: fact.type, companion: true }
}

function isControlFact(fact: WorkflowSessionFact): fact is WorkflowControlFact {
  return controlFactTypes.has(fact.type)
}

function storedSeq(value: unknown): number | null {
  if (value instanceof CorruptEventRowError) return value.row.seq
  if (!value || typeof value !== "object" || !("seq" in value)) return null
  const { seq } = value
  if (!Number.isInteger(seq) || typeof seq !== "number" || seq < 0) {
    throw new Error("Workflow control replay rejected invalid stored sequence")
  }
  return seq
}

function initialBatchLength(facts: readonly ParsedWorkflowFact[], initialEnd: number): number {
  if (facts[0]?.seq === null) {
    if (initialEnd > facts.length) throw new Error(`Workflow control replay rejected initialization sequence ${initialEnd}`)
    return initialEnd
  }
  const boundary = facts.findIndex(({ seq }) => seq !== null && seq >= initialEnd)
  return boundary < 0 ? facts.length : boundary
}

function nextAggregateSeq(previous: number, facts: readonly ParsedWorkflowFact[]): number {
  const last = facts.at(-1)
  if (!last) return previous
  return last.seq === null ? previous + facts.length : last.seq + 1
}

/** Stored sequences may be sparse because replace-only companions are pruned.
 * The retained terminal marker fixes the semantic suffix positions, so control
 * semantics remain exact while missing companions are treated as absent.
 * Stored and re-derived facts compare in one normalized shape, so a fact that a
 * historical version encoded matches its current re-derivation. */
function validateProposalFacts(
  facts: readonly ParsedWorkflowFact[],
  expectedSemanticFacts: readonly WorkflowSessionFact[],
): void {
  const terminal = facts.at(-1)
  if (!terminal) throw new Error("Workflow control replay requires proposal facts")
  if (terminal.seq === null) {
    const companionCount = facts.length - expectedSemanticFacts.length
    if (companionCount < 0) throw new Error("Workflow control replay proposal is missing semantic facts")
    if (facts.slice(0, companionCount).some(({ fact }) => controlFactTypes.has(fact.type))) {
      throw new Error("Workflow control replay rejected a control fact as a companion")
    }
    if (!sameSemanticFacts(facts.slice(companionCount).map(({ fact }) => fact), expectedSemanticFacts)) {
      throw new Error("Workflow control replay rejected proposal fact order or semantics")
    }
    return
  }

  const semanticStart = terminal.seq - expectedSemanticFacts.length + 1
  const companions = facts.filter(({ seq }) => seq !== null && seq < semanticStart)
  if (companions.some(({ fact }) => controlFactTypes.has(fact.type))) {
    throw new Error("Workflow control replay rejected a control fact as a companion")
  }
  const semantics = facts.filter(({ seq }) => seq !== null && seq >= semanticStart)
  const exactSemanticSuffix = semantics.length === expectedSemanticFacts.length
    && semantics.every((entry, index) => entry.seq === semanticStart + index)
    && sameSemanticFacts(semantics.map(({ fact }) => fact), expectedSemanticFacts)
  if (!exactSemanticSuffix) {
    throw new Error("Workflow control replay rejected sparse semantic facts")
  }
}

function sameSemanticFacts(stored: readonly ParsedWorkflowFact["fact"][], expected: readonly WorkflowSessionFact[]): boolean {
  const control = stored.filter((fact): fact is WorkflowControlFact => !("companion" in fact))
  return control.length === stored.length && isDeepStrictEqual(control.map(replayComparableFact), expected.map(replayComparableFact))
}

interface ParsedFactEnvelope {
  readonly type: string;
  readonly version: number;
  readonly actor: string;
  readonly payload: unknown;
}

function factEnvelope(value: unknown): ParsedFactEnvelope {
  if (!value || typeof value !== "object") throw new Error("Workflow control replay rejected invalid fact envelope")
  const type = "type" in value ? value.type : undefined
  const version = "version" in value ? value.version : undefined
  const actor = "actor" in value ? value.actor : undefined
  const payload = "payload" in value ? value.payload : undefined
  if (typeof type !== "string" || typeof version !== "number" || typeof actor !== "string") {
    throw new TypeError("Workflow control replay rejected invalid fact envelope")
  }
  return { type, version, actor, payload }
}
