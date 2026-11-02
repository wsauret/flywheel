import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { claimAnsweredDecision, voidUnclaimedDecisions, type DecisionClaimRequest, type VoidDecisionsRequest } from "../../../../src/orchestration/session/agent-input-decision.js"
import { parseAgentInputFact, type AgentInputDecision, type AgentInputFact } from "../../../../src/orchestration/session/agent-input-facts.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { createAgentInputCursorReader } from "../../../../src/orchestration/session/agent-input-projection.js"

const SESSION = "sess-1"
const INTERACTION = "toolu-1"
const CLAIM = "claim-1"

const launchDecision: AgentInputDecision = {
  kind: "workflow_launch",
  source: { kind: "registered", definitionId: "implement" },
  question: "Launch the Implement workflow?",
  approve: { choiceId: "approve", label: "Start the Implement workflow" },
  reject: { choiceId: "reject", label: "Implement directly" },
}
interface EventPayload {
  [key: string]: unknown
}

let position = 0
function event(type: string, payload: EventPayload): StoredFact {
  position += 1
  return {
    position,
    seq: position,
    id: `event-${position}`,
    aggregateId: `session:${SESSION}`,
    type,
    version: type === "agent_input.answered" || type === "agent_input.requested" ? 3 : 1,
    timestamp: 1_700_000_000_000 + position,
    actor: type === "agent_input.answered" || type === "agent_input.cancelled" ? "user" : "agent",
    sessionId: SESSION,
    payload,
  }
}

function requested(decision?: AgentInputDecision): StoredFact {
  return event("agent_input.requested", {
    interactionId: INTERACTION,
    conversationId: "conv-1",
    toolUseId: INTERACTION,
    request: [{ question: decision?.question ?? "Plain question?", choices: [{ kind: "option", choiceId: "approve", label: "Yes" }], multiSelect: false }],
    ...(decision ? { decision } : {}),
  })
}

function answered(text: string, choiceIds: readonly string[], question: string): StoredFact {
  return event("agent_input.answered", {
    interactionId: INTERACTION,
    answers: { [question]: choiceIds.length > 0 ? { kind: "choice", selections: choiceIds.map((choiceId) => ({ choiceId })), text } : { kind: "freeform", text } },
  })
}

function consumed(claimId: string): StoredFact {
  return event("agent_input.consumed", { interactionId: INTERACTION, claimId })
}

function claim(events: readonly StoredFact[], overrides: {
  readonly consumption?: "replayable" | "exactly-once"
  readonly verify?: (decision: AgentInputDecision) => string | undefined
  readonly recordGuarded?: DecisionClaimRequest["writer"]["recordGuarded"]
  readonly store?: DecisionClaimRequest["store"]
} = {}) {
  const appended: Array<{ fact: AgentInputFact; expectedSeq: number }> = []
  const promise = claimAnsweredDecision({
    store: overrides.store ?? asAsyncEventReadSurface(inMemoryEventReader(events)),
    writer: {
      recordGuarded: overrides.recordGuarded ?? (async (fact, expectedSeq) => {
        appended.push({ fact, expectedSeq })
        return { kind: "stored", events: [] }
      }),
    },
    sessionId: SESSION,
    interactionId: INTERACTION,
    claimId: CLAIM,
    consumption: overrides.consumption ?? "exactly-once",
    verify: overrides.verify ?? (() => undefined),
  })
  return { promise, appended }
}

