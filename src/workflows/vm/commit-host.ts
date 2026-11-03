import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { parseProjectionFact } from "../../infra/event-projection.js"
import { errorMessage } from "../../infra/error-message.js"
import {
  CorruptEventRowError,
  requireGuardedEventAppender,
  type AsyncEventWriter,
  type AsyncEventStateReadSurface,
  type GuardedAppendResult,
  type GuardedEventStoreAppend,
  type StoredFact,
} from "../../infra/event-store-types.js"
import type { ProjectDefinitionRegistryRevision } from "../definition-registry.js"
import type { WorkflowDefinition } from "../workflow-schema.js"
import type { WorkflowMutation, WorkflowTransitionResult } from "./commands.js"
import type { WorkflowMachineState } from "./control-types.js"
import type { WorkflowEvent } from "./events.js"
import type { CommittedWorkflowControl } from "./committed-control.js"
import { replayWorkflowControl, replayWorkflowControlFrom } from "./fact-fold.js"
import { continueWorkflowReplay } from "./replay.js"
import { selectNewestWorkflowRoot } from "../workflow-root.js"
import { WorkflowMalformedStateError } from "./host-types.js"
import { parseWorkflowSessionFact, workflowAggregateId } from "./session-facts.js"
import { continueCommittedWorkflow, transitionDecodedWorkflow } from "./transition.js"

const IdSchema = Schema.NonEmptyString
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

type WorkflowCommitProposal = Extract<WorkflowMutation, { kind: "commit" }>["proposal"]

export class WorkflowCommitConflictError extends Schema.TaggedError<WorkflowCommitConflictError>()(
  "WorkflowCommitConflictError",
  {
    proposalId: IdSchema,
    aggregateId: IdSchema,
    expectedSeq: NonNegativeIntSchema,
    actualSeq: NonNegativeIntSchema,
    cause: Schema.Unknown,
  },
) {}

export class WorkflowCommitStorageError extends Schema.TaggedError<WorkflowCommitStorageError>()(
  "WorkflowCommitStorageError",
  { proposalId: IdSchema, message: Schema.NonEmptyString },
) {}

interface WorkflowCommitHostDeps {
  readonly sessionId: string
  readonly definitionRevision: ProjectDefinitionRegistryRevision
  readonly workflow: WorkflowDefinition
  readonly writer: AsyncEventWriter
  readonly reader: AsyncEventStateReadSurface
  readonly commitBatch?: (events: readonly GuardedEventStoreAppend[]) => Promise<GuardedAppendResult>
  readonly now?: () => number
}

interface CommitOrReplayInput {
  readonly snapshot: WorkflowMachineState
  readonly event: WorkflowEvent
  readonly proposal: WorkflowCommitProposal
  readonly applyStoredFacts: (events: readonly StoredFact[]) => void | Promise<void>
  readonly onCommitted?: (events: readonly StoredFact[]) => void | Promise<void>
}

export interface WorkflowCommitResult extends WorkflowTransitionResult {
  readonly publication: "committed" | "replayed"
}

export interface WorkflowCommitHost {
  commit(proposal: WorkflowCommitProposal): Promise<StoredFact[]>
  commitOrReplay(input: CommitOrReplayInput): Promise<WorkflowCommitResult>
}

