import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { asAsyncEventAppender, asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js"
import { papercutsModule } from "../../../../../src/orchestration/modules/papercuts.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { createPapercutDisposeTool, papercutDisposeDefinition, papercutLogDefinition } from "../../../../../src/orchestration/modules/papercuts/tools.js"
import { createPapercutDispositionWriter } from "../../../../../src/orchestration/modules/papercuts/disposition-writer.js"
import type { PapercutRecordedFact } from "../../../../../src/orchestration/modules/papercuts/facts.js"

const directories: string[] = []
const openStores: Array<{ close(): void }> = []

afterEach(() => {
  // Stores first: an open database file keeps its directory undeletable on
  // Windows, so a store outliving its directory fails the teardown.
  for (const store of openStores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface ContextOverrides { readonly [key: string]: unknown }

function context(overrides: ContextOverrides = {}) {
  return {
    executionCwd: "/project",
    userDataRoot: "/scratch/test-account", projectRoot: "/project",
    artifactScopeId: "session-1",
    retrievalSessionId: "session-1",
    sessionId: "session-1",
    conversationId: "conversation-1",
    modelRequestId: "request-1",
    toolUseId: "tool-1",
    parentToolUseId: "parent-tool-1",
    ...overrides,
  }
}

function recordedFact(observation = "The search tool omitted a request-shaped fixture lookup."): PapercutRecordedFact {
  return {
    type: "papercut.recorded",
    version: 1,
    actor: "agent",
    payload: {
      observation,
      category: "missing-tooling",
      conversationId: "conversation-1",
      modelRequestId: "request-1",
      toolUseId: "tool-1",
      parentToolUseId: "parent-tool-1",
    },
  }
}

function storeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "flywheel-papercut-"))
  directories.push(directory)
  const store = createSqliteEventStore(join(directory, "events.sqlite"))
  openStores.push(store)
  return { store, writer: createPapercutDispositionWriter({ store: asAsyncEventReadSurface(store), writer: asAsyncEventAppender(store) }) }
}

function appendRecorded(store: ReturnType<typeof createSqliteEventStore>, sessionId: string, observation = "A papercut") {
  return store.append({
    aggregateId: `session:${sessionId}`,
    type: "papercut.recorded",
    version: 1,
    timestamp: Date.now(),
    actor: "agent",
    sessionId,
    payload: recordedFact(observation).payload,
  })
}

describe("papercut logging tool", () => {
  it("exposes only observation and the exact optional four-value category", () => {
    expect(papercutLogDefinition.inputSchema).toEqual({
      type: "object",
      properties: {
        observation: expect.objectContaining({ type: "string", minLength: 1 }),
        category: { type: "string", enum: ["defect", "flaky", "docs-drift", "missing-tooling"] },
      },
      required: ["observation"],
      additionalProperties: false,
    })
  })

  it("records runtime-owned causation and waits for durable acknowledgement", async () => {
    let acknowledged = false
    let captured: PapercutRecordedFact | undefined
    const result = await papercutLogDefinition.execute(
      { observation: "The fixture cannot express a request-shaped tool call.", category: "missing-tooling" },
      context({
        sessionEventWriter: {
          record: async (fact: PapercutRecordedFact) => {
            captured = fact
            await Promise.resolve()
            acknowledged = true
            return null
          },
        },
      }),
    )

    expect(acknowledged).toBe(true)
    expect(captured).toEqual(recordedFact("The fixture cannot express a request-shaped tool call."))
    expect(result).toEqual({ content: "Papercut recorded.", outcome: "ok" })
  })

  it("reports missing runtime ownership as a user-visible failure", async () => {
    const result = await papercutLogDefinition.execute({ observation: "A valid observation." }, context({ modelRequestId: undefined }))
    expect(result.outcome).toBe("error")
    expect(result.content).toContain("Tell the user")
  })

  it("states the narrow project-only observation contract", () => {
    expect(papercutLogDefinition.description).toContain("one or two sentences")
    expect(papercutLogDefinition.description).toContain("open repository's code, docs, tests, or build tooling")
    expect(papercutLogDefinition.description).toContain("Never record friction in your own agent definitions or tools here")
    expect(papercutLogDefinition.description).toContain("request-shaped missing tooling, docs, and fixtures")
    expect(papercutLogDefinition.description).toContain("user-visible failures")
  })
})

describe("papercut disposition tool", () => {
  it("offers only evidence-backed terminal outcomes", async () => {
    const { store, writer } = storeFixture()
    const target = appendRecorded(store, "owner")
    const tool = createPapercutDisposeTool(writer)

    expect(tool.description).toContain("fixed when evidence shows the pain is gone")
    expect(tool.description).toContain("dismissed when the record is no longer actionable")
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        recorded_fact_id: { type: "string", minLength: 1 },
        disposition: { type: "string", enum: ["fixed", "dismissed"] },
      },
      required: ["recorded_fact_id", "disposition"],
      additionalProperties: false,
    })

    expect(await tool.execute({ recorded_fact_id: target.id, disposition: "promoted" }, context())).toEqual({
      content: "Papercut disposition input was invalid. Tell the user that the runtime could not persist the papercut operation.",
      outcome: "error",
    })
    expect(store.read({ aggregateId: "project:papercuts", types: ["papercut.disposed"] })).toHaveLength(0)
  })

  it("uses the runtime event store through the ambient definition", async () => {
    const { store } = storeFixture()
    const target = appendRecorded(store, "owner")

    const service = papercutsModule.service.create({
      projectionReader: asAsyncEventReadSurface(store),
      eventWriter: asAsyncEventWriter(store),
    })
    const runtime = papercutsModule.runtime.create({ modules: composeModuleServices([["papercuts", service]]) })
    const result = await papercutDisposeDefinition.execute(
      { recorded_fact_id: target.id, disposition: "fixed" },
      context({ moduleRuntimes: composeModuleRuntimes([["papercuts", runtime]]) }),
    )

    expect(result.outcome).toBe("ok")
    expect(store.read({ aggregateId: "project:papercuts", types: ["papercut.disposed"] })).toHaveLength(1)
  })
})