describe("claiming one answered decision", () => {
  test.each(["request", "answer"] as const)("a consumed decision with a corrupted %s stays nonactionable", async (corrupted) => {
    const request = requested(launchDecision)
    const answer = answered("Start the Implement workflow", ["approve"], launchDecision.question)
    const original = claim([request, answer])
    expect(await original.promise).toEqual({ kind: "granted" })
    const consumption = original.appended[0]?.fact
    if (!consumption) throw new Error("missing consumed fact")
    const events = [
      corrupted === "request" ? { ...request, payload: { ...request.payload, request: 5 } } : request,
      corrupted === "answer" ? { ...answer, payload: { ...answer.payload, answers: { [launchDecision.question]: 5 } } } : answer,
      event(consumption.type, consumption.payload),
    ]
    const before = JSON.stringify(events)
    const recovered = await createAgentInputCursorReader(asAsyncEventReadSurface(inMemoryEventReader(events)), SESSION).replay()
    const refusal = claim(events, { consumption: "replayable" })
    expect(await refusal.promise).toEqual({
      kind: "refused",
      reason: corrupted === "request" ? { kind: "missing" } : { kind: "not-answered", state: "unreadable" },
    })
    expect(refusal.appended).toEqual([])
    const entry = recovered.entries.get(INTERACTION)
    const gaps = entry?.kind === "unreadable" ? entry.gaps : recovered.gaps
    expect(gaps.map((gap) => [gap.eventType, gap.failureClass])).toEqual(corrupted === "request"
      ? [["agent_input.requested", "decode_failure"], ["agent_input.answered", "structural_violation"], ["agent_input.consumed", "structural_violation"]]
      : [["agent_input.answered", "decode_failure"], ["agent_input.consumed", "structural_violation"]])
    expect(JSON.stringify(events)).toBe(before)
  })

  test("an affirmative definition-bound answer is claimed exactly once", async () => {
    const events = [requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question)]
    const { promise, appended } = claim(events)
    expect(await promise).toEqual({ kind: "granted" })
    expect(appended).toHaveLength(1)
    expect(appended[0]?.fact).toEqual({ type: "agent_input.consumed", version: 1, actor: "agent", payload: { interactionId: INTERACTION, claimId: CLAIM } })
    expect(appended[0]?.expectedSeq).toBe((events.at(-1)?.seq ?? -1) + 1)
  })

  test("a plain answered question approves nothing", async () => {
    const { promise, appended } = claim([requested(), answered("Yes", ["approve"], "Plain question?")])
    expect(await promise).toEqual({ kind: "refused", reason: { kind: "no-decision" } })
    expect(appended).toEqual([])
  })

  test("a decision the operation does not recognize is a mismatch", async () => {
    const events = [requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question)]
    const { promise, appended } = claim(events, { verify: () => "the description changed since it was approved" })
    expect(await promise).toEqual({ kind: "refused", reason: { kind: "mismatched", detail: "the description changed since it was approved" } })
    expect(appended).toEqual([])
  })

  test("an unanswered or cancelled question is refused", async () => {
    expect(await claim([requested(launchDecision)]).promise).toEqual({ kind: "refused", reason: { kind: "not-answered", state: "pending" } })
    const cancelled = [requested(launchDecision), event("agent_input.cancelled", { interactionId: INTERACTION, reason: "closed" })]
    expect(await claim(cancelled).promise).toEqual({ kind: "refused", reason: { kind: "not-answered", state: "cancelled" } })
    const unreadable = [requested(launchDecision), event("agent_input.answered", { interactionId: INTERACTION, answers: { [launchDecision.question]: 5 } })]
    const refused = claim(unreadable)
    expect(await refused.promise).toEqual({ kind: "refused", reason: { kind: "not-answered", state: "unreadable" } })
    expect(refused.appended).toEqual([])
  })

  test("no question at all is refused", async () => {
    expect(await claim([]).promise).toEqual({ kind: "refused", reason: { kind: "missing" } })
  })

  test("a rejecting choice and free text both refuse", async () => {
    const rejected = [requested(launchDecision), answered("Implement directly", ["reject"], launchDecision.question)]
    expect(await claim(rejected).promise).toEqual({ kind: "refused", reason: { kind: "rejected", answer: "Implement directly" } })

    const freeform = [requested(launchDecision), answered("yes go ahead", [], launchDecision.question)]
    expect(await claim(freeform).promise).toEqual({ kind: "refused", reason: { kind: "rejected", answer: "yes go ahead" } })
  })

  test("an answer that picked more than the approving choice approves nothing", async () => {
    const extra = [requested(launchDecision), answered("Start the Implement workflow", ["approve", "reject"], launchDecision.question)]
    expect(await claim(extra).promise).toEqual({ kind: "refused", reason: { kind: "rejected", answer: "Start the Implement workflow" } })

    const duplicated = [requested(launchDecision), answered("Start the Implement workflow", ["approve", "approve"], launchDecision.question)]
    expect(await claim(duplicated).promise).toEqual({ kind: "refused", reason: { kind: "rejected", answer: "Start the Implement workflow" } })
  })

  test("exactly-once consumption refuses even the same claim id", async () => {
    const events = [requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question), consumed(CLAIM)]
    expect(await claim(events).promise).toEqual({ kind: "refused", reason: { kind: "consumed" } })
    expect(await claim(events, { consumption: "replayable" }).promise).toEqual({ kind: "granted" })
  })

  test("another operation's claim is refused under both policies", async () => {
    const events = [requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question), consumed("other-claim")]
    expect(await claim(events).promise).toEqual({ kind: "refused", reason: { kind: "consumed" } })
    expect(await claim(events, { consumption: "replayable" }).promise).toEqual({ kind: "refused", reason: { kind: "consumed" } })
  })

  test("a disposed writer authorizes nothing", async () => {
    const events = [requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question)]
    const { promise } = claim(events, { recordGuarded: async () => null })
    expect(await promise).toEqual({ kind: "refused", reason: { kind: "writer-disposed" } })
  })

  test("a sequence race is retried and then reported", async () => {
    const events = [requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question)]
    let attempts = 0
    const { promise } = claim(events, {
      recordGuarded: async () => {
        attempts += 1
        if (attempts < 2) return { kind: "conflict", conflict: { aggregateId: `session:${SESSION}`, expectedSeq: 3, actualSeq: 4 } }
        return { kind: "stored", events: [] }
      },
    })
    expect(await promise).toEqual({ kind: "granted" })
    expect(attempts).toBe(2)

    let always = 0
    const contended = claim(events, {
      recordGuarded: async () => {
        always += 1
        return { kind: "conflict", conflict: { aggregateId: `session:${SESSION}`, expectedSeq: 3, actualSeq: 4 } }
      },
    })
    expect(await contended.promise).toEqual({ kind: "refused", reason: { kind: "sequence-contended" } })
    expect(always).toBe(3)
  })

  test("a delayed exact sequence read loses a concurrent write and retries from the new token", async () => {
    const events = [requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question)]
    const base = asAsyncEventReadSurface(inMemoryEventReader(events))
    const captured = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let delayFirst = true
    const store: DecisionClaimRequest["store"] = {
      ...base,
      async aggregateSeq(aggregateId) {
        const seq = await base.aggregateSeq(aggregateId)
        if (delayFirst) {
          delayFirst = false
          captured.resolve()
          await release.promise
        }
        return seq
      },
    }
    let attempts = 0
    const pending = claim(events, {
      store,
      recordGuarded: async (_fact, expectedSeq) => {
        attempts += 1
        const actualSeq = events.at(-1)?.seq ?? -1
        return expectedSeq === actualSeq + 1
          ? { kind: "stored", events: [] }
          : { kind: "conflict", conflict: { aggregateId: `session:${SESSION}`, expectedSeq, actualSeq } }
      },
    }).promise

    await captured.promise
    events.push(event("session.duration.recorded", {}))
    release.resolve()

    expect(await pending).toEqual({ kind: "granted" })
    expect(attempts).toBe(2)
  })
})