/** Own the awaited SQLite commit boundary while leaving transition selection in the pure VM. */
export function createWorkflowCommitHost(deps: WorkflowCommitHostDeps): WorkflowCommitHost {
  const aggregateId = workflowAggregateId(deps.sessionId)

  const commit = async (proposal: WorkflowCommitProposal): Promise<StoredFact[]> => {
    const timestamp = (deps.now ?? Date.now)()
    const appends: GuardedEventStoreAppend[] = proposal.facts.map((fact, index) => ({
      aggregateId,
      sessionId: deps.sessionId,
      timestamp,
      type: fact.type,
      version: fact.version,
      actor: fact.actor,
      payload: fact.payload,
      ...(index === 0 ? { expectedSeq: proposal.expectedSeq } : {}),
    }))
    let result: GuardedAppendResult
    try {
      result = await (deps.commitBatch
        ? deps.commitBatch(appends)
        : requireGuardedEventAppender(deps.writer, "Workflow commits require guarded append authority").appendBatchGuarded(appends))
    } catch (error) {
      throw new WorkflowCommitStorageError({ proposalId: proposal.proposalId, message: errorMessage(error) })
    }
    if (result.kind === "stored") return [...result.events]
    throw new WorkflowCommitConflictError({
      proposalId: proposal.proposalId,
      ...result.conflict,
      cause: result.conflict,
    })
  }

  const commitOrReplay = async (input: CommitOrReplayInput): Promise<WorkflowCommitResult> => {
    let stored: StoredFact[]
    try {
      stored = await commit(input.proposal)
    } catch (error) {
      if (!(error instanceof WorkflowCommitConflictError)) throw error
      const pending = input.snapshot.context.pending
      if (!pending || pending.expectedSeq !== input.proposal.expectedSeq) {
        throw new Error("Workflow conflict replay requires the proposal's committed prefix", { cause: error })
      }
      const captured = await deps.reader.readSlice({ aggregateId, fromSeq: input.proposal.expectedSeq }, true)
      const root = selectNewestWorkflowRoot(captured.facts)
      let facts: StoredFact[]
      let replayed: CommittedWorkflowControl
      try {
        facts = captured.facts.slice(root?.index ?? 0).map((fact) => {
          if (fact instanceof CorruptEventRowError) throw fact
          return fact
        })
        replayed = root
          ? replayWorkflowControl(facts)
          : replayWorkflowControlFrom(pending.previousCommitted, facts)
      } catch (cause) {
        throw new WorkflowMalformedStateError({
          sessionId: deps.sessionId,
          message: `Workflow session ${deps.sessionId} has malformed durable state: ${errorMessage(cause)}`,
        })
      }
      // SAFETY: The retained suffix starts at the selected stored root.
      const rootFact = root ? parseProjectionFact(facts[0]!, parseWorkflowSessionFact) : null
      const rootEnd = rootFact?.type === "workflow.control.initialized" || rootFact?.type === "workflow.control.recovered"
        ? rootFact.payload.control.aggregateSeq : 0
      const bootstrap = facts.filter((fact) => fact.seq < rootEnd)
      if (bootstrap.length > 0) await input.applyStoredFacts(bootstrap)
      let batch: StoredFact[] = []
      for (const fact of facts) {
        if (fact.seq < rootEnd) continue
        batch.push(fact)
        if (fact.type === "workflow.control.committed") {
          await input.applyStoredFacts(batch)
          await input.onCommitted?.(batch)
          batch = []
        }
      }
      if (batch.length > 0) await input.applyStoredFacts(batch)
      if (root) return { publication: "replayed", ...await continueWorkflowReplay(replayed, input.event, deps) }
      const proposedTerminal = input.proposal.facts.at(-1)
      const matchingCommit = proposedTerminal?.type === "workflow.control.committed" ? facts.find((fact) => {
        if (fact.type !== "workflow.control.committed") return false
        const committed = parseWorkflowSessionFact({ type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload })
        return committed.type === "workflow.control.committed"
          && committed.payload.proposalId === input.proposal.proposalId
          && isDeepStrictEqual(committed.payload.event, proposedTerminal.payload.event)
      }) : undefined
      if (matchingCommit) {
        if (facts.at(-1) === matchingCommit && matchingCommit.seq + 1 === pending.proposedCommitted.aggregateSeq) {
          return { publication: "replayed", ...transitionDecodedWorkflow(input.snapshot, {
            type: "COMMIT_SUCCEEDED",
            proposalId: input.proposal.proposalId,
            aggregateSeq: matchingCommit.seq + 1,
          }) }
        }
        return { publication: "replayed", ...continueCommittedWorkflow(replayed) }
      }
      return { publication: "replayed", ...await continueWorkflowReplay(replayed, input.event, deps) }
    }

    await input.applyStoredFacts(stored)
    const final = stored.at(-1)
    if (!final) throw new WorkflowCommitStorageError({
      proposalId: input.proposal.proposalId,
      message: "Workflow commit returned no stored events",
    })
    await input.onCommitted?.(stored)
    return { publication: "committed", ...transitionDecodedWorkflow(input.snapshot, {
      type: "COMMIT_SUCCEEDED",
      proposalId: input.proposal.proposalId,
      aggregateSeq: final.seq + 1,
    }) }
  }

  return { commit, commitOrReplay }
}
