/** The one guarded claimant of an answered typed decision.
 *
 *  Two surfaces need the same authority: a global managed-skill mutation and a
 *  model-originated workflow launch. Both read the answered interaction from the
 *  session aggregate, verify that the recorded binding matches the intent the
 *  operation carries, verify that the user picked the declared approving choice,
 *  and then append one `agent_input.consumed` fact under an expected-sequence
 *  guard. The claim is the durable authority, so there is no approval table, no
 *  in-memory token set, and no per-surface consumed marker.
 *
 *  The two surfaces differ only in consumption policy. A global skill mutation is
 *  crash-idempotent: its claim id names the operation, so re-reading its own
 *  claim is a replay of the same work. A workflow launch is not idempotent: any
 *  consumed claim, including the same tool-call id after a publication failure,
 *  is refused, because the second launch would be a second workflow.
 *
 *  Refusals are returned as typed reasons, not prose: each caller renders the
 *  wording its own surface promises the model. */

import type { AsyncEventStateReadSurface, GuardedAppendResult } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { AgentInputAnswer } from "../../protocol/question-protocol-types.js"
import type { AgentInputDecision, AgentInputFact } from "./agent-input-facts.js"
import { agentInputConsumedFact } from "./agent-input-facts.js"
import { loadAgentInputProjection, type AgentInputEntry } from "./agent-input-projection.js"

const log = Log.create({ service: "agent-input-decision" })

/** Sequence races are lost to unrelated session facts, so the claim rereads and
 *  retries a bounded number of times rather than appending a claim it could not
 *  see the state of. */
const CLAIM_ATTEMPTS = 3

export type DecisionRefusal =
  | { readonly kind: "missing" }
  | { readonly kind: "not-answered"; readonly state: "pending" | "cancelled" | "withdrawn" | "unreadable" }
  | { readonly kind: "no-decision" }
  /** The recorded binding does not match this operation's intent. */
  | { readonly kind: "mismatched"; readonly detail: string }
  | { readonly kind: "rejected"; readonly answer: string }
  | { readonly kind: "consumed" }
  | { readonly kind: "writer-disposed" }
  | { readonly kind: "sequence-contended" }

export type DecisionClaim =
  | { readonly kind: "granted" }
  | { readonly kind: "refused"; readonly reason: DecisionRefusal }

export interface DecisionClaimRequest {
  readonly store: AsyncEventStateReadSurface
  /** Guarded append side of the session aggregate. A falsy result means the
   *  writer is disposed and wrote nothing. */
  readonly writer: { recordGuarded(fact: AgentInputFact, expectedSeq: number): Promise<GuardedAppendResult | null> }
  readonly sessionId: string
  readonly interactionId: string
  /** Identity of the operation consuming this answer, recorded as the claim. */
  readonly claimId: string
  /** `replayable`: this claim id may re-read its own consumed answer, so a
   *  crash-interrupted idempotent operation finishes. `exactly-once`: any
   *  consumed claim is refused. */
  readonly consumption: "replayable" | "exactly-once"
  /** Why the recorded decision does not match this operation's intent, or
   *  undefined when it does. A wrong decision kind is a mismatch. The interaction
   *  the answer belongs to is supplied, so a caller that binds a conversation
   *  checks it against the request fact instead of duplicating it in the
   *  decision. */
  readonly verify: (decision: AgentInputDecision, interaction: { readonly conversationId: string }) => string | undefined
}

export type DecisionInspectionRequest = Omit<DecisionClaimRequest, "writer">

/** Checks whether an answer is claimable without consuming it. A caller uses
 *  this before reversible preflight work, then uses claimAnsweredDecision at
 *  the irreversible boundary. The claim repeats every check under its guarded
 *  append, so a concurrent claimant cannot pass through this inspection. */
export async function inspectAnsweredDecision(request: DecisionInspectionRequest): Promise<DecisionClaim> {
  const entry = (await loadAgentInputProjection(request.store, request.sessionId)).get(request.interactionId)
  return assessDecisionEntry(entry, request)
}

/** Claim one answered decision for this operation, or report why it cannot be
 *  claimed. A granted claim means the consumed fact is durable, so the caller may
 *  act; every refusal happens before any append. */