describe("voiding unclaimed decisions on user interrupt", () => {
  function voided(events: readonly StoredFact[], recordGuarded?: VoidDecisionsRequest["writer"]["recordGuarded"]) {
    const appended: Array<{ fact: AgentInputFact; expectedSeq: number }> = []
    const promise = voidUnclaimedDecisions({
      store: asAsyncEventReadSurface(inMemoryEventReader(events)),
      writer: {
        recordGuarded: recordGuarded ?? (async (fact, expectedSeq) => {
          appended.push({ fact, expectedSeq })
          return { kind: "stored", events: [] }
        }),
      },
      sessionId: SESSION,
      claimId: "voided:user-interrupt",
    })
    return { promise, appended }
  }

  test("an answered unclaimed decision is consumed by the interrupt", async () => {
    const events = [requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question)]
    const { promise, appended } = voided(events)
    expect(await promise).toEqual({ voided: [INTERACTION], unvoided: [] })
    expect(appended).toEqual([{
      fact: { type: "agent_input.consumed", version: 1, actor: "agent", payload: { interactionId: INTERACTION, claimId: "voided:user-interrupt" } },
      // The shared fixture counter advances across tests, so the guard is
      // asserted relative to the last event rather than as a literal.
      expectedSeq: (events.at(-1)?.seq ?? 0) + 1,
    }])
  })

  test("pending, cancelled, already-consumed, and plain-question interactions are left alone", async () => {
    const pending = voided([requested(launchDecision)])
    expect(await pending.promise).toEqual({ voided: [], unvoided: [] })
    expect(pending.appended).toEqual([])

    const cancelled = voided([requested(launchDecision), event("agent_input.cancelled", { interactionId: INTERACTION, reason: "closed" })])
    expect(await cancelled.promise).toEqual({ voided: [], unvoided: [] })
    expect(cancelled.appended).toEqual([])

    const alreadyConsumed = voided([requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question), consumed("other-claim")])
    expect(await alreadyConsumed.promise).toEqual({ voided: [], unvoided: [] })
    expect(alreadyConsumed.appended).toEqual([])

    const plain = voided([requested(), answered("Yes", ["approve"], "Plain question?")])
    expect(await plain.promise).toEqual({ voided: [], unvoided: [] })
    expect(plain.appended).toEqual([])
  })

  test("a persistently contended void is reported as unvoided, not thrown", async () => {
    const events = [requested(launchDecision), answered("Start the Implement workflow", ["approve"], launchDecision.question)]
    let attempts = 0
    const { promise } = voided(events, async () => {
      attempts += 1
      return { kind: "conflict", conflict: { aggregateId: `session:${SESSION}`, expectedSeq: 3, actualSeq: 4 } }
    })
    expect(await promise).toEqual({ voided: [], unvoided: [INTERACTION] })
    expect(attempts).toBe(3)
  })
})

describe("strict agent_input facts", () => {
  test("current numeric answers are rejected by the strict fact parser", () => {
    const malformed = event("agent_input.answered", { interactionId: INTERACTION, answers: { Q: 5 } })
    expect(() => parseAgentInputFact({ type: malformed.type, version: malformed.version, actor: malformed.actor, payload: malformed.payload })).toThrow()
  })

  const { source: _source, ...launchQuestion } = launchDecision
  const payloadWith = (decision: EventPayload) => ({ interactionId: INTERACTION, conversationId: "conv-1", toolUseId: INTERACTION, request: [], decision })

  // The migration converts the earlier binding by a top-level id. The current
  // reader accepts only the current shape, at either version.
  test.each([2, 3])("the parser refuses a version %i request that binds a launch by a top-level id", (version) => {
    const payload = payloadWith({ ...launchQuestion, workflowDefinitionId: "implement" })
    expect(() => parseAgentInputFact({ type: "agent_input.requested", version, actor: "agent", payload })).toThrow()
  })

  test("an undeclared decision field fails loudly", () => {
    const payload = payloadWith({ ...launchDecision, invented: true })
    expect(() => parseAgentInputFact({ type: "agent_input.requested", version: 3, actor: "agent", payload })).toThrow()
  })
})
