import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { buildHandoffValidatedFact, buildHandoffWrittenFact } from "../../../../src/workflows/output-contract/facts.js"
import { loadHandoffsFromEvents } from "../../../../src/workflows/output-contract/projection.js"
import { compileOutput } from "../../../../src/workflows/output-contract/compile.js"
import { renderAgentOutput } from "../../../../src/workflows/output-contract/render.js"
import { Schema } from "effect"

let tmpDir = ""

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = ""
})

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "handoff-facts-test-"))
  return tmpDir
}

describe("step output facts", () => {
  it("records payload and validation facts; projection replays them", async () => {
    const baseDir = makeTmpDir()
    const sessionId = "handoff-replay"
    const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(eventStore) })

    await writer.record(buildHandoffWrittenFact({
      attemptId: "s1",
      agentName: "Plan",
      definitionId: "spec-create",
      workflowDefinitionId: "plan-implement",
      content: { summary: "done", phases: ["build"] },
    }))
    await writer.record(buildHandoffValidatedFact({
      attemptId: "s1",
      agentName: "Plan",
      definitionId: "spec-create",
      workflowDefinitionId: "plan-implement",
      status: "passed",
      issues: [],
    }))

    const records = loadHandoffsFromEvents(eventStore.read({ aggregateId: `session:${sessionId}` }))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      attemptId: "s1",
      definitionId: "spec-create",
      content: { summary: "done", phases: ["build"] },
      validationStatus: "passed",
      validationIssues: [],
    })
    expect(records[0]?.sha256).toHaveLength(64)

    expect(eventStore.read({ aggregateId: `session:${sessionId}` }).map((event) => event.type)).toEqual([
      "handoff.written",
      "handoff.validated",
    ])

    writer.dispose()
    eventStore.close()
  })

  it("replays a cited command run that a step wrote when it still sent the exit code, and today's contract reads it unchanged", async () => {
    const baseDir = makeTmpDir()
    const sessionId = "handoff-copied-exit-code"
    const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(eventStore) })
    // The record shape before the runtime filled exitCode: the model copied it, the boundary checked it.
    const content = { summary: "Fixed.", commands_run: [{ toolUseId: "toolu_1", exitCode: 1, observation: "2 failures", command: "bun test" }] }
    await writer.record(buildHandoffWrittenFact({ attemptId: "s1", agentName: "Fix", definitionId: "debug.fix", workflowDefinitionId: "debug", content }))

    const [record] = loadHandoffsFromEvents(eventStore.read({ aggregateId: `session:${sessionId}` }))
    expect(Schema.decodeUnknownSync(compileOutput({ commands: { min: 1 } }).schema)(record?.content)).toEqual(content)
    expect(renderAgentOutput(record?.content ?? {}, [])).toContain("- `bun test` (exit 1): 2 failures")

    writer.dispose()
    eventStore.close()
  })

  it("records failed validation issues without losing the payload", async () => {
    const baseDir = makeTmpDir()
    const sessionId = "handoff-failed"
    const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(eventStore) })

    await writer.record(buildHandoffWrittenFact({
      attemptId: "s1",
      agentName: "Work",
      definitionId: "implement",
      workflowDefinitionId: "plan-implement",
      content: { summary: "missing artifact" },
    }))
    await writer.record(buildHandoffValidatedFact({
      attemptId: "s1",
      agentName: "Work",
      definitionId: "implement",
      workflowDefinitionId: "plan-implement",
      status: "failed",
      issues: [{ path: "artifact", message: "missing file" }],
    }))

    expect(loadHandoffsFromEvents(eventStore.read({ aggregateId: `session:${sessionId}` }))[0]).toMatchObject({
      validationStatus: "failed",
      validationIssues: [{ path: "artifact", message: "missing file" }],
      content: { summary: "missing artifact" },
    })

    writer.dispose()
    eventStore.close()
  })

  it("loads a version 1 fact, with or without its retired handoff type, under the attempt and agent names", () => {
    const baseDir = makeTmpDir()
    const sessionId = "handoff-historical"
    const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const stored = { stepId: "s1", stepName: "Review", definitionId: "review", workflowDefinitionId: "implement" }
    const facts = [
      { type: "handoff.written", actor: "worker", payload: { ...stored, handoffType: "review-handoff", content: { summary: "clean" }, bytes: 19, sha256: "a".repeat(64), preview: "clean" } },
      { type: "handoff.validated", actor: "flywheel", payload: { ...stored, status: "passed", issues: [] } },
    ] as const
    for (const fact of facts) {
      eventStore.append({ aggregateId: `session:${sessionId}`, sessionId, timestamp: 1, version: 1, ...fact })
    }

    expect(loadHandoffsFromEvents(eventStore.read({ aggregateId: `session:${sessionId}` }))).toEqual([
      expect.objectContaining({ attemptId: "s1", agentName: "Review", definitionId: "review", content: { summary: "clean" }, validationStatus: "passed" }),
    ])
    eventStore.close()
  })
})