describe("papercut disposition writer", () => {
  it("makes same-target races atomic and returns already disposed to the loser", async () => {
    const { store, writer } = storeFixture()
    const target = appendRecorded(store, "owner")
    const results = await Promise.all([
      writer.dispose({ recordedFactId: target.id, disposition: "fixed", disposingSessionId: "fixer-1" }),
      writer.dispose({ recordedFactId: target.id, disposition: "dismissed", disposingSessionId: "fixer-2" }),
    ])

    expect(results.map((result) => result.kind).sort()).toEqual(["already-disposed", "disposed"])
    const facts = store.read({ aggregateId: "project:papercuts", types: ["papercut.disposed"] })
    expect(facts).toHaveLength(1)
    expect(facts[0]?.payload.disposingSessionId).toBe(facts[0]?.sessionId)
  })

  it("retries different-target races against the shared project aggregate", async () => {
    const { store, writer } = storeFixture()
    const first = appendRecorded(store, "owner-1")
    const second = appendRecorded(store, "owner-2")

    const results = await Promise.all([
      writer.dispose({ recordedFactId: first.id, disposition: "fixed", disposingSessionId: "fixer-1" }),
      writer.dispose({ recordedFactId: second.id, disposition: "promoted", disposingSessionId: "fixer-2" }),
    ])

    expect(results).toEqual([{ kind: "disposed" }, { kind: "disposed" }])
    expect(store.read({ aggregateId: "project:papercuts" })).toHaveLength(2)
  })

  it("dismisses a live papercut observed by another session", async () => {
    const { store, writer } = storeFixture()
    const target = appendRecorded(store, "other-session", "Harness friction outside this task")
    const tool = createPapercutDisposeTool(writer)

    const result = await tool.execute({ recorded_fact_id: target.id, disposition: "dismissed" }, context({ sessionId: "disposing-session" }))

    expect(result.outcome).toBe("ok")
    expect(store.read({ aggregateId: "project:papercuts" })[0]?.payload).toEqual({
      recordedFactId: target.id,
      disposition: "dismissed",
      disposingSessionId: "disposing-session",
    })
  })
})
