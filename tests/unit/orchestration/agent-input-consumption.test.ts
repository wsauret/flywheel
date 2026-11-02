import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { asAsyncEventReadSurface, asAsyncEventWriter, type LocalSqliteEventStore } from "../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { InvariantViolation } from "../../../src/infra/invariant.js"
import { agentInputConsumedFact } from "../../../src/orchestration/session/agent-input-facts.js"
import { loadAgentInputProjection } from "../../../src/orchestration/session/agent-input-projection.js"
import { createSessionFactWriter, type SessionFactWriter } from "../../../src/orchestration/session/session-fact-writer.js"

const SESSION = "sess-consume"
const AGGREGATE = `session:${SESSION}`

let tmpDir: string
let store: LocalSqliteEventStore
let writer: SessionFactWriter

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "flywheel-agent-input-"))
  store = createSqliteEventStore(join(tmpDir, "flywheel.sqlite"))
  writer = createSessionFactWriter({ sessionId: SESSION, writer: asAsyncEventWriter(store) })
})

afterEach(() => {
  writer.dispose()
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

const QUESTION = "Apply this global skill change?"

async function ask(interactionId: string): Promise<void> {
  await writer.record({
    type: "agent_input.requested",
    version: 3,
    actor: "agent",
    payload: {
      interactionId,
      conversationId: "conv-1",
      toolUseId: interactionId,
      request: [{ question: QUESTION, choices: [{ kind: "option", choiceId: "approve", label: "Approve" }], multiSelect: false }],
      decision: {
        kind: "global_skill_mutation",
        proposalId: "proposal-1",
        question: QUESTION,
        approve: { choiceId: "approve", label: "Approve" },
        reject: { choiceId: "reject", label: "Reject" },
      },
    },
  })
}

async function answer(interactionId: string, label: string): Promise<void> {
  await writer.record({
    type: "agent_input.answered",
    version: 3,
    actor: "user",
    payload: { interactionId, answers: { [QUESTION]: { kind: "choice", selections: [{ choiceId: "approve" }], text: label } } },
  })
}

function nextSeq(): number {
  return store.aggregateSeq(AGGREGATE) + 1
}

describe("agent_input.consumed projection", () => {
  test("refuses to fold a consumption of a question that was never answered", async () => {
    await ask("q2")
    await writer.recordGuarded(agentInputConsumedFact({ interactionId: "q2", claimId: "mutation-a" }), nextSeq())

    await expect(loadAgentInputProjection(asAsyncEventReadSurface(store), SESSION)).rejects.toThrow(InvariantViolation)
  })

  test("refuses to fold a second consumption of the same answer", async () => {
    await ask("q3")
    await answer("q3", "Approve")
    await writer.recordGuarded(agentInputConsumedFact({ interactionId: "q3", claimId: "mutation-a" }), nextSeq())
    await writer.recordGuarded(agentInputConsumedFact({ interactionId: "q3", claimId: "mutation-b" }), nextSeq())

    await expect(loadAgentInputProjection(asAsyncEventReadSurface(store), SESSION)).rejects.toThrow(InvariantViolation)
  })
})

describe("SessionFactWriter.recordGuarded", () => {
  test("refuses the claim when another fact took the expected sequence", async () => {
    await ask("q4")
    await answer("q4", "Approve")
    const expectedSeq = nextSeq()
    // An unrelated session fact wins the race.
    await writer.record({ type: "agent_input.cancelled", version: 1, actor: "user", payload: { interactionId: "q4", reason: "superseded" } })

    await expect(writer.recordGuarded(agentInputConsumedFact({ interactionId: "q4", claimId: "mutation-a" }), expectedSeq))
      .resolves.toMatchObject({ kind: "conflict" })
  })

  test("lets exactly one of two concurrent claimants win the same sequence", async () => {
    await ask("q5")
    await answer("q5", "Approve")
    const expectedSeq = nextSeq()

    const outcomes = await Promise.allSettled([
      writer.recordGuarded(agentInputConsumedFact({ interactionId: "q5", claimId: "mutation-a" }), expectedSeq),
      writer.recordGuarded(agentInputConsumedFact({ interactionId: "q5", claimId: "mutation-b" }), expectedSeq),
    ])

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true)
    const values = outcomes.flatMap((outcome) => outcome.status === "fulfilled" && outcome.value ? [outcome.value.kind] : [])
    expect(values.toSorted()).toEqual(["conflict", "stored"])
  })

  test("never joins an unguarded transaction batch", async () => {
    await ask("q6")
    await answer("q6", "Approve")

    let claim: Promise<unknown> | undefined
    await writer.transaction(() => {
      claim = writer.recordGuarded(agentInputConsumedFact({ interactionId: "q6", claimId: "mutation-a" }), nextSeq())
    })

    await expect(claim).rejects.toThrow("cannot join a transaction batch")
  })
})
