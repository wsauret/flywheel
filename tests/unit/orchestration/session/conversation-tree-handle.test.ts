import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type AsyncGuardedEventWriter, type EventStore, type EventStoreAppend } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { createSessionManager } from "../../../../src/orchestration/session/manager";
import { createConversationTree, readTranscript, readReconciledBranch, readReconciledTranscript, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle";
import { turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record";
import { removeOwnerPid } from "../../../../src/orchestration/session/pid-lock";
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage";
import { parseConversationTreeFact } from "../../../../src/orchestration/session/conversation/conversation-facts";
import { toOpenAIResponsesInput } from "../../../../src/orchestration/agent-runtime/llm/conversions/openai-responses";
import { toAnthropicMessagesRequest } from "../../../../src/orchestration/agent-runtime/llm/conversions/anthropic-messages";
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types";

let baseDir: string;
let store: EventStore;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-tree-handle-"));
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
});

afterEach(() => {
  store.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

async function conversationIdOf(mgr: ReturnType<typeof createSessionManager>, sessionId: string): Promise<string> {
  const conversationId = (await mgr.listMetadata()).sessions.find((s) => s.id === sessionId)?.conversationId;
  if (!conversationId) throw new Error(`no conversationId for ${sessionId}`);
  return conversationId;
}

async function openExistingTree(options: Omit<Parameters<typeof tryOpenConversationTree>[0], "store"> & { store: EventStore }) {
  const tree = await tryOpenConversationTree({ ...options, store: asAsyncEventReadSurface(options.store) });
  if (!tree) throw new Error(`expected conversation tree ${options.conversationId}`);
  return tree;
}

describe("tryOpenConversationTree", () => {
  it("degrades a tool result without a preceding tool use for display and excludes it from the branch", async () => {
    const conversationId = "conv-tool-result-without-use"
    store.appendBatch([{
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1,
      payload: { conversationId, createdAt: new Date(0).toISOString() },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 2,
      payload: { conversationId, entries: [{ id: "result", parentId: null, timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "missing", content: [{ type: "text", text: "orphan" }] } }] },
    }])

    const tree = await tryOpenConversationTree({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store) })
    expect(await tree?.getBranch()).toHaveLength(0)
    expect((await readTranscript({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store) }))?.map((entry) => entry.kind)).toEqual(["degraded"])
  });

  it("salvages an excess field only for historical replay", async () => {
    const conversationId = "conv-excess-field"
    store.append({
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1,
      payload: { conversationId, createdAt: new Date(0).toISOString(), temporary: true },
    })
    expect(await (await tryOpenConversationTree({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store) }))?.getBranch()).toEqual([])
  });

  it("degrades malformed append facts with independently validated source identity and continues readable suffixes", async () => {
    const conversationId = "conv-decode-failure-with-identity"
    store.appendBatch([{
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1,
      payload: { conversationId, createdAt: new Date(0).toISOString() },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 2,
      payload: { conversationId, entries: [{ id: "broken", parentId: null, kind: "message" }] },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 3,
      payload: { conversationId, entries: [{ id: "readable", parentId: null, timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "user", content: "suffix" } }] },
    }])
    const transcript = await readTranscript({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store) })
    expect(transcript?.map((entry) => entry.kind)).toEqual(["degraded", "message"])
    expect(transcript?.[0]).toMatchObject({ kind: "degraded", sourceEntryId: "broken", block: { failureClass: "decode_failure" } })
  });

  it("degrades a malformed append without source identity and continues readable suffixes", async () => {
    const conversationId = "conv-decode-failure-without-identity"
    store.appendBatch([{
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1,
      payload: { conversationId, createdAt: new Date(0).toISOString() },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 2,
      payload: { conversationId, entries: [] },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 3,
      payload: { conversationId, entries: [{ id: "readable", parentId: null, timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "user", content: "suffix" } }] },
    }])
    const transcript = await readTranscript({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store) })
    expect(transcript?.map((entry) => entry.kind)).toEqual(["degraded", "message"])
    expect(transcript?.[0]?.kind === "degraded" ? transcript[0].sourceEntryId : undefined).toBeUndefined()
  });

  it("uses the selected aggregate when a malformed payload omits conversation identity", async () => {
    const conversationId = "conv-decode-failure-without-conversation"
    store.appendBatch([{
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1,
      payload: { conversationId, createdAt: new Date(0).toISOString() },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 2,
      payload: { conversationId, entries: [] },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 3,
      payload: { conversationId, entries: [{ id: "readable", parentId: null, timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "user", content: "suffix" } }] },
    }])
    const malformedEventId = store.read({ aggregateId: `conversation:${conversationId}` }).find((event) => event.timestamp === 2)?.id
    if (!malformedEventId) throw new Error("missing malformed fixture event")
    const db = new Database(resolveEventStoreDbFile(baseDir))
    db.query("update event set payload = ? where id = ?").run(JSON.stringify({ entries: [] }), malformedEventId)
    db.close()

    const transcript = await readTranscript({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store) })
    expect(transcript?.map((entry) => entry.kind)).toEqual(["degraded", "message"])
  });

  it("continues the branch after an unreadable turn in the transcript and the model context, and takes the next turn", async () => {
    const conversationId = "conv-unreadable-turn"
    const aggregateId = `conversation:${conversationId}`
    const entry = (id: string, parentId: string | null, kind: "user" | "assistant") => ({
      id, parentId, timestamp: new Date(0).toISOString(), kind: "message",
      message: { kind, content: id },
    })
    store.append({ aggregateId, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1, payload: { conversationId, createdAt: new Date(0).toISOString() } })
    const chain = [entry("u1", null, "user"), entry("a1", "u1", "assistant"), entry("u2", "a1", "user"), entry("a2", "u2", "assistant"), entry("u3", "a2", "user"), entry("a3", "u3", "assistant")]
    for (const [index, item] of chain.entries()) {
      store.append({ aggregateId, sessionId: conversationId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: index + 2, payload: { conversationId, entries: [item] } })
    }
    const lost = store.read({ aggregateId }).find((event) => JSON.stringify(event.payload).includes('"id":"u2"'))
    if (!lost) throw new Error("missing the fixture fact")
    const db = new Database(resolveEventStoreDbFile(baseDir))
    db.query("update event set payload = ? where id = ?").run('{"entries":', lost.id)
    db.close()

    const rowIds = (entries: readonly { readonly kind: string; readonly id?: string }[] | null | undefined) =>
      entries?.map((item) => item.kind === "degraded" ? "gap" : item.id)
    expect(rowIds(await readTranscript({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store) }))).toEqual(["u1", "a1", "gap", "a2", "u3", "a3"])
    const tree = await openExistingTree({ conversationId, sessionId: conversationId, store, writer: immediateWriter(store) })
    const context = await tree.buildContext({ allowAssistantTail: true })
    expect(context.messages.map((message) => message.kind)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"])
    expect((await tree.appendMessages([{ kind: "user", content: "next", origin: "human" }], ["u4"])).kind).toBe("committed")
    // Only the projection continues the branch; the stored entry keeps its parent.
    const stored = store.readTolerant({ aggregateId }).find((event) => !(event instanceof Error) && JSON.stringify(event.payload).includes('"id":"a2"'))
    expect(JSON.stringify(stored instanceof Error ? undefined : stored?.payload)).toContain('"parentId":"u2"')
  });

  it("keeps an explicit conflicting tool identity as a typed failure", async () => {
    const conversationId = "conv-tool-identity-conflict"
    store.appendBatch([{
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1,
      payload: { conversationId, createdAt: new Date(0).toISOString() },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 2,
      payload: { conversationId, entries: [
        { id: "assistant", parentId: null, timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "assistant", content: [{ type: "tool_use", id: "expected", name: "read", input: {} }] } },
        { id: "result", parentId: "assistant", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "conflict", content: [{ type: "text", text: "wrong" }] } },
      ] },
    }])
    await expect(tryOpenConversationTree({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store) })).rejects.toThrow("conflicts with preceding tool identity")
  });

  it("replays the observed stale and valid finalized-result interleaving without changing the active exchange", async () => {
    const conversationId = "conv-malformed-finalized-results"
    store.appendBatch([{
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1,
      payload: { conversationId, createdAt: new Date(0).toISOString() },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 3, actor: "flywheel", timestamp: 2,
      payload: { conversationId, entries: [
        { id: "user", parentId: null, timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "user", content: "inspect" } },
        { id: "assistant", parentId: "user", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "assistant", content: [
          { type: "tool_use", id: "current-a", name: "read", input: {} },
          { type: "tool_use", id: "current-b", name: "read", input: {} },
          { type: "tool_use", id: "current-c", name: "read", input: {} },
          { type: "tool_use", id: "current-d", name: "read", input: {} },
          { type: "tool_use", id: "current-e", name: "read", input: {} },
        ] } },
        { id: "ftr-stale-a", parentId: "assistant", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "stale-a", content: [{ type: "text", text: "stale gate output" }] } },
        { id: "ftr-current-a", parentId: "ftr-stale-a", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "current-a", content: [{ type: "text", text: "current result a" }] } },
        { id: "ftr-stale-b", parentId: "ftr-current-a", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "stale-b", content: [{ type: "text", text: "stale tool output" }] } },
        { id: "ftr-current-b", parentId: "ftr-stale-b", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "current-b", content: [{ type: "text", text: "current result b" }] } },
        { id: "ftr-current-c", parentId: "ftr-current-b", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "current-c", content: [{ type: "text", text: "current result c" }] } },
        { id: "ftr-current-d", parentId: "ftr-current-c", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "current-d", content: [{ type: "text", text: "current result d" }] } },
        { id: "ftr-current-e", parentId: "ftr-current-d", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "current-e", content: [{ type: "text", text: "current result e" }] } },
      ] },
    }])

    const tree = await openExistingTree({ conversationId, sessionId: conversationId, store })
    const branch = await tree.getBranch()
    expect(branch.filter((entry) => entry.kind === "message" && entry.displayOnly === true).map((entry) => entry.id))
      .toEqual(["ftr-stale-a", "ftr-stale-b"])
    expect((await tree.buildContext({ allowAssistantTail: true })).messages
      .filter((message) => message.kind === "toolResult")
      .map((message) => message.toolUseId)).toEqual(["current-a", "current-b", "current-c", "current-d", "current-e"])
    expect(await tree.getLeafId()).toBe("ftr-current-e")
  });

  it("prepares a current recovery result through a salvaged display-only ancestor", async () => {
    const conversationId = "conv-stale-finalized-result-before-open-exchange"
    store.appendBatch([{
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1,
      payload: { conversationId, createdAt: new Date(0).toISOString() },
    }, {
      aggregateId: `conversation:${conversationId}`, sessionId: conversationId, type: "chat.entries.appended", version: 3, actor: "flywheel", timestamp: 2,
      payload: { conversationId, entries: [
        { id: "assistant", parentId: null, timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "assistant", content: [{ type: "tool_use", id: "current", name: "read", input: {} }] } },
        { id: "ftr-stale", parentId: "assistant", timestamp: new Date(0).toISOString(), kind: "message", message: { kind: "toolResult", toolUseId: "stale", content: [{ type: "text", text: "stale output" }] } },
      ] },
    }])

    const tree = await openExistingTree({ conversationId, sessionId: conversationId, store })
    const prepared = await tree.prepareMessagesAppend([{
      id: "ftr-current",
      message: { kind: "toolResult", toolUseId: "current", content: [{ type: "text", text: "current output" }] },
    }])
    expect(prepared).not.toHaveLength(0)
  });

  it("returns a ConversationTree for an existing SQLite tree", async () => {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "My Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store });
    expect(await tree.getLeafId()).toBeNull();
    await tree.getStorage().dispose();
  });

  it("returns null for a conversation that has no chat tree fact", async () => {
    expect(await tryOpenConversationTree({ conversationId: "missing", sessionId: "missing", store: asAsyncEventReadSurface(store) })).toBeNull();
  });
});

