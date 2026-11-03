import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { appendProviderRequestFacts } from "./_provider-request-audit-fixtures"
import { loadProviderRequestAuditFromEvents } from "../../../../src/orchestration/session/provider-request-audit-projection"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { buildSessionContext } from "../../../../src/orchestration/session/conversation/conversation-tree-context"
import { reconstructProviderRequestPrompt } from "../../../../src/orchestration/session/provider-request-audit-reconstruction"
import { maskStaleToolResults } from "../../../../src/orchestration/agent-runtime/compaction/stale-tool-result-masker"
import { lowerToolHistoryById } from "../../../../src/orchestration/agent-runtime/llm/tool-history-projection"
import { applyHistoryLowering, planHistoryLowering } from "../../../../src/orchestration/agent-runtime/llm/provider-history"
import { openAIResponsesTarget } from "../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers"
import type { ProviderRequestAuditEntry } from "../../../../src/orchestration/session/provider-request-audit-types"
import { conversationTierEntry, DISPATCH_TEXT, ENGINE_INSTRUCTIONS } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "audit-reconstruction-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const tools = [{ name: "read", registrationId: "read.native", executableId: "read", description: "Read", input_schema: { type: "object" }, kind: "function" as const, inputFormatSha256: "a".repeat(64) }]

