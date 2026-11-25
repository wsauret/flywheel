import { Database } from "bun:sqlite"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWaitingSessionsProjection } from "../../../../../src/orchestration/app-service/projections/waiting-sessions-projection.js"
import { createSqliteEventStore } from "../../../../../src/infra/substrate/store/sqlite-event-store.js"
import { Log } from "../../../../../src/infra/diagnostics/log.js"
import { asAsyncEventReadSurface, StateRequestNotServedError, type AsyncEventReadSurface, type LocalSqliteEventStore, type StoredFact } from "../../../../../src/infra/substrate/store/event-store-types.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime/runtime-ui-protocol-types.js"
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js"

const opened: Array<{ readonly store: LocalSqliteEventStore; readonly directory: string }> = []

afterEach(() => {
  for (const { store, directory } of opened.splice(0)) {
    try {
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "flywheel-waiting-sessions-"))
  const path = join(directory, "flywheel.sqlite")
  const store = createSqliteEventStore(path)
  opened.push({ store, directory })
  return { store, path }
}

const QUESTIONS = [{ question: "Continue?", choices: [{ kind: "option", choiceId: "continue", label: "Yes" }], multiSelect: false }]

function requested(store: LocalSqliteEventStore, sessionId: string, interactionId: string, timestamp = 2): StoredFact {
  return store.append({ aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp, payload: { interactionId, conversationId: "conv-1", toolUseId: interactionId, request: QUESTIONS } })
}

function answered(store: LocalSqliteEventStore, sessionId: string, interactionId: string, timestamp = 3): void {
  store.append({ aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.answered", version: 3, actor: "user", timestamp, payload: { interactionId, answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "continue" }], text: "Yes" } } } })
}

function project(store: LocalSqliteEventStore, reader: AsyncEventReadSurface = asAsyncEventReadSurface(store)) {
  const patches: RuntimeUiPatchInput[] = []
  const projection = createWaitingSessionsProjection({ reader, onStored: store.onStored, bus: { publish: (patch) => { patches.push(patch) }, snapshotPosition: () => 0 } })
  const sessions = async () => (await projection.snapshot()).sessions
  const sessionIds = async () => (await sessions()).map((waiting) => waiting.sessionId)
  return { projection, patches, sessions, sessionIds }
}

describe("waiting sessions projection", () => {
  test("reads its baseline on the first request, covers a closed chat, and publishes nothing", async () => {
    const { store } = openStore()
    requested(store, "closed", "tool-1", 5)
    requested(store, "answered", "tool-2")
    answered(store, "answered", "tool-2")
    const counter = countStateRequests(asAsyncEventReadSurface(store))
    const { projection, patches, sessions } = project(store, counter.reader)
    // Construction is on the project's startup path: it reads nothing.
    expect(counter.take()).toEqual([])

    expect(await sessions()).toEqual([{ sessionId: "closed", openedAt: 5 }])
    expect(patches).toEqual([])
    projection.dispose()
  })

  test("each question fact after the baseline publishes the whole set when a session joins, leaves, or docks another question", async () => {
    const { store } = openStore()
    requested(store, "closed", "tool-1", 10)
    const { projection, patches, sessions } = project(store)
    await sessions()

    requested(store, "chat-2", "tool-2", 20)
    expect(await sessions()).toEqual([{ sessionId: "closed", openedAt: 10 }, { sessionId: "chat-2", openedAt: 20 }])
    // A second question waits behind the docked one: the set is unchanged.
    requested(store, "chat-2", "tool-3", 30)
    answered(store, "closed", "tool-1", 40)
    expect(await sessions()).toEqual([{ sessionId: "chat-2", openedAt: 20 }])
    // The answer docks the next question, which opened later.
    answered(store, "chat-2", "tool-2", 50)
    expect(await sessions()).toEqual([{ sessionId: "chat-2", openedAt: 30 }])

    const changed = (set: Array<{ sessionId: string; openedAt: number }>): RuntimeUiPatchInput => ({ cursor: { scope: "workspace", domain: "waitingSessions" }, payload: { kind: "waitingSessions.changed", sessions: set } })
    expect(patches).toEqual([
      changed([{ sessionId: "closed", openedAt: 10 }, { sessionId: "chat-2", openedAt: 20 }]),
      changed([{ sessionId: "chat-2", openedAt: 20 }]),
      changed([{ sessionId: "chat-2", openedAt: 30 }]),
    ])
    projection.dispose()
  })

  test("a question that a session asks while the baseline reads reaches the set", async () => {
    const { store } = openStore()
    requested(store, "early", "tool-1")
    const base = asAsyncEventReadSurface(store)
    const gate = Promise.withResolvers<void>()
    const paused: AsyncEventReadSurface = {
      ...base,
      // The baseline captures its ceiling, then waits while a fact lands above it.
      capturePosition: async () => {
        const position = await base.capturePosition()
        await gate.promise
        return position
      },
    }
    const { projection, sessionIds } = project(store, paused)
    const first = sessionIds()
    await Promise.resolve()
    requested(store, "late", "tool-2")
    gate.resolve()

    expect(await first).toEqual(["early", "late"])
    projection.dispose()
  })

  test("a session whose question history cannot be folded stays out, the others keep their answer, and the record carries no stored content", async () => {
    const { store, path } = openStore()
    const corrupt = requested(store, "corrupt", "tool-1")
    requested(store, "duplicate", "tool-2")
    requested(store, "duplicate", "tool-2")
    requested(store, "healthy", "tool-3")
    const later = requested(store, "later", "tool-6")
    const corruptPayload = (position: number) => {
      const db = new Database(path)
      try {
        db.query("UPDATE event SET payload = ? WHERE position = ?").run("{\"question\": storedsecret", position)
      } finally {
        db.close()
      }
    }
    corruptPayload(corrupt.position)
    const warn = spyOn(Log.create({ service: "waiting-sessions-projection" }), "warn")
    try {
      const { projection, sessionIds } = project(store)

      expect(await sessionIds()).toEqual(["healthy", "later"])
      // A later fact of a damaged session does not fail the set either.
      requested(store, "duplicate", "tool-4")
      requested(store, "other", "tool-5")
      expect(await sessionIds()).toEqual(["healthy", "later", "other"])
      // Damage found after the baseline, by the read of one session.
      corruptPayload(later.position)
      answered(store, "later", "tool-6")
      expect(await sessionIds()).toEqual(["healthy", "other"])
      projection.dispose()

      expect(warn.mock.calls.flatMap(([, fields]) => Array.isArray(fields?.sessionIds) ? fields.sessionIds : []).sort()).toEqual(["corrupt", "duplicate", "later"])
      expect(JSON.stringify(warn.mock.calls)).not.toContain("storedsecret")
    } finally {
      warn.mockRestore()
    }
  })

  test("a read that the store does not serve leaves no session out: the next request reads the set again", async () => {
    const { store } = openStore()
    requested(store, "waits", "tool-1", 5)
    const base = asAsyncEventReadSurface(store)
    let refuse = false
    const notServed = () => Promise.reject(new StateRequestNotServedError("not served"))
    const reader: AsyncEventReadSurface = {
      ...base,
      capturePosition: () => refuse ? notServed() : base.capturePosition(),
      readPage: (...args) => refuse ? notServed() : base.readPage(...args),
    }
    const warn = spyOn(Log.create({ service: "waiting-sessions-projection" }), "warn")
    try {
      const { projection, sessions } = project(store, reader)
      await sessions()

      refuse = true
      requested(store, "asks", "tool-2", 9)
      await expect(sessions()).rejects.toBeInstanceOf(StateRequestNotServedError)
      refuse = false

      expect(await sessions()).toEqual([{ sessionId: "waits", openedAt: 5 }, { sessionId: "asks", openedAt: 9 }])
      // The session whose read was refused advances again from its next fact.
      answered(store, "asks", "tool-2", 12)
      expect(await sessions()).toEqual([{ sessionId: "waits", openedAt: 5 }])
      expect(warn.mock.calls.flatMap(([, fields]) => Array.isArray(fields?.sessionIds) ? fields.sessionIds : [])).toEqual([])
      projection.dispose()
    } finally {
      warn.mockRestore()
    }
  })

  test("advancing the set reads what one change costs, whatever the session count or history length", async () => {
    async function costPerChange(sessions: number, history: number): Promise<Array<readonly [number, number]>> {
      const { store } = openStore()
      let timestamp = 1
      for (let index = 0; index < sessions; index += 1) {
        for (let turn = 0; turn < history; turn += 1) {
          requested(store, `chat-${index}`, `tool-${turn}`, timestamp++)
          answered(store, `chat-${index}`, `tool-${turn}`, timestamp++)
        }
      }
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      const { projection, sessionIds } = project(store, counter.reader)
      await sessionIds()
      // The first change to a session folds it once; later changes advance that fold.
      requested(store, "chat-0", "warm", timestamp++)
      await sessionIds()
      counter.take()
      const costs: Array<readonly [number, number]> = []
      for (let change = 0; change < 4; change += 1) {
        if (change % 2 === 0) answered(store, "chat-0", change === 0 ? "warm" : `next-${change - 1}`, timestamp++)
        else requested(store, "chat-0", `next-${change}`, timestamp++)
        expect(await sessionIds()).toEqual(change % 2 === 0 ? [] : ["chat-0"])
        const requests = counter.take()
        costs.push([requests.length, factsRead(requests)])
      }
      projection.dispose()
      return costs
    }

    const small = await costPerChange(3, 2)
    expect(small.every(([, facts]) => facts <= 1)).toBe(true)
    expect(await costPerChange(30, 2)).toEqual(small)
    expect(await costPerChange(3, 20)).toEqual(small)
  })
})