describe("tryOpenConversationTree re-key sentinel", () => {
  // Guards the conversation:<conversationId> re-key: passing the sessionId where
  // a conversationId is expected must NOT silently open the dead `conversation:<sessionId>`
  // key and return an empty tree. There is no fallback to the old session: key.
  it("returns null when handed a sessionId where a conversationId is expected", async () => {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "My Chat" });
    const tree = await tryOpenConversationTree({ conversationId: id, sessionId: id, store: asAsyncEventReadSurface(store) });
    expect(tree).toBeNull();
  });
});

describe("a second writer on the same conversation", () => {
  // The first read of the conversation's sequence is where each append starts.
  // The second writer's commit lands just before that read returns.
  async function raceFirstAppend(second: (conversationId: string) => Promise<void>) {
    const conversationId = "conv-second-writer";
    const base = asAsyncEventReadSurface(store);
    const writer = immediateWriter(store);
    await createConversationTree({ conversationId, sessionId: "chat-second-writer", store: base, writer });
    let race: (() => Promise<void>) | undefined;
    const reader: AsyncEventStateReadSurface = {
      ...base,
      aggregateSeq: async (aggregateId) => {
        const landing = race;
        race = undefined;
        await landing?.();
        return base.aggregateSeq(aggregateId);
      },
    };
    const tree = await tryOpenConversationTree({ conversationId, sessionId: "chat-second-writer", store: reader, writer });
    if (!tree) throw new Error("expected the conversation tree");
    await tree.appendMessage({ kind: "user", content: "start", origin: "human" }, "u1");
    await tree.appendMessage({ kind: "assistant", content: "done" }, "a1");
    return { tree, conversationId, armRace: () => { race = () => second(conversationId); } };
  }

  async function commitSettledAcknowledgement(conversationId: string): Promise<void> {
    const other = await tryOpenConversationTree({ conversationId, sessionId: "chat-second-writer", store: asAsyncEventReadSurface(store), writer: immediateWriter(store) });
    await other?.appendMessage({ kind: "user", content: "Launched the qa workflow: verify", origin: "human" }, turnEndEntryId({ reason: "settled" }, "operation-1"));
  }

  it("keeps an entry the second writer commits inside an append's window on the active branch", async () => {
    const { tree, armRace } = await raceFirstAppend(commitSettledAcknowledgement);
    armRace();
    expect((await tree.appendMessages([{ kind: "user", content: "next", origin: "human" }], ["u2"])).kind).toBe("committed");
    expect((await tree.getBranch()).map((entry) => entry.id)).toEqual(["u1", "a1", turnEndEntryId({ reason: "settled" }, "operation-1"), "u2"]);
  });
});

