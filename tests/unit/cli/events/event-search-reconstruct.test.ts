import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { runEventSearch } from "../../../../src/cli/events/event-search"
import { formatReconstruction } from "../../../../src/cli/events/event-search-format"
import * as hardExitClock from "../../../../src/infra/process/workers/hard-exit-clock"
import { createSqliteEventStore } from "../../../../src/infra/store/sqlite-event-store"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/store/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { resolveDebugLogDirectory } from "../../../../src/infra/diagnostics/debug-log"
import { appendProviderRequestFacts, providerRequestFacts } from "../../orchestration/session/_provider-request-audit-fixtures"
import { buildSessionContext } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-context"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-handle"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "event-search-reconstruct-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  process.exitCode = 0
})

/** What `flywheel events search --session <sessionId> --reconstruct
 *  <requestId>` prints, with `flags` after it. The command's hard-exit clock
 *  is a Worker, which this test does not start. */
async function reconstruct(sessionId: string, requestId: string, ...flags: string[]): Promise<{ readonly out: string; readonly err: string }> {
  const out: string[] = []
  const err: string[] = []
  const clock = spyOn(hardExitClock, "startHardExitClock").mockImplementation(() => ({ cancel: async () => {} }))
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(" ")) })
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => { err.push(args.map(String).join(" ")) })
  try {
    await runEventSearch(["--session", sessionId, "--reconstruct", requestId, ...flags], tmpDir)
  } finally {
    clock.mockRestore()
    log.mockRestore()
    error.mockRestore()
  }
  return { out: out.join("\n"), err: err.join("\n") }
}

const tools = [{ name: "read", registrationId: "read", executableId: "read", description: "Read", input_schema: { type: "object" } }]

// A workflow member's audit facts live on `workflow:<sessionId>`, not on its
// session aggregate.
async function recordFirstOfTurnRequest(
  sessionId: string,
  conversationId: string,
  auditAggregate: "session" | "workflow" = "session",
): Promise<string> {
  const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
  const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
  await tree.appendMessage({ kind: "user", content: "first question" })
  const leafEntryId = await tree.getLeafId()
  const context = buildSessionContext(await tree.getBranch())
  await tree.dispose()

  const auditStore: Pick<typeof store, "append"> = {
    append: (fact) => store.append({ ...fact, aggregateId: `${auditAggregate}:${sessionId}` }),
  }
  const requestId = await appendProviderRequestFacts(auditStore, sessionId, {
    requestId: crypto.randomUUID(),
    identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "chat",
    systemPrompt: "be helpful",
    messages: context.messages,
    messageCount: context.messages.length,
    estimatedContextTokens: 10, contextWindow: 200_000,
    tools, omittedTools: [],
    attemptStaticTokens: 1, interactionProfileId: "default",
    model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
    treeLeafEntryId: leafEntryId,
  })
  store.close()
  return requestId
}

// Mirrors the live recorder: audit facts land in the debug log as JSONL
// records of {ts, sessionId, type, actor, payload}; the conversation tree
// stays durable in the store.
async function recordFirstOfTurnRequestInDebugLog(sessionId: string, conversationId: string): Promise<string> {
  const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
  const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
  await tree.appendMessage({ kind: "user", content: "first question" })
  const leafEntryId = await tree.getLeafId()
  const context = buildSessionContext(await tree.getBranch())
  await tree.dispose()
  store.close()

  const requestId = crypto.randomUUID()
  const facts = await providerRequestFacts({
    requestId,
    identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "chat",
    systemPrompt: "be helpful",
    messages: context.messages,
    messageCount: context.messages.length,
    estimatedContextTokens: 10, contextWindow: 200_000,
    tools, omittedTools: [],
    attemptStaticTokens: 1, interactionProfileId: "default",
    model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
    treeLeafEntryId: leafEntryId,
  }, {})
  const logDir = resolveDebugLogDirectory(tmpDir)
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, "2026-01-01T000000000Z-1-test.jsonl"),
    facts.map((fact, index) => `${JSON.stringify({
      ts: 1000 + index,
      sessionId,
      type: fact.type,
      actor: fact.actor,
      payload: fact.payload,
    })}\n`).join(""),
  )
  return requestId
}

describe("events:search --reconstruct", () => {
  test("reconstructs a first-of-turn request and verifies its sha256", async () => {
    const sessionId = "cli-recon-1"
    const requestId = await recordFirstOfTurnRequest(sessionId, "conv-cli-recon-1")

    expect(JSON.parse((await reconstruct(sessionId, requestId, "--json")).out)).toMatchObject({ kind: "reconstructed", verified: true, systemPrompt: "be helpful", tools })

    const text = (await reconstruct(sessionId, requestId)).out
    expect(text).toContain("verified=true")
    expect(text).toContain("be helpful")
    expect(text).not.toContain("mid-turn")
  })

  test("reconstructs a workflow member's request from its workflow aggregate", async () => {
    const sessionId = "cli-recon-workflow"
    const requestId = await recordFirstOfTurnRequest(sessionId, "conv-cli-recon-workflow", "workflow")

    expect(JSON.parse((await reconstruct(sessionId, requestId, "--json")).out)).toMatchObject({ kind: "reconstructed", verified: true, systemPrompt: "be helpful", tools })
  })

  test("does not use debug logs as reconstruction state", async () => {
    const sessionId = "cli-recon-log"
    const requestId = await recordFirstOfTurnRequestInDebugLog(sessionId, "conv-cli-recon-log")

    expect((await reconstruct(sessionId, requestId)).err).toContain(`no provider request ${requestId}`)
    expect(process.exitCode).toBe(1)
  })

  test("emits JSON when --json is set", async () => {
    const sessionId = "cli-recon-json"
    const requestId = await recordFirstOfTurnRequest(sessionId, "conv-cli-recon-json")

    expect(JSON.parse((await reconstruct(sessionId, requestId, "--json")).out)).toMatchObject({
      requestId,
      kind: "reconstructed",
      verified: true,
      systemPrompt: "be helpful",
    })
  })

  test("explains the mid-turn caveat when verification fails", () => {
    const text = formatReconstruction("req-mid", {
      kind: "reconstructed",
      systemPrompt: "sys",
      messages: [],
      tools: [],
      computedSha256: "aaa",
      verified: false,
    }, { json: false })

    expect(text).toContain("verified=false")
    expect(text).toContain("mid-turn")
    expect(text).toContain("turn-end save point")
  })

  test("reports an unavailable reconstruction as unavailable, never as a verified prompt", () => {
    const text = formatReconstruction("req-subagent", {
      kind: "unavailable",
      reason: "no-durable-messages",
      detail: "a subagent conversation is not a durable tree",
      promptSha256: "bbb",
      systemPrompt: "assembled subagent system prompt",
      tools: null,
    }, { json: false })

    expect(text).toContain("reconstruction=unavailable reason=no-durable-messages")
    expect(text).toContain("assembled subagent system prompt")
    expect(text).toContain("(not durably recorded)")
    expect(text).not.toContain("verified=")
  })

  test("errors clearly when the requestId is not in the session audit", async () => {
    const sessionId = "cli-recon-missing"
    await recordFirstOfTurnRequest(sessionId, "conv-cli-recon-missing")

    expect((await reconstruct(sessionId, "no-such-request")).err).toMatch(/no provider request no-such-request/)
    expect(process.exitCode).toBe(1)
  })
})
