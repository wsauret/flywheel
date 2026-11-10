import { expect, test } from "bun:test";
import { buildSessionContext } from "../../../../../src/orchestration/session/conversation/conversation-tree-context.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactInput } from "../../../../../src/infra/agent-loop-events.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import { createConversationTreeWriterController } from "../../../../../src/orchestration/chat/tree-writer.js";
import { tryOpenConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { FUNCTION_TOOL_PRESENTATION, type StreamOptions, type StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { assemblyPinned, RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { asModelClient } from "../_model-client.js";
import { ContextLengthExceededError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { Schema } from "effect";
import { CompactionEntrySchema, MessageEntrySchema } from "../../../../../src/orchestration/session/conversation/conversation-entry-schemas.js";
import { renderSessionNotesGuidance } from "../../../../../src/infra/agent-assets/session-notes.js";
import { withSessionNotes } from "./_loop-fixtures.js";
import { renderSystemPrompt, stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { createConversationCheckpointOwner } from "../../../../../src/orchestration/session/conversation-checkpoint.js";
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { makeContext } from "../tools/_fixtures.js";
import { importLegacyCheckpointNotes } from "../../../../../src/orchestration/session/checkpoint-note-conversion.js";
import { projectBlocksFromEntries } from "../../../../../src/orchestration/session/conversation/conversation-block-projection.js";
import { promptCapabilities } from "../../../../helpers/prompt-capabilities.js";

test("reset records reject summary payloads and historical summaries remain readable", () => {
  const decode = Schema.decodeUnknownSync(CompactionEntrySchema, { onExcessProperty: "error" });
  const base = { kind: "compaction", id: "compact", parentId: "old", sourceLeafId: "old", timestamp: "2026-01-01T00:00:00.000Z", tokensBefore: 100, tokensAfter: 0 };
  expect(decode({ ...base, mode: "reset" })).toMatchObject({ mode: "reset" });
  expect(() => decode({ ...base, mode: "reset", summary: "not allowed", retainedMessages: [] })).toThrow();
  expect(decode({ ...base, summary: "old summary", retainedMessages: [] })).toMatchObject({ summary: "old summary" });
});

test("notes-only system guidance does not promise a retained summary", () => {
  const prompt = renderSessionNotesGuidance({ has: promptCapabilities([{ name: "recall" }]) });
  expect(prompt).toContain("without a generated summary");
  expect(prompt).not.toContain("Retained generated summaries");
  expect(prompt).toContain("recall");
});

for (const trigger of ["manual", "automatic", "overflow", "idle"] as const) {
  for (const checkpointState of trigger === "idle" ? ["present"] as const : ["present", "absent", "legacy-oversized"] as const) test(`${trigger} reset, checkpoint ${checkpointState}, is durable`, async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "notes-reset-"));
    const store = createSqliteEventStore(join(projectRoot, "events.sqlite"));
    const writer = createConversationTreeWriterController({ conversationId: "conversation", sessionId: "session", projectRoot, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
    try {
      await writer.commitUserTurn("old task");
      writer.beginTurn();
      writer.recordCanonicalMessage({ kind: "assistant", content: "old answer ".repeat(4000) });
      if (trigger === "idle") writer.recordCanonicalMessage({ kind: "user", content: "Prepare to park.", origin: "human" });
      await writer.flushSavePoint();
      const initial = await writer.buildContext({ allowAssistantTail: true });
      const requests: StreamOptions[] = [];
      const events: StreamEvent[] = [];
      const visibleMessages: string[] = [];
      let queued = false;
      const factWriter = createSessionFactWriter({ sessionId: "session", writer: asAsyncEventWriter(store) });
      const checkpoint = createConversationCheckpointOwner(asAsyncEventReadSurface(store), factWriter, { kind: "session", sessionId: "session" }, "conversation");
      const noteTools = withSessionNotes(new RequestToolMap([["recall", {
        name: "recall", action: "file_read", description: "Read recorded history",
        isConcurrencySafe: true, inputSchema: { type: "object", properties: {} },
        execute: async () => ({ content: "", outcome: "ok" }),
      }]]), checkpoint).tools;
      const tools = await assemblyPinned(noteTools);
      if (checkpointState === "legacy-oversized") {
        const notes = join(projectRoot, "legacy-notes");
        mkdirSync(notes);
        writeFileSync(join(notes, "checkpoint.md"), "legacy working notes ".repeat(2_000));
        await importLegacyCheckpointNotes(asAsyncEventReadSurface(store), factWriter, { kind: "session", sessionId: "session" }, "conversation", notes);
      } else if (checkpointState === "present") {
        const context = makeContext({ executionCwd: projectRoot, capabilities: promptCapabilities([{ name: "recall" }]) });
        for (const [name, input] of [
          ["checkpoint_replace", { section: "designIntent", value: { text: "Keep the exact approved intent.", approved: true } }],
          ["checkpoint_decide", { date: "2026-10-21", words: "Use the user's exact words.", replaces: "Use a summary." }],
          ["checkpoint_replace", { section: "currentState", value: "Goal\n" }],
          ["checkpoint_replace", { section: "openQuestions", value: "Which boundary remains?" }],
          ["checkpoint_replace", { section: "nextStep", value: "Next\n" }],
          ["checkpoint_replace", { section: "relevantSkills", value: [{ id: "verification", reason: "Check the real boundary." }] }],
          ["checkpoint_replace", { section: "references", value: ["durable-request-id"] }],
          ["checkpoint_replace", { section: "workingNotes", value: "Exact working notes.\r\n" }],
        ] as const) {
          expect((await executePreparedTool(prepareToolCall({ id: name, name, input }, noteTools), context)).outcome).toBe("ok");
        }
        expect(await executePreparedTool(prepareToolCall({ id: "read", name: "checkpoint_read", input: {} }, noteTools), context))
          .toMatchObject({ outcome: "ok", content: expect.stringContaining("Goal\n") });
        expect((await executePreparedTool(prepareToolCall({
          id: "outside", name: "checkpoint_replace", input: { section: "nextStep", value: "no", conversationId: "outside" },
        }, noteTools), context)).outcome).toBe("error");
      }
      const beforeCompaction = await checkpoint.read();
      const client = asModelClient({
        accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: trigger === "automatic" ? 10_000 : 100_000,
        outputLimit: 8000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION,
        async *streamWithTools(request) {
          requests.push({ ...request, messages: [...request.messages] });
          if (trigger === "overflow" && requests.length === 1) throw normalizeProviderAttemptFailure(new ContextLengthExceededError());
          if (checkpointState === "present" && trigger !== "overflow" && requests.length === (trigger === "idle" ? 2 : 1)) {
            yield { kind: "tool_use", toolCall: { id: "latest", name: "checkpoint_replace", input: { section: "nextStep", value: "Saved immediately before compaction." } } } as const;
            yield { kind: "done", stopReason: "tool_use" } as const;
            return;
          }
          yield { kind: "text_delta", text: "checkpoint saved", blockKey: "text" } as const;
          yield { kind: "done", stopReason: "end_turn" } as const;
        }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      });
      await runAgentLoop({
        client, tools,
        systemPrompt: stableSystemPrompt("normal system"), instruction: null, executionCwd: projectRoot, userDataRoot: `${projectRoot}/.test-account`, projectRoot,
        providerSessionKey: "reset", promptCacheKey: "reset", artifactScopeId: "reset", retrievalSessionId: "reset",
        seed: { kind: "resume", priorMessages: [...initial.messages] },
        checkpoint,
        onSystemMessage: (content) => { visibleMessages.push(content); },
        onEvent: (event) => events.push(event), flushCanonicalMessages: () => writer.flushSavePoint(),
        persistence: { history: { append: writer.recordCanonicalMessage }, recordCompaction: async (input) => (await writer.recordCompaction(input))?.messages },
        inputSource: {
          drainPending: () => { if (trigger === "manual" && !queued) { queued = true; return compactInput(); } return null; },
          ...(trigger === "idle" ? { prepareWaitForInput: () => ({
            commit: async () => { if (queued) return null; queued = true; return { ...compactInput(), source: "idle" as const }; },
            cancel: async () => {},
          }) } : {}),
        },
      });
      await writer.flushSavePoint();
      const tree = await tryOpenConversationTree({ conversationId: "conversation", sessionId: "session", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
      if (!tree) throw new Error("missing tree");
      const stored = (await tree.getBranch()).find((entry) => entry.kind === "compaction");
      expect(stored).toMatchObject({ kind: "compaction", mode: "reset" });
      expect(stored && "summary" in stored).toBe(false);
      const replay = (await tree.buildContext({ allowAssistantTail: true })).messages;
      expect(JSON.stringify(replay)).not.toContain("old task");
      expect(JSON.stringify(replay)).not.toContain("old answer");
      expect(JSON.stringify(replay)).toContain("fresh context window");
      const opening = replay[0];
      expect(opening).toMatchObject({ kind: "user", origin: "system" });
      if (opening?.kind !== "user" || typeof opening.content !== "string") throw new Error("missing checkpoint opening");
      expect(visibleMessages).not.toContain(opening.content);
      const blocks = projectBlocksFromEntries(await tree.getBranch(), { executionCwd: projectRoot });
      expect(blocks.filter((block) => block.kind === "system" && block.message === opening.content)).toHaveLength(0);
      if (checkpointState === "present") {
        expect(opening.content).toStartWith("# Design intent (approved)\n\nKeep the exact approved intent.");
        for (const content of ["# Decisions", "2026-10-21", "Use the user's exact words.", "Replaces: Use a summary.", "# Current state\n\nGoal\n", "# Open questions\n\nWhich boundary remains?", "# Relevant skills\n\n- verification: Check the real boundary.", "# References\n\n- durable-request-id", "# Working notes\n\nExact working notes.\r\n"]) {
          expect(opening.content).toContain(content);
        }
        expect(opening.content).toContain(trigger === "overflow" ? "# Next step\n\nNext\n" : "# Next step\n\nSaved immediately before compaction.");
        expect(opening.content).not.toContain("checkpoint_read");
      } else if (checkpointState === "legacy-oversized") {
        for (const section of ["# Design intent (draft)", "# Decisions", "# Current state", "# Open questions", "# Next step", "# References", "# Working notes"]) expect(opening.content).toContain(section);
        // The agent has no skill tool, so the empty skills section stays out of its opening.
        expect(opening.content).not.toContain("# Relevant skills");
        expect(opening.content).toContain("Working notes is too large to include");
        expect(opening.content).toContain('checkpoint_read({ "section": "workingNotes", "offset": 0 })');
        expect(opening.content).not.toContain("legacy working notes");
        expect(await checkpoint.read()).toEqual(beforeCompaction);
      } else {
        expect(opening.content).toContain("No checkpoint has been saved.");
        expect(await checkpoint.read()).toBeUndefined();
      }
      expect(opening.content).toContain("read-only `recall` tool");
      expect(replay.filter((message) => message.kind === "user" && typeof message.content === "string" && message.content.includes("fresh context window"))).toHaveLength(1);
      expect(events.some((event) => event.kind === "compaction_done" && event.success)).toBe(true);
      expect(requests.every((request) => renderSystemPrompt(request.systemPrompt) === "normal system")).toBe(true);
      // A save round that never writes asks until its bound of four requests before it resets unsaved.
      const checkpointRequests = requests.filter((request) => JSON.stringify(request.messages).includes("Save the checkpoint now:"));
      expect(checkpointRequests.length).toBe(trigger === "overflow" ? 0 : checkpointState === "present" ? 1 : 4);
      if (trigger === "idle") expect(requests).toHaveLength(2);
      else if (trigger !== "manual") {
        expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("old task");
        expect(JSON.stringify(requests.at(-1)?.messages)).toContain("fresh context window");
        expect(requests.at(-1)?.messages[0]).toEqual(opening);
      }
      if (trigger === "manual" && checkpointState === "present") {
        await checkpoint.replace("currentState", "Changed after reset.");
        expect((await tree.buildContext({ allowAssistantTail: true })).messages[0]).toEqual(opening);
      }
      await tree.getStorage().dispose();
    } finally { await writer.dispose(); store.close(); rmSync(projectRoot, { recursive: true, force: true }); }
  });
}

test("reset replay excludes old user messages and summaries", () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const branch = [
    { kind: "message", id: "old", parentId: null, timestamp, message: { kind: "user", content: "old task" } },
    { kind: "compaction", mode: "reset", id: "reset", parentId: "old", sourceLeafId: "old", timestamp, tokensBefore: 100, tokensAfter: 0 },
    Schema.decodeUnknownSync(MessageEntrySchema, { onExcessProperty: "error" })({
      kind: "message", id: "recovery", parentId: "reset", timestamp, message: { kind: "user", origin: "system", checkpoint: true, content: "Read session notes." },
    }),
  ] satisfies Parameters<typeof buildSessionContext>[0];
  const context = buildSessionContext(branch);
  expect(context.messages).toEqual([{ kind: "user", origin: "system", content: "Read session notes." }]);
  expect(projectBlocksFromEntries(branch, { executionCwd: "/scratch" }).map((block) => block.kind === "system" ? block.message : block.kind))
    .toEqual(["userMessage", "Context compacted: 100 → 0 tokens"]);
});