describe("borrowed tree handle lifecycle", () => {
  it("disposing a tree handle leaves the owner store usable", async () => {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "My Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store });

    await tree.getStorage().dispose();

    expect(store.countByAggregate(`conversation:${conversationId}`)).toBeGreaterThan(0);
  });
});

function immediateWriter(target: EventStore): AsyncGuardedEventWriter {
  return {
    append: async (event: EventStoreAppend) => target.append(event),
    appendBatch: async (events: readonly EventStoreAppend[]) => target.appendBatch(events),
    appendGuarded: async (event) => target.appendGuarded(event),
    appendBatchGuarded: async (events) => target.appendBatchGuarded(events),
    pruneSupersededEvents: async () => 0,
  };
}

describe("model deliberation persistence", () => {
  // Persisted content mirrors ContentBlock verbatim and carries the serving
  // attribution the same-provider replay gates read, so a reopened session
  // replays the same provider context the live loop held (encrypted
  // reasoning and thinking signatures included).
  const openaiAttribution = { accessProvider: "github_copilot", provider: "openai", api: "openai-responses", model: "gpt-5-mini" } as const;

  it("round-trips deliberation and attribution, and the converter replays the reasoning item", async () => {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "Reasoning Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "ciphertext" } as const;
    const thinking = { type: "thinking", thinking: "chain", signature: "sig-1" } as const;
    await tree.appendMessage({ kind: "user", content: "run the tool" });
    await tree.appendMessages([
      {
        kind: "assistant",
        ...openaiAttribution,
        content: [
          { ...reasoning },
          { ...thinking },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" }, providerCallId: "call_t1" },
        ],
      },
      { kind: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "ok" }] },
    ]);
    await tree.getStorage().dispose();

    const reopened = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    const context = await reopened.buildContext({ allowAssistantTail: true });
    const assistant = context.messages.find((message) => message.kind === "assistant");
    if (!assistant || typeof assistant.content === "string") throw new Error("expected assistant block content");
    expect(assistant.content).toContainEqual(reasoning);
    expect(assistant.content).toContainEqual(thinking);
    expect(assistant).toMatchObject(openaiAttribution);

    // Wire-level proof: the rebuilt history passes the same-provider gate and
    // replays the verbatim provider reasoning item.
    const wire = JSON.stringify(toOpenAIResponsesInput({ ...openaiAttribution, sharedHost: false }, context.messages));
    expect(wire).toContain("ciphertext");
    await reopened.getStorage().dispose();
  });

  it("replays rebuilt Anthropic thinking with its signature", async () => {
    const anthropicAttribution = { accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-4" } as const;
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "Thinking Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    await tree.appendMessage({ kind: "user", content: "think it through" });
    await tree.appendMessages([
      {
        kind: "assistant",
        ...anthropicAttribution,
        content: [
          { type: "thinking", thinking: "signed chain", signature: "anthropic-sig" },
          { type: "text", text: "answer" },
        ],
      },
      { kind: "user", content: "continue" },
    ]);
    await tree.getStorage().dispose();

    const reopened = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    const context = await reopened.buildContext();
    const request = toAnthropicMessagesRequest({ ...anthropicAttribution, sharedHost: false, cacheRetention: "none" }, context.messages);
    const assistantWire = request.messages.find((message) => message.role === "assistant");
    expect(assistantWire?.content).toContainEqual({ type: "thinking", thinking: "signed chain", signature: "anthropic-sig" });
    await reopened.getStorage().dispose();
  });

  it("keeps a response's reported reasoning tokens through a rebuild while every entries fact keeps the shape an earlier build reads", async () => {
    const anthropicAttribution = { accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-5-5" } as const;
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "Reasoning Count Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    await tree.appendMessage({ kind: "user", content: "think it through" });
    const counted: ConversationMessage = { kind: "assistant", ...anthropicAttribution, reasoningTokens: 4_716, content: [{ type: "thinking", thinking: "", signature: "sig-1" }, { type: "text", text: "first" }] };
    await tree.appendMessages([counted, { kind: "user", content: "again" }]);
    const leaf = await tree.getLeafId();
    await tree.getStorage().dispose();
    const [entriesFact, countsFact] = store.read({ aggregateId: `conversation:${conversationId}` }).slice(-2);
    if (!entriesFact) throw new Error("expected the counted batch");
    // The entries keep version 3, which every earlier build reads in full; the count travels in its own fact,
    // which an earlier build's fold never selects.
    expect(entriesFact.type).toBe("chat.entries.appended");
    expect(entriesFact.version).toBe(3);
    expect(JSON.stringify(entriesFact.payload)).not.toContain("reasoningTokens");
    const earlierBuildRead = parseConversationTreeFact({ type: entriesFact.type, version: 3, actor: entriesFact.actor, payload: entriesFact.payload });
    const countedEntryId = earlierBuildRead.type === "chat.entries.appended" ? earlierBuildRead.payload.entries[0]?.id : undefined;
    expect(countsFact).toMatchObject({ type: "chat.reasoning.reported", version: 1, payload: { conversationId, counts: [{ entryId: countedEntryId, reasoningTokens: 4_716 }] } });

    // The shape a build before 2026-10-08 wrote: an assistant message with no count.
    store.append({
      aggregateId: `conversation:${conversationId}`, type: "chat.entries.appended", version: 3, actor: "flywheel",
      sessionId: id, timestamp: Date.now(),
      payload: { conversationId, entries: [
        { id: "earlier-build", parentId: leaf, timestamp: new Date().toISOString(), kind: "message",
          message: { kind: "assistant", ...anthropicAttribution, content: [{ type: "thinking", thinking: "", signature: "sig-2" }, { type: "text", text: "earlier" }] } },
      ] },
    });
    const reopened = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    const history = (await reopened.buildContext({ allowAssistantTail: true })).messages;
    const assistants = history.filter((message) => message.kind === "assistant");
    expect(assistants[0]).toEqual(counted);
    expect(assistants.at(-1)).toEqual({ kind: "assistant", ...anthropicAttribution, content: [{ type: "thinking", thinking: "", signature: "sig-2" }, { type: "text", text: "earlier" }] });
    await reopened.getStorage().dispose();
  });

  it("keeps deliberation and canonical tool_use on an incomplete assistant message", async () => {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "Aborted Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    await tree.appendMessage({ kind: "user", content: "start" });
    await tree.appendMessages([
      {
        kind: "assistant",
        incomplete: true,
        content: [
          { type: "thinking", thinking: "partial chain" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ],
      },
    ]);
    const branch = await tree.getBranch();
    const last = branch.at(-1);
    if (last?.kind !== "message" || last.message.kind !== "assistant" || typeof last.message.content === "string") {
      throw new Error("expected trailing assistant block entry");
    }
    expect(last.message.content).toEqual([
      { type: "thinking", thinking: "partial chain" },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    ]);
    await tree.getStorage().dispose();
  });

  it("round-trips a content-repair decision into the rebuilt context", async () => {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "Repair Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    const decision = { kind: "system", content: "The provider refused two tool calls; they are removed.", contentRepair: { kind: "remove", toolUseIds: ["toolu_1", "toolu_2"] } } as const;
    await tree.appendMessage({ kind: "user", content: "ask" });
    await tree.appendMessage(decision);
    await tree.getStorage().dispose();

    const reopened = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    expect((await reopened.buildContext()).messages).toEqual([{ kind: "user", content: "ask" }, decision]);
    await reopened.getStorage().dispose();
  });
});

describe("dangling tool_use sweep at adoption", () => {
  // A crash between save points leaves the durable branch ending in an
  // assistant message whose tool_use never got results. Adoption-time
  // reconciliation persists the interrupted tombstones once.
  async function sessionWithDanglingToolUse(): Promise<{ id: string; conversationId: string }> {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "My Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    await tree.appendMessage({ kind: "user", content: "run the tools" });
    await tree.appendMessages([
      {
        kind: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "t2", name: "read", input: { path: "x" } },
        ],
      },
      { kind: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "ok" }] },
    ]);
    await tree.getStorage().dispose();
    return { id, conversationId };
  }

  it("persists interrupted tombstones for unanswered trailing tool_use once the owner is dead", async () => {
    const { id, conversationId } = await sessionWithDanglingToolUse();
    removeOwnerPid(id, baseDir);
    const branch = await readReconciledBranch({ conversationId, sessionId: id, store: asAsyncEventReadSurface(store), writer: immediateWriter(store), projectRoot: baseDir });
    const last = branch?.at(-1);
    expect(last?.kind).toBe("message");
    if (last?.kind !== "message" || last.message.kind !== "toolResult") throw new Error("expected trailing toolResult tombstone");
    expect(last.message.toolUseId).toBe("t2");
    expect(last.message.interrupted).toBe(true);

    // Idempotent: a second reconcile finds no gap and appends nothing.
    const again = await readReconciledBranch({ conversationId, sessionId: id, store: asAsyncEventReadSurface(store), writer: immediateWriter(store), projectRoot: baseDir });
    expect(again?.length).toBe(branch?.length);
  });

  it("disposes one recovery transcript handle on success and failure", async () => {
    const successful = await sessionWithDanglingToolUse();
    const failing = await sessionWithDanglingToolUse();
    removeOwnerPid(successful.id, baseDir);
    removeOwnerPid(failing.id, baseDir);
    const originalDispose = ConversationTreeStorage.prototype.dispose;
    let disposals = 0;
    ConversationTreeStorage.prototype.dispose = function (): void {
      disposals += 1;
      originalDispose.call(this);
    };
    try {
      const transcript = await readReconciledTranscript({
        conversationId: successful.conversationId,
        sessionId: successful.id,
        store: asAsyncEventReadSurface(store),
        writer: immediateWriter(store),
        projectRoot: baseDir,
      });
      expect(transcript?.at(-1)).toMatchObject({ kind: "message", message: { kind: "toolResult", toolUseId: "t2", interrupted: true } });
      expect(disposals).toBe(1);

      disposals = 0;
      const rejectingWriter: AsyncGuardedEventWriter = {
        ...immediateWriter(store),
        append: async () => { throw new Error("write failed"); },
        appendGuarded: async () => { throw new Error("write failed"); },
        appendBatchGuarded: async () => { throw new Error("write failed"); },
      };
      await expect(readReconciledTranscript({
        conversationId: failing.conversationId,
        sessionId: failing.id,
        store: asAsyncEventReadSurface(store),
        writer: rejectingWriter,
        projectRoot: baseDir,
      })).rejects.toThrow("write failed");
      expect(disposals).toBe(1);
    } finally {
      ConversationTreeStorage.prototype.dispose = originalDispose;
    }
  });

  it("does not touch the branch while a live process owns the session", async () => {
    const { id, conversationId } = await sessionWithDanglingToolUse();
    const branch = await readReconciledBranch({ conversationId, sessionId: id, store: asAsyncEventReadSurface(store), writer: immediateWriter(store), projectRoot: baseDir });
    const kinds = branch?.map((entry) => (entry.kind === "message" ? entry.message.kind : entry.kind));
    expect(kinds).toEqual(["user", "assistant", "toolResult"]);
  });

  it("appends nothing when every trailing tool_use is answered", async () => {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "Complete Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    await tree.appendMessage({ kind: "user", content: "run the tool" });
    await tree.appendMessages([
      { kind: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { kind: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "ok" }] },
    ]);
    await tree.getStorage().dispose();
    removeOwnerPid(id, baseDir);
    const branch = await readReconciledBranch({ conversationId, sessionId: id, store: asAsyncEventReadSurface(store), writer: immediateWriter(store), projectRoot: baseDir });
    expect(branch?.length).toBe(3);
  });
});

