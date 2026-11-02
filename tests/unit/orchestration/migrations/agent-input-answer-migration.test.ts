import { afterEach, describe, expect, it, test } from "bun:test";
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, type EventPayload } from "../../../../src/infra/event-store-types.js"
import { migrateAgentInputAnswers } from "../../../../src/orchestration/migrations/agent-input-answer.js"
import { recordChecked } from "../../../../src/orchestration/migrations/engine.js"
import { claimAnsweredDecision } from "../../../../src/orchestration/session/agent-input-decision.js"
import { parseAgentInputFact, type AgentInputDecision } from "../../../../src/orchestration/session/agent-input-facts.js"
import { validAgentInputAnswers } from "../../../../src/orchestration/app-service/session-runtime-actor-helpers.js"
import { loadAgentInputProjection } from "../../../../src/orchestration/session/agent-input-projection.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { testDirectories } from "../../../helpers/directories.js"
interface UnknownObject {
  [key: string]: unknown
}

const tmpRoot = path.join(os.tmpdir(), `flywheel-agent-input-answer-migration-${process.pid}-${Date.now()}`)

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

describe("migrateAgentInputAnswers", () => {
  it("migrates v1 freeform and v2 choice IDs into v3 selections", () => {
    const dbFile = makeDbFile()
    seed(dbFile, 1, legacyAnswered())
    seed(dbFile, 2, currentAnswered())
    const before = eventRows(dbFile)

    expect(migrateAgentInputAnswers(dbFile)).toEqual({ repaired: 2 })

    const after = eventRows(dbFile)
    expect(withoutVersionAndPayload(after[0]!)).toEqual(withoutVersionAndPayload(before[0]!))
    expect(after[0]?.version).toBe(3)
    expect(JSON.parse(after[0]?.payload ?? "{}")).toEqual({
      interactionId: "ask-1",
      answers: {
        "Continue?": { kind: "freeform", text: "Yes" },
        "Apply this global skill change?": { kind: "freeform", text: "Approve the global skill change" },
      },
    })
    expect(after[1]?.version).toBe(3)
    expect(JSON.parse(after[1]?.payload ?? "{}")).toEqual({
      interactionId: "ask-2",
      answers: {
        "Apply this global skill change?": {
          kind: "choice",
          selections: [{ choiceId: "approve" }],
          text: "Approve the global skill change",
        },
      },
    })
  })

  it("is idempotent", () => {
    const dbFile = makeDbFile()
    seed(dbFile, 1, legacyAnswered())
    migrateAgentInputAnswers(dbFile)
    const afterFirst = eventRows(dbFile)

    expect(migrateAgentInputAnswers(dbFile)).toEqual({ repaired: 0 })
    expect(eventRows(dbFile)).toEqual(afterFirst)
  })

  it("preserves malformed legacy payloads while upgrading healthy answers", () => {
    const dbFile = makeDbFile()
    seed(dbFile, 1, legacyAnswered())
    seed(dbFile, 1, { interactionId: "ask-2", answers: { "Continue?": { kind: "freeform", text: "Yes" } } })
    seed(dbFile, 1, { interactionId: "ask-3", answers: { Q: 5 } })
    seed(dbFile, 2, { interactionId: "ask-4", answers: { Q: 5 } })
    seed(dbFile, 2, currentAnswered())
    const before = eventRows(dbFile)

    expect(migrateAgentInputAnswers(dbFile)).toEqual({ repaired: 2 })
    const after = eventRows(dbFile)
    expect(after.slice(1, 4)).toEqual(before.slice(1, 4))
    expect(after[0]?.version).toBe(3)
    expect(after[4]?.version).toBe(3)
    expect(migrationFacts(dbFile)).toEqual([{ migrationId: "agent-input-contract-v4", factTypes: ["agent_input.answered"], repaired: 2 }])
    expect(migrateAgentInputAnswers(dbFile)).toEqual({ repaired: 0 })
    expect(eventRows(dbFile)).toEqual(after)
  })

  it("preserves legacy envelopes with the wrong stored actor", () => {
    const dbFile = makeDbFile()
    seed(dbFile, 1, legacyAnswered(), "agent")
    seed(dbFile, 2, currentAnswered(), "agent")
    seedRequested(dbFile, {
      interactionId: "ask-1",
      conversationId: "conversation-1",
      toolUseId: "ask-1",
      request: [{ question: "Continue?", choices: [{ kind: "option", label: "Yes" }], multiSelect: false }],
    }, "user")
    const before = eventRows(dbFile)

    expect(migrateAgentInputAnswers(dbFile)).toEqual({ repaired: 0 })
    expect(eventRows(dbFile).slice(0, before.length)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
    const after = eventRows(dbFile)
    expect(migrateAgentInputAnswers(dbFile)).toEqual({ repaired: 0 })
    expect(eventRows(dbFile)).toEqual(after)
  })

  it("preserves a legacy request with an unknown decision shape", () => {
    const dbFile = makeDbFile()
    seedRequested(dbFile, {
      interactionId: "ask-1",
      conversationId: "conversation-1",
      toolUseId: "ask-1",
      request: [{ question: "Continue?", choices: [{ kind: "option", label: "Yes" }], multiSelect: false }],
      decision: { kind: "unknown" },
    })
    const before = eventRows(dbFile)

    expect(migrateAgentInputAnswers(dbFile)).toEqual({ repaired: 0 })
    expect(eventRows(dbFile).slice(0, before.length)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("makes the migrated fact readable by the strict interaction parser", () => {
    const directories = testDirectories(path.join(tmpRoot, crypto.randomUUID()))
    const seeded = prepareWorkspaceState(directories)
    const dbFile = seeded.dbFile
    const store = createSqliteEventStore(dbFile)
    try {
      store.append({ aggregateId: "session:legacy", type: "agent_input.answered", version: 1, timestamp: 1, actor: "user", sessionId: "legacy", payload: legacyAnswered() })
    } finally {
      store.close()
      seeded.generation.release()
    }

    const migrated = prepareWorkspaceState(directories)
    const reopened = createSqliteEventStore(dbFile)
    try {
      const [event] = reopened.read({ aggregateId: "session:legacy" })
      const fact = parseAgentInputFact({ type: event?.type, version: event?.version, actor: event?.actor, payload: event?.payload })
      expect(fact.type).toBe("agent_input.answered")
      expect(fact.type === "agent_input.answered" ? fact.payload.answers["Continue?"] : null).toEqual({ kind: "freeform", text: "Yes" })
    } finally {
      reopened.close()
      migrated.generation.release()
    }
  })

  it("upgrades a pending v1 request and accepts a named v3 answer", async () => {
    const directories = testDirectories(path.join(tmpRoot, crypto.randomUUID()))
    const seeded = prepareWorkspaceState(directories)
    const store = createSqliteEventStore(seeded.dbFile)
    store.append({
      aggregateId: "session:legacy-request",
      type: "agent_input.requested",
      version: 1,
      timestamp: 1,
      actor: "agent",
      sessionId: "legacy-request",
      payload: {
        interactionId: "ask-old",
        conversationId: "conversation-old",
        toolUseId: "ask-old",
        request: [{
          question: "Continue?",
          choices: [
            { kind: "option", label: "Yes" },
            { kind: "option", choiceId: "stop", label: "No" },
            { kind: "freeform", label: "Other" },
          ],
          multiSelect: false,
        }],
      },
    })
    store.close()
    seeded.generation.release()

    const migrated = prepareWorkspaceState(directories)
    const reopened = createSqliteEventStore(migrated.dbFile)
    try {
      const pending = (await loadAgentInputProjection(asAsyncEventReadSurface(reopened), "legacy-request")).get("ask-old")
      expect(pending?.kind).toBe("pending")
      if (!pending || pending.kind !== "pending") throw new Error("request did not remain pending")
      expect(pending.request[0]?.choices).toEqual([
        { kind: "option", choiceId: "choice-1", label: "Yes" },
        { kind: "option", choiceId: "stop", label: "No" },
        { kind: "freeform", label: "Other" },
      ])
      expect(validAgentInputAnswers(pending, { "Continue?": { kind: "choice", selections: [{ choiceId: "choice-1" }], text: "Yes" } })).toBe(true)
    } finally {
      reopened.close()
      migrated.generation.release()
    }
  })

  test.each([1, 2])("converts a version %i request that binds a launch by a top-level id into a registered source", (version) => {
    const dbFile = makeDbFile()
    seedRequested(dbFile, earlierLaunchRequest(), "agent", version)

    expect(migrateAgentInputAnswers(dbFile)).toEqual({ repaired: 1 })

    const [row] = eventRows(dbFile)
    expect(row?.version).toBe(3)
    expect(JSON.parse(row?.payload ?? "{}")).toEqual({ ...earlierLaunchRequest(), decision: launchDecision })
    expect(parseAgentInputFact({ type: row?.type, version: row?.version, actor: row?.actor, payload: JSON.parse(row?.payload ?? "{}") }).type).toBe("agent_input.requested")
  })

  it("converts a version 2 request in a store that already ran the earlier pass", () => {
    const dbFile = makeDbFile()
    seedRequested(dbFile, earlierLaunchRequest(), "agent", 2)
    const db = new Database(dbFile)
    try {
      recordChecked(db, "agent-input-contract-v3")
    } finally {
      db.close()
    }

    expect(migrateAgentInputAnswers(dbFile)).toEqual({ repaired: 1 })
    expect(eventRows(dbFile)[0]?.version).toBe(3)
  })

  it("lets a migrated version 2 launch question still grant the launch it approved", async () => {
    const directories = testDirectories(path.join(tmpRoot, crypto.randomUUID()))
    const seeded = prepareWorkspaceState(directories)
    const store = createSqliteEventStore(seeded.dbFile)
    store.append({ aggregateId: "session:legacy-launch", type: "agent_input.requested", version: 2, timestamp: 1, actor: "agent", sessionId: "legacy-launch", payload: earlierLaunchRequest() })
    store.append({
      aggregateId: "session:legacy-launch", type: "agent_input.answered", version: 3, timestamp: 2, actor: "user", sessionId: "legacy-launch",
      payload: { interactionId: "ask-launch", answers: { [launchDecision.question]: { kind: "choice", selections: [{ choiceId: "approve" }], text: "Start the Implement workflow" } } },
    })
    store.close()
    seeded.generation.release()

    const migrated = prepareWorkspaceState(directories)
    const reopened = createSqliteEventStore(migrated.dbFile)
    try {
      let seen: AgentInputDecision | undefined
      const claim = await claimAnsweredDecision({
        store: asAsyncEventReadSurface(reopened),
        writer: { recordGuarded: async () => ({ kind: "stored", events: [] }) },
        sessionId: "legacy-launch",
        interactionId: "ask-launch",
        claimId: "claim-1",
        consumption: "exactly-once",
        verify: (decision) => { seen = decision; return undefined },
      })
      expect(claim).toEqual({ kind: "granted" })
      expect(seen).toEqual(launchDecision)
    } finally {
      reopened.close()
      migrated.generation.release()
    }
  })
})

const launchDecision = {
  kind: "workflow_launch",
  source: { kind: "registered", definitionId: "implement" },
  question: "Launch the Implement workflow?",
  approve: { choiceId: "approve", label: "Start the Implement workflow" },
  reject: { choiceId: "reject", label: "Implement directly" },
} as const satisfies AgentInputDecision

/** A launch question as versions 1 and 2 recorded it: the workflow is bound
 *  by a top-level id, with the whole-intent fields of a still earlier build. */
function earlierLaunchRequest(): UnknownObject {
  const { source: _source, ...question } = launchDecision
  return {
    interactionId: "ask-launch",
    conversationId: "conversation-1",
    toolUseId: "ask-launch",
    request: [{ question: launchDecision.question, choices: [{ kind: "option", choiceId: "approve", label: "Start the Implement workflow" }, { kind: "option", choiceId: "reject", label: "Implement directly" }], multiSelect: false }],
    decision: { ...question, workflowDefinitionId: "implement", summary: "Ship the parser", descriptionSha256: "a".repeat(64), definitionSha256: "b".repeat(64) },
  }
}

interface EventRow {
  position: number
  id: string
  aggregateId: string
  seq: number
  type: string
  actor: string
  version: number
  payload: string
}

function legacyAnswered(): UnknownObject {
  return {
    interactionId: "ask-1",
    answers: {
      "Continue?": "Yes",
      "Apply this global skill change?": "Approve the global skill change",
    },
  }
}

function currentAnswered(): UnknownObject {
  return {
    interactionId: "ask-2",
    answers: { "Apply this global skill change?": { kind: "choice", choiceIds: ["approve"], text: "Approve the global skill change" } },
  }
}

function makeDbFile(): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "flywheel.sqlite")
}

function seed(dbFile: string, version: number, payload: EventPayload, actor = "user"): void {
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({ aggregateId: "session:s-1", type: "agent_input.answered", version, timestamp: 1, actor, sessionId: "s-1", payload })
  } finally {
    store.close()
  }
}

function seedRequested(dbFile: string, payload: EventPayload, actor = "agent", version = 1): void {
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({ aggregateId: "session:s-1", type: "agent_input.requested", version, timestamp: 1, actor, sessionId: "s-1", payload })
  } finally {
    store.close()
  }
}

function eventRows(dbFile: string): EventRow[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<EventRow, []>(`
      select position, id, aggregate_id as aggregateId, seq, type, actor, version, payload
      from event order by position
    `).all()
  } finally {
    db.close()
  }
}

function withoutVersionAndPayload(row: EventRow): Omit<EventRow, "version" | "payload"> {
  const { version: _version, payload: _payload, ...identity } = row
  return identity
}

function migrationFacts(dbFile: string): UnknownObject[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<{ payload: string }, []>(
      "select payload from event where type = 'workspace.facts.migrated' order by position",
    ).all().map(({ payload }) => JSON.parse(payload))
  } finally {
    db.close()
  }
}