export async function claimAnsweredDecision(request: DecisionClaimRequest): Promise<DecisionClaim> {
  for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
    // Sequence first, projection second. Anything committed between the two
    // reads is visible to the projection or invalidates the guard, so the claim
    // is conservative: it never appends a claim it could not see the state of.
    const expectedSeq = await request.store.aggregateSeq(`session:${request.sessionId}`) + 1
    const entry = (await loadAgentInputProjection(request.store, request.sessionId)).get(request.interactionId)
    const assessment = assessDecisionEntry(entry, request)
    if (assessment.kind === "refused") return assessment
    if (entry?.kind === "answered" && entry.consumedBy !== undefined) return assessment

    const result = await request.writer.recordGuarded(
      agentInputConsumedFact({ interactionId: request.interactionId, claimId: request.claimId }),
      expectedSeq,
    )
    if (!result) return refused({ kind: "writer-disposed" })
    if (result.kind === "stored") return { kind: "granted" }
    log.info("decision claim lost a sequence race", { interactionId: request.interactionId, attempt })
  }
  return refused({ kind: "sequence-contended" })
}

function assessDecisionEntry(entry: AgentInputEntry | undefined, request: DecisionInspectionRequest): DecisionClaim {
  if (!entry) return refused({ kind: "missing" })
  if (entry.kind !== "answered") return refused({ kind: "not-answered", state: entry.kind })
  const decision = entry.decision
  if (!decision) return refused({ kind: "no-decision" })
  const mismatch = request.verify(decision, { conversationId: entry.conversationId })
  if (mismatch !== undefined) return refused({ kind: "mismatched", detail: mismatch })
  if (!approved(entry.answers[decision.question], decision.approve.choiceId)) {
    return refused({ kind: "rejected", answer: entry.answers[decision.question]?.text ?? "none" })
  }
  if (entry.consumedBy === undefined) return { kind: "granted" }
  const replay = request.consumption === "replayable" && entry.consumedBy === request.claimId
  return replay ? { kind: "granted" } : refused({ kind: "consumed" })
}

export interface VoidDecisionsRequest {
  readonly store: AsyncEventStateReadSurface
  readonly writer: { recordGuarded(fact: AgentInputFact, expectedSeq: number): Promise<GuardedAppendResult | null> }
  readonly sessionId: string
  /** Recorded as the claim id, so forensics name what voided each answer. */
  readonly claimId: string
}

/** Result of one interrupt-time void pass. `unvoided` names the answered
 *  decisions whose guarded append stayed contended after the bounded retries;
 *  those approvals remain claimable, so the caller must surface the failure
 *  rather than treat the pass as complete. */
export interface VoidDecisionsResult {
  readonly voided: readonly string[]
  readonly unvoided: readonly string[]
}

/** Consume every answered-but-unclaimed typed decision in this session.
 *
 *  The caller is a user interrupt: an approval granted inside a turn the user
 *  killed must not authorize work in a later life of the conversation, so the
 *  interrupt claims the answer first. The void reuses the one consumption
 *  authority (`agent_input.consumed`), so a later claimant is refused as
 *  `consumed` and must ask the user again; no second bookkeeping exists. */
export async function voidUnclaimedDecisions(request: VoidDecisionsRequest): Promise<VoidDecisionsResult> {
  const voided: string[] = []
  const unvoided: string[] = []
  const entries = await loadAgentInputProjection(request.store, request.sessionId)
  for (const [interactionId, entry] of entries) {
    if (entry.kind !== "answered" || !entry.decision || entry.consumedBy !== undefined) continue
    let settled = false
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
      const expectedSeq = await request.store.aggregateSeq(`session:${request.sessionId}`) + 1
      const current = (await loadAgentInputProjection(request.store, request.sessionId)).get(interactionId)
      if (!current || current.kind !== "answered" || current.consumedBy !== undefined) {
        // A competing claimant consumed it first; either way it is no longer claimable.
        settled = true
        break
      }
      const result = await request.writer.recordGuarded(
        agentInputConsumedFact({ interactionId, claimId: request.claimId }),
        expectedSeq,
      )
      if (result?.kind === "stored") {
        voided.push(interactionId)
        settled = true
        break
      }
      if (result?.kind === "conflict") log.info("decision void lost a sequence race", { interactionId, attempt })
    }
    if (!settled) unvoided.push(interactionId)
  }
  return { voided, unvoided }
}

/** Approval is exactly one declared approving choice, never text that reads like
 *  it: the answer records which declared choice ids the user picked, and free
 *  text records none. A second id, the approving id repeated, or any other id
 *  beside it is not the single affirmative choice this claim authorizes, so the
 *  claimant refuses it whatever the answering surface allowed. */
function approved(answer: AgentInputAnswer | undefined, approveChoiceId: string): boolean {
  return answer?.kind === "choice" && answer.selections.length === 1 && answer.selections[0]?.choiceId === approveChoiceId
}

function refused(reason: DecisionRefusal): DecisionClaim {
  return { kind: "refused", reason }
}