describe("provider-request-audit reconstruction (historical-fold)", () => {
  test.each([false, true])("reconstructs verifiably after compaction with provider tool names: %s", async (namespaced) => {
    const sessionId = "recon-compact"
    const conversationId = "conv-recon-compact"

    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({ kind: "user", content: "q1" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "read", input: { path: "a.ts" } }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "toolu_read", content: [{ type: "text", text: "result" }] })
    await tree.appendMessage({ kind: "user", content: "q2" })
    const recordedLeaf = await tree.getLeafId()
    const contextAtRequest = buildSessionContext(await tree.getBranch())
    const wireMessages = contextAtRequest.messages.map((message) => namespaced && message.kind === "assistant"
      ? { ...message, content: [{ type: "tool_use" as const, id: "toolu_read", name: "mcp__flywheel__read", input: { path: "a.ts" } }] }
      : message)
    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 2, promptKind: "chat",
      systemPrompt: "sys",
      messages: wireMessages,
      messageCount: contextAtRequest.messages.length,
      estimatedContextTokens: 20, contextWindow: 200_000,
      tools: namespaced ? [{ ...tools[0]!, name: "mcp__flywheel__read" }] : tools, omittedTools: [],
      attemptStaticTokens: 1, interactionProfileId: "default",
      model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
      treeLeafEntryId: recordedLeaf,
    })

    // The conversation grows and is compacted AFTER the request was recorded.
    await tree.appendMessage({ kind: "assistant", content: "a2" })
    await tree.appendCompaction({
      sourceLeafId: recordedLeaf!,
      tokensBefore: 999,
      tokensAfter: 12,
      opening: [],
    })
    await tree.getStorage().dispose()

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]

    const result = await reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents })
    if (result.kind !== "reconstructed") throw new Error(`expected a reconstruction, got ${result.kind}`)

    expect(result.verified).toBe(true)
    expect(entry!.prompt?.promptSha256).toBe(result.computedSha256)
    // Folds to the recorded leaf — the post-request q2 + compaction are excluded.
    expect(result.messages).toEqual(wireMessages)
    store.close()
  })

  test("replays a recorded stale-result mask and verifies the masked prompt sha256", async () => {
    const sessionId = "recon-masked"
    const conversationId = "conv-recon-masked"

    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({ kind: "user", content: "inspect the repo" })
    await tree.appendMessage({
      kind: "assistant",
      content: [{ type: "tool_use", id: "tu-1", name: "bash", input: { command: "git log" } }],
    })
    await tree.appendMessage({
      kind: "toolResult",
      toolUseId: "tu-1",
      content: [{ type: "text", text: "commit ".repeat(200) }],
    })
    await tree.appendMessage({ kind: "user", content: "now summarize" })
    const leafEntryId = await tree.getLeafId()
    const context = buildSessionContext(await tree.getBranch())
    await tree.getStorage().dispose()

    // Mask exactly what the agent loop would have sent, and record the mask.
    const masked = maskStaleToolResults(context.messages, 3)
    expect(masked).not.toBeNull()

    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "chat",
      systemPrompt: "sys",
      messages: masked!.messages,
      messageCount: masked!.messages.length,
      estimatedContextTokens: 10, contextWindow: 200_000,
      tools, omittedTools: [],
      attemptStaticTokens: 1, interactionProfileId: "default",
      model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
      treeLeafEntryId: leafEntryId,
      staleMasking: {
        cutoffIndex: masked!.cutoffIndex,
        masksApplied: masked!.masksApplied,
        bytesSaved: masked!.bytesSaved,
        maskedToolUseIds: masked!.maskedToolUseIds,
      },
    })

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]
    expect(entry?.prompt?.staleMasking?.maskedToolUseIds).toEqual(["tu-1"])

    const result = await reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents })
    if (result.kind !== "reconstructed") throw new Error(`expected a reconstruction, got ${result.kind}`)

    expect(result.verified).toBe(true)
    expect(result.messages).toEqual(masked!.messages)
    store.close()
  })

  test("replays recorded cross-model tool-history lowering", async () => {
    const sessionId = "recon-tool-history"
    const conversationId = "conv-recon-tool-history"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({
      kind: "assistant",
      provider: "openai",
      model: "gpt-5",
      content: [{ type: "tool_use", id: "patch-1", name: "apply_patch", registrationId: "apply_patch", input: { input: "patch" } }],
    })
    await tree.appendMessage({
      kind: "toolResult",
      toolUseId: "patch-1",
      content: [{ type: "text", text: "updated a.ts" }],
    })
    const leafEntryId = await tree.getLeafId()
    const context = buildSessionContext(await tree.getBranch())
    await tree.getStorage().dispose()
    const projected = lowerToolHistoryById(context.messages, ["patch-1"])

    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "chat",
      systemPrompt: "sys", messages: projected, messageCount: projected.length,
      estimatedContextTokens: 10, contextWindow: 200_000, tools, omittedTools: [],
      attemptStaticTokens: 1, interactionProfileId: "default",
      model: "claude", accessProvider: "anthropic_api", modelFamily: "anthropic",
      treeLeafEntryId: leafEntryId,
      toolHistoryProjection: { loweredToolUseIds: ["patch-1"] },
    })

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]
    expect(entry?.prompt?.toolHistoryProjection).toEqual({ loweredToolUseIds: ["patch-1"] })
    const reconstructed = await reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents })
    if (reconstructed.kind !== "reconstructed") throw new Error(`expected a reconstruction, got ${reconstructed.kind}`)
    expect(reconstructed.verified).toBe(true)
    expect(reconstructed.messages).toEqual(projected)
    store.close()
  })

  test("replays recorded provider-history lowering after a model switch", async () => {
    const sessionId = "recon-history-lowering"
    const conversationId = "conv-recon-history-lowering"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({ kind: "user", content: "Fix it." })
    await tree.appendMessage({ kind: "user", origin: "system", framing: "agent-host", content: ENGINE_INSTRUCTIONS })
    await tree.appendMessage({
      kind: "assistant", accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model: "claude",
      content: [
        { type: "thinking", thinking: "The person wants the short answer.", signature: "sig-private" },
        { type: "thinking", thinking: "Reading the config first.", signature: "sig-progress", presentation: "progress" },
        { type: "tool_use", id: "read-1", name: "read", input: { path: "a" } },
      ],
    })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "read-1", content: [{ type: "text", text: "ok" }] })
    await tree.appendMessage({ kind: "user", content: "Go on." })
    const leafEntryId = await tree.getLeafId()
    const context = buildSessionContext(await tree.getBranch())
    await tree.getStorage().dispose()
    const edits = planHistoryLowering(context.messages, openAIResponsesTarget("openai_api", "gpt-5"))
    expect(edits.map(({ reason }) => reason)).toEqual(["agent-host-framing", "foreign-deliberation", "progress-as-text"])
    const sent = applyHistoryLowering(context.messages, edits)

    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "chat",
      systemPrompt: "sys", messages: sent, messageCount: sent.length,
      estimatedContextTokens: 10, contextWindow: 200_000, tools, omittedTools: [],
      attemptStaticTokens: 1, interactionProfileId: "default",
      model: "gpt-5", accessProvider: "openai_api", modelFamily: "openai",
      treeLeafEntryId: leafEntryId,
      historyLowering: { edits },
    })

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]
    expect(entry?.prompt?.historyLowering).toEqual({ edits })
    const result = await reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents })
    if (result.kind !== "reconstructed") throw new Error(`expected a reconstruction, got ${result.kind}`)
    expect(result.verified).toBe(true)
    expect(result.messages).toEqual(sent)
    store.close()
  })

  test("replays the content-repair decisions on the recorded branch and verifies the repaired prompt sha256", async () => {
    const sessionId = "recon-repair"
    const conversationId = "conv-recon-repair"
    const withholdNote = "The provider refused the image of read shot.png, so it is withheld."
    const removeNote = "The provider refused the call bad-call and its result, so both are removed."
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({ kind: "user", content: "look" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "shot", name: "read", input: { path: "shot.png" } }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "shot", content: [{ type: "text", text: "now" }, { type: "image", mediaType: "image/png", data: "aGVsbG8=" }] })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "bad-call", name: "read", input: { path: "bad.txt" } }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "bad-call", content: [{ type: "text", text: "refused bytes" }] })
    await tree.appendMessage({ kind: "system", content: withholdNote, contentRepair: { kind: "withhold", toolUseId: "shot", partIndex: 1, partKind: "image" } })
    await tree.appendMessage({ kind: "system", content: removeNote, contentRepair: { kind: "remove", toolUseIds: ["bad-call"] } })
    const leafEntryId = await tree.getLeafId()
    // A later decision on the same conversation is not on the recorded branch.
    await tree.appendMessage({ kind: "system", content: "later", contentRepair: { kind: "withhold", toolUseId: "shot", partIndex: 0, partKind: "text" } })
    await tree.getStorage().dispose()

    // The view the live request sent: the image is the note, the removed call and
    // its result are gone, the remove note is an instruction, and the withhold
    // decision stays a system message for the converters to drop.
    const sent = [
      { kind: "user", content: "look" },
      { kind: "assistant", content: [{ type: "tool_use", id: "shot", name: "read", input: { path: "shot.png" } }] },
      { kind: "toolResult", toolUseId: "shot", content: [{ type: "text", text: "now" }, { type: "text", text: withholdNote }] },
      { kind: "system", content: withholdNote, contentRepair: { kind: "withhold", toolUseId: "shot", partIndex: 1, partKind: "image" } },
      { kind: "user", origin: "system", content: removeNote },
    ] as const
    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "chat",
      systemPrompt: "sys", messages: [...sent], messageCount: sent.length,
      estimatedContextTokens: 10, contextWindow: 200_000, tools, omittedTools: [],
      attemptStaticTokens: 1, interactionProfileId: "default",
      model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
      treeLeafEntryId: leafEntryId,
    })

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]
    const result = await reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents })
    if (result.kind !== "reconstructed") throw new Error(`expected a reconstruction, got ${result.kind}`)
    expect(result.messages).toEqual([...sent])
    expect(result.verified).toBe(true)
    expect(entry!.prompt?.promptSha256).toBe(result.computedSha256)
    store.close()
  })

  test("an audit that a build before 2026-10-26 recorded over unlabeled hidden entries still verifies after the reader labels them", async () => {
    const sessionId = "recon-unlabeled"
    const conversationId = "conv-recon-unlabeled"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    // The messages as that build stored and sent them: no entry carried framing.
    const sent = [
      { kind: "user", content: "Do the work." },
      { kind: "user", origin: "system", content: "<system-reminder>\nYou are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.\n</system-reminder>" },
      { kind: "user", origin: "system", content: conversationTierEntry("# Scratchpad Directory\n\nUse the scratchpad.") },
      { kind: "user", origin: "system", content: ENGINE_INSTRUCTIONS },
      { kind: "user", origin: "system", content: DISPATCH_TEXT },
    ] as const
    for (const message of sent) await tree.appendMessage(message)
    const leafEntryId = await tree.getLeafId()
    const read = buildSessionContext(await tree.getBranch()).messages
    await tree.getStorage().dispose()
    expect(read.map((message) => message.kind === "user" ? message.framing : undefined)).toEqual([undefined, "claude", "agent-host", "agent-host", "agent-host"])
    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "chat",
      systemPrompt: "sys", messages: [...sent], messageCount: sent.length,
      estimatedContextTokens: 10, contextWindow: 200_000, tools, omittedTools: [],
      attemptStaticTokens: 1, interactionProfileId: "default",
      model: "claude", accessProvider: "anthropic_api", modelFamily: "anthropic",
      treeLeafEntryId: leafEntryId,
    })

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]
    const result = await reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents })
    if (result.kind !== "reconstructed") throw new Error(`expected a reconstruction, got ${result.kind}`)
    expect(result.verified).toBe(true)
    store.close()
  })

  test("verification fails when the conversation history under the leaf diverges from the recorded sha", async () => {
    const sessionId = "recon-tamper"
    const conversationId = "conv-recon-tamper"

    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({ kind: "user", content: "hello" })
    const leafEntryId = await tree.getLeafId()
    const context = buildSessionContext(await tree.getBranch())
    await tree.getStorage().dispose()

    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "chat",
      systemPrompt: "sys",
      // Record a sha for messages that do NOT match the tree (simulating drift
      // between recorded history and recorded hash — a hard error per ARCH-CONTEXT-007).
      messages: [...context.messages, { kind: "user", content: "phantom" }],
      messageCount: 2,
      estimatedContextTokens: 1, contextWindow: 200_000,
      tools, omittedTools: [],
      attemptStaticTokens: 1, interactionProfileId: "default",
      model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
      treeLeafEntryId: leafEntryId,
    })

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]

    const result = await reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents })
    if (result.kind !== "reconstructed") throw new Error(`expected a reconstruction, got ${result.kind}`)
    expect(result.verified).toBe(false)
    store.close()
  })

  test("reports an honest unavailable result for a subagent request, with the evidence that IS recorded", async () => {
    const sessionId = "recon-subagent"
    const conversationId = "conv-recon-subagent"

    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "subagent",
      systemPrompt: "assembled subagent system prompt",
      messages: [{ kind: "user", content: "do the thing" }],
      messageCount: 1,
      estimatedContextTokens: 1, contextWindow: 200_000,
      tools, omittedTools: [],
      attemptStaticTokens: 1, interactionProfileId: "default",
      model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
      // No treeLeafEntryId — a subagent conversation is not a durable tree.
    })

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]

    const result = await reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents })
    if (result.kind !== "unavailable") throw new Error("subagent requests have no durable message history")

    expect(result.reason).toBe("no-durable-messages")
    expect(result.detail).toContain("non-durable")
    expect(result.promptSha256).toBe(entry!.prompt!.promptSha256)
    // The system prompt and tool surface ARE durable, and are reported.
    expect(result.systemPrompt).toBe("assembled subagent system prompt")
    expect(result.tools).toEqual(tools)
    store.close()
  })

  test("rejects doctored v3 subagent bodies before no-tree-pointer reconstruction", async () => {
    const sessionId = "recon-subagent-doctored"
    const conversationId = "conv-recon-subagent-doctored"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "subagent",
      systemPrompt: "authentic system prompt",
      messages: [{ kind: "user", content: "do the thing" }],
      messageCount: 1, estimatedContextTokens: 1, contextWindow: 200_000,
      tools, omittedTools: [], attemptStaticTokens: 1, interactionProfileId: "default",
      model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
    })

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const doctoredSystemPrompt = sessionEvents.map((event) => event.type === "prompt.assembled"
      ? { ...event, payload: { ...event.payload, systemPrompt: "doctored system prompt" } }
      : event)
    expect(() => loadProviderRequestAuditFromEvents(doctoredSystemPrompt)).toThrow(/system prompt body does not match hash/)

    const doctoredToolSurface = sessionEvents.map((event) => event.type === "tool_surface.selected"
      ? { ...event, payload: { ...event.payload, tools: [{ ...tools[0]!, description: "Doctored" }] } }
      : event)
    expect(() => loadProviderRequestAuditFromEvents(doctoredToolSurface)).toThrow(/tool surface body does not match hash/)
    store.close()
  })

  test("reports unavailable, not a reconstruction, when the referenced system-prompt body was never stored", async () => {
    const sessionId = "recon-lost-body"
    const conversationId = "conv-recon-lost-body"

    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({ kind: "user", content: "hello" })
    const leafEntryId = await tree.getLeafId()
    const context = buildSessionContext(await tree.getBranch())
    await tree.getStorage().dispose()

    appendProviderRequestFacts(store, sessionId, {
      identity: { providerSessionKey: conversationId, conversationId }, turn: 1, promptKind: "chat",
      systemPrompt: "sys",
      messages: context.messages,
      messageCount: context.messages.length,
      estimatedContextTokens: 1, contextWindow: 200_000,
      tools, omittedTools: [],
      attemptStaticTokens: 1, interactionProfileId: "default",
      model: "m", accessProvider: "anthropic_api", modelFamily: "anthropic",
      treeLeafEntryId: leafEntryId,
    })

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]
    expect(entry?.auditVersion).toBe(6)
    // Strict current references fail closed when a body is absent.
    const withoutBody = sessionEvents.map((event) => {
      if (event.type !== "prompt.assembled") return event
      const { systemPrompt: _dropped, ...payload } = event.payload
      return { ...event, payload }
    })

    await expect(
      reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents: withoutBody }),
    ).rejects.toThrow(/no stored system prompt body/)
    store.close()
  })

  test("reports a clear error when the audit entry has no prompt ref", async () => {
    const entry: ProviderRequestAuditEntry = {
      requestId: "req-no-prompt",
      identity: { providerSessionKey: "provider-no-prompt", conversationId: "conv-no-prompt" },
      turn: 1,
    }
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    try {
      await expect(
        reconstructProviderRequestPrompt({ entry, store, sessionEvents: [] }),
      ).rejects.toThrow(/has no prompt Ref/)
    } finally {
      store.close()
    }
  })

  test("throws on a malformed prompt.assembled fact instead of skipping it", async () => {
    const sessionId = "recon-v1"
    const conversationId = "conv-recon-v1"

    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({ kind: "user", content: "legacy question" })
    const leafEntryId = await tree.getLeafId()
    const context = buildSessionContext(await tree.getBranch())
    await tree.getStorage().dispose()

    appendProviderRequestFacts(store, sessionId, {
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

    const sessionEvents = store.read({ aggregateId: `session:${sessionId}` })
    const entry = loadProviderRequestAuditFromEvents(sessionEvents)[0]

    // Doctor the stored v2 fact into an unparseable shape. prompt.assembled is
    // internal Flywheel-written state, so reconstruction must fail loudly on a
    // malformed fact (producer bug) rather than skip it.
    const doctored = sessionEvents.map((event) => {
      if (event.type !== "prompt.assembled") return event
      return { ...event, version: 1, payload: { requestId: event.payload.requestId } }
    })

    await expect(
      reconstructProviderRequestPrompt({ entry: entry!, store, sessionEvents: doctored }),
    ).rejects.toThrow(/prompt\.assembled@3: version 1/)
    store.close()
  })
})