describe("readReconciledBranch ownership gate", () => {

  /** A turn that died after asking for a tool and before recording its result:
   *  the durable branch ends on an unanswered tool_use. */
  async function sessionWithDanglingToolUse(): Promise<{ id: string; conversationId: string }> {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "My Chat" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    await tree.appendMessage({ kind: "user", content: "hello" });
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: {} }] });
    await tree.getStorage().dispose();
    return { id, conversationId };
  }

  it("repairs abandoned siblings without settling a protected question", async () => {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "Mixed tools" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    await tree.appendMessage({ kind: "user", content: "hello" });
    await tree.appendMessage({
      kind: "assistant",
      content: [
        { type: "tool_use", id: "search-1", name: "search", input: {} },
        { type: "tool_use", id: "ask-1", name: "ask_user", input: {} },
      ],
    });
    await tree.getStorage().dispose();
    removeOwnerPid(id, baseDir);

    const branch = await readReconciledBranch({
      conversationId,
      sessionId: id,
      store: asAsyncEventReadSurface(store),
      writer: immediateWriter(store),
      projectRoot: baseDir,
      protectedToolUseIds: new Set(["ask-1"]),
    });
    const results = branch?.flatMap((entry) => entry.kind === "message" && entry.message.kind === "toolResult" ? [entry.message] : []) ?? [];

    expect(results.map((result) => result.toolUseId)).toEqual(["search-1"]);
    expect(results[0]?.interrupted).toBe(true);
  });

  it("passes protected tool ids through reconciled transcript reads", async () => {
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store });
    const id = await mgr.createChat({ name: "Protected transcript" });
    const conversationId = await conversationIdOf(mgr, id);
    const tree = await openExistingTree({ conversationId, sessionId: id, store, writer: immediateWriter(store) });
    await tree.appendMessage({ kind: "user", content: "start workflow" });
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "workflow-1", name: "workflow", input: {} }] });
    tree.getStorage().dispose();
    removeOwnerPid(id, baseDir);

    const transcript = await readReconciledTranscript({
      conversationId,
      sessionId: id,
      store: asAsyncEventReadSurface(store),
      writer: immediateWriter(store),
      projectRoot: baseDir,
      protectedToolUseIds: new Set(["workflow-1"]),
    });

    expect(transcript).toHaveLength(2);
    expect(transcript?.[0]?.kind).toBe("message");
    const branch = await (await openExistingTree({ conversationId, sessionId: id, store })).getBranch();
    expect(branch).toHaveLength(2);
  });

  it("is idempotent across readers: a second reconcile appends nothing", async () => {
    const { id, conversationId } = await sessionWithDanglingToolUse();
    removeOwnerPid(id, baseDir);
    await readReconciledBranch({ conversationId, sessionId: id, store: asAsyncEventReadSurface(store), writer: immediateWriter(store), projectRoot: baseDir });
    const afterFirst = store.read({ aggregateId: `conversation:${conversationId}` }).length;
    const branch = await readReconciledBranch({ conversationId, sessionId: id, store: asAsyncEventReadSurface(store), writer: immediateWriter(store), projectRoot: baseDir });
    expect(store.read({ aggregateId: `conversation:${conversationId}` }).length).toBe(afterFirst);
    expect(branch?.length).toBe(3);
  });
});
