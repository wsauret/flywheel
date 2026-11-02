import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { formatReconstruction, reconstructPromptForRequest } from "../../../src/cli/event-search"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../src/infra/paths"
import { resolveDebugLogDirectory } from "../../../src/infra/debug-log"
import { buildProviderRequestFacts } from "../../../src/orchestration/session/provider-request-audit-recorder"
import { appendProviderRequestFacts } from "../orchestration/session/_provider-request-audit-fixtures"
import { loadProviderRequestAuditFromEvents } from "../../../src/orchestration/session/provider-request-audit-projection"
import { buildSessionContext } from "../../../src/orchestration/session/conversation/conversation-tree-context"
import { createConversationTree } from "../../../src/orchestration/session/conversation/conversation-tree-handle"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "event-search-reconstruct-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const tools = [{ name: "read", registrationId: "read", executableId: "read", description: "Read", input_schema: { type: "object" } }]

async function recordFirstOfTurnRequest(sessionId: string, conversationId: string): Promise<string> {
  const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
  const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
  await tree.appendMessage({ kind: "user", content: "first question" })
  const leafEntryId = await tree.getLeafId()
  const context = buildSessionContext(await tree.getBranch())
  await tree.getStorage().dispose()

  appendProviderRequestFacts(store, sessionId, {
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

  const entry = loadProviderRequestAuditFromEvents(store.read({ aggregateId: `session:${sessionId}` }))[0]
  store.close()
  return entry!.requestId
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
  await tree.getStorage().dispose()
  store.close()

  const built = buildProviderRequestFacts({
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
  }, {})
  const logDir = resolveDebugLogDirectory(tmpDir)
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, "2026-01-01T000000000Z-1-test.jsonl"),
    built.facts.map((fact, index) => `${JSON.stringify({
      ts: 1000 + index,
      sessionId,
      type: fact.type,
      actor: fact.actor,
      payload: fact.payload,
    })}\n`).join(""),
  )
  return built.requestId
}

describe("events:search --reconstruct", () => {
  test("reconstructs a first-of-turn request and verifies its sha256", async () => {
    const sessionId = "cli-recon-1"
    const requestId = await recordFirstOfTurnRequest(sessionId, "conv-cli-recon-1")

    const result = await reconstructPromptForRequest({ projectRoot: tmpDir, sessionId, requestId })
    if (result.kind !== "reconstructed") throw new Error(`expected a reconstruction, got ${result.kind}`)

    expect(result.verified).toBe(true)
    expect(result.systemPrompt).toBe("be helpful")
    expect(result.tools).toEqual(tools)

    const text = formatReconstruction(requestId, result, { json: false })
    expect(text).toContain("verified=true")
    expect(text).toContain("be helpful")
    expect(text).not.toContain("mid-turn")
  })

  test("does not use debug logs as reconstruction state", async () => {
    const sessionId = "cli-recon-log"
    const requestId = await recordFirstOfTurnRequestInDebugLog(sessionId, "conv-cli-recon-log")

    await expect(reconstructPromptForRequest({ projectRoot: tmpDir, sessionId, requestId }))
      .rejects.toThrow(`no provider request ${requestId}`)
  })

  test("emits JSON when --json is set", async () => {
    const sessionId = "cli-recon-json"
    const requestId = await recordFirstOfTurnRequest(sessionId, "conv-cli-recon-json")

    const result = await reconstructPromptForRequest({ projectRoot: tmpDir, sessionId, requestId })
    expect(JSON.parse(formatReconstruction(requestId, result, { json: true }))).toMatchObject({
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

    await expect(
      reconstructPromptForRequest({ projectRoot: tmpDir, sessionId, requestId: "no-such-request" }),
    ).rejects.toThrow(/no provider request no-such-request/)
  })
})
