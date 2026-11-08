import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { ChatTurnMailbox } from "../../../../../src/orchestration/chat/turn-mailbox.js";
import { RunLifecycle } from "../../../../../src/orchestration/agent-runtime/run-lifecycle.js";
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type ProviderStreamEvent, type StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { makeCaptureClient, throwLoopError, waitUntil, withSessionNotes } from "./_loop-fixtures.js";
import type { AgentLoopTerminal } from "../../../../../src/orchestration/agent-runtime/agent-loop-types.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { CONTINUATION_MESSAGES } from "../../../../../src/orchestration/agent-runtime/continuation-messages.js";
import { interruptedTurnMessage } from "../../../../../src/orchestration/session/conversation/turn-end-record.js";
import { asModelClient } from "../_model-client.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js";

describe("agent loop interruption barrier", () => {
  test("only user input resumes after Escape while automatic input cannot resume", async () => {
    const mailbox = new ChatTurnMailbox();
    const lifecycle = new RunLifecycle<AgentLoopTerminal>();
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "text_delta", text: "Waiting.", blockKey: "waiting" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [{ kind: "text_delta", text: "Resumed for the user.", blockKey: "resumed" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    let parkedCount = 0;
    const logicalStarts: string[] = [];
    let loopError: Error | undefined;
    void lifecycle.done.catch((error) => { loopError = error instanceof Error ? error : new Error(String(error)); });

    expect(lifecycle.start((signal) => runAgentLoop({
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "wait for a subagent",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "silent-system-interruption", promptCacheKey: "silent-system-interruption", artifactScopeId: "silent-system-interruption",
      retrievalSessionId: "silent-system-interruption",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: mailbox,
      signal,
      currentTurn: lifecycle,
      lifecycle: {
        onTurnParked: () => { parkedCount += 1; },
        onLogicalTurnStarted: ({ origin }) => { logicalStarts.push(origin); },
      },
    }))).toBe(true);

    await waitUntil(() => capturedMessages.length >= 1 || loopError !== undefined, "initial model request did not start");
    throwLoopError(loopError);
    await waitUntil(() => parkedCount >= 1 || loopError !== undefined, "initial turn did not park");
    throwLoopError(loopError);
    mailbox.enqueueSilentSystem("automatic maintenance context");
    mailbox.enqueueSilentSystem("background child result");
    expect(lifecycle.interrupt()).toBe(true);

    await waitUntil(() => parkedCount >= 2, "interrupted turn did not consume automatic input and re-park");
    expect(capturedMessages).toHaveLength(1);
    expect(logicalStarts).toEqual([]);

    mailbox.enqueueNextTurn("continue now");
    await waitUntil(() => capturedMessages.length >= 2, "user input did not resume the model");
    expect(logicalStarts).toEqual(["user"]);
    expect(JSON.stringify(capturedMessages[1])).toContain("automatic maintenance context");
    expect(JSON.stringify(capturedMessages[1])).toContain("background child result");
    expect(JSON.stringify(capturedMessages[1])).toContain("continue now");

    lifecycle.abort({ kind: "aborted" });
    await lifecycle.done;
  });

  test("an interrupt mid-turn records the turn end in the loop's history, and only a Resume continues it with its own continuation", async () => {
    const mailbox = new ChatTurnMailbox();
    const lifecycle = new RunLifecycle<AgentLoopTerminal>();
    const captured: ConversationMessage[][] = [];
    const appended: ConversationMessage[] = [];
    const record: ConversationMessage = { kind: "user", content: interruptedTurnMessage("person", true), origin: "system" };
    let recorded = 0;
    let interruptedParks = 0;
    const logicalStarts: string[] = [];
    let loopError: Error | undefined;
    void lifecycle.done.catch((error) => { loopError = error instanceof Error ? error : new Error(String(error)); });
    const client = asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: 100_000, outputLimit: 8_000,
      supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
        captured.push([...options.messages]);
        if (captured.length === 1) {
          yield { kind: "text_delta", text: "Working", blockKey: "working" };
          // The first turn runs until the person interrupts it.
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) resolve();
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield { kind: "text_delta", text: "Continuing.", blockKey: "continuing" };
        yield { kind: "done", stopReason: "end_turn" };
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    });

    expect(lifecycle.start((signal) => runAgentLoop({
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "do the work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "interrupt-record", promptCacheKey: "interrupt-record", artifactScopeId: "interrupt-record", retrievalSessionId: "interrupt-record",
      persistence: {
        history: { append: (message) => { appended.push(message); } },
        recordInterruption: async () => { recorded += 1; return record; },
      },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: mailbox,
      signal,
      currentTurn: lifecycle,
      lifecycle: {
        onTurnParked: ({ userResumeRequired }) => { if (userResumeRequired) interruptedParks += 1; },
        onLogicalTurnStarted: ({ origin }) => { logicalStarts.push(origin); },
      },
    }))).toBe(true);

    await waitUntil(() => captured.length >= 1 || loopError !== undefined, "initial model request did not start");
    throwLoopError(loopError);
    expect(lifecycle.interrupt()).toBe(true);
    await waitUntil(() => interruptedParks >= 1 || loopError !== undefined, "interrupted turn did not park");
    throwLoopError(loopError);
    expect(recorded).toBe(1);

    mailbox.enqueueBackgroundNotification({ text: "A background task finished." });
    await waitUntil(() => interruptedParks >= 2, "the notification did not fold in and re-park");
    expect(captured).toHaveLength(1);
    expect(logicalStarts).toEqual([]);

    mailbox.enqueueResume();
    await waitUntil(() => captured.length >= 2 || loopError !== undefined, "Resume did not continue the turn");
    throwLoopError(loopError);
    expect(logicalStarts).toEqual(["user"]);
    const continued = captured[1] ?? [];
    const recordIndex = continued.findIndex((message) => message.kind === "user" && message.content === record.content);
    const continuationIndex = continued.findIndex((message) => message.kind === "user" && message.content === CONTINUATION_MESSAGES.resumed);
    expect(recordIndex).toBeGreaterThan(-1);
    expect(continuationIndex).toBeGreaterThan(recordIndex);
    expect(JSON.stringify(continued)).toContain("A background task finished.");
    // The record is the host's to persist; the continuation is the loop's own history.
    expect(appended.some((message) => message.kind === "user" && message.content === record.content)).toBe(false);
    expect(appended.some((message) => message.kind === "user" && message.content === CONTINUATION_MESSAGES.resumed && message.origin === "system")).toBe(true);

    lifecycle.abort({ kind: "aborted" });
    await lifecycle.done;
  });

  test("an interrupt during a park on background work records the turn end once, folds the later result, and waits for the Resume", async () => {
    const mailbox = new ChatTurnMailbox();
    const lifecycle = new RunLifecycle<AgentLoopTerminal>();
    const task = Promise.withResolvers<BackgroundWorkResult>();
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (notification) => mailbox.enqueueSilentSystem(notification) });
    registry.track({ done: task.promise, meta: { id: "background-1", type: "background_command", description: "long build", toolUseId: "tool-1" } });
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "tool_use", toolCall: { id: "wait-build", name: "process", input: { action: "wait", soft_timeout: 30 } } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "text_delta", text: "Continuing.", blockKey: "continuing" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    const record: ConversationMessage = { kind: "user", content: interruptedTurnMessage("person", true), origin: "system" };
    let recorded = 0;
    const parks: { activeBackgroundCount: number; userResumeRequired: boolean }[] = [];
    const logicalStarts: string[] = [];
    let loopError: Error | undefined;
    void lifecycle.done.catch((error) => { loopError = error instanceof Error ? error : new Error(String(error)); });

    expect(lifecycle.start((signal) => runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "run the build",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "interrupt-background-park", promptCacheKey: "interrupt-background-park", artifactScopeId: "interrupt-background-park", retrievalSessionId: "interrupt-background-park",
      persistence: {
        history: { append: () => {} },
        recordInterruption: async () => { recorded += 1; return record; },
      },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: mailbox,
      background: createBackgroundExecutionOwner(registry),
      tools: new RequestToolMap([["process", createProcessTool(registry)]]),
      signal,
      currentTurn: lifecycle,
      lifecycle: {
        onTurnParked: ({ activeBackgroundCount, userResumeRequired }) => { parks.push({ activeBackgroundCount, userResumeRequired }); },
        onLogicalTurnStarted: ({ origin }) => { logicalStarts.push(origin); },
      },
    }))).toBe(true);

    await waitUntil(() => parks.length >= 1 || loopError !== undefined, "the turn did not park on its background work");
    throwLoopError(loopError);
    expect(parks[0]).toEqual({ activeBackgroundCount: 1, userResumeRequired: false });
    expect(recorded).toBe(0);

    // The person presses Escape while the park waits, then again.
    expect(lifecycle.interrupt()).toBe(true);
    await waitUntil(() => parks.length >= 2 || loopError !== undefined, "the interrupted wait did not park again");
    throwLoopError(loopError);
    lifecycle.interrupt();
    await Bun.sleep(5);
    expect(recorded).toBe(1);
    expect(parks.slice(1)).toEqual([{ activeBackgroundCount: 1, userResumeRequired: true }]);

    // The work settles afterward: its result folds into history and no turn starts.
    task.resolve({ status: "completed", content: "build complete" });
    await waitUntil(() => parks.length >= 3 || loopError !== undefined, "the settled result did not fold in and re-park");
    throwLoopError(loopError);
    expect(capturedMessages).toHaveLength(1);
    expect(logicalStarts).toEqual([]);

    mailbox.enqueueResume();
    await waitUntil(() => capturedMessages.length >= 2 || loopError !== undefined, "Resume did not continue the turn");
    throwLoopError(loopError);
    expect(recorded).toBe(1);
    expect(logicalStarts).toEqual(["user"]);
    const continued = capturedMessages[1] ?? [];
    const recordIndex = continued.findIndex((message) => message.kind === "user" && message.content === record.content);
    expect(recordIndex).toBeGreaterThan(-1);
    expect(continued.findIndex((message) => message.kind === "user" && message.content === CONTINUATION_MESSAGES.resumed)).toBeGreaterThan(recordIndex);
    expect(JSON.stringify(continued)).toContain("build complete");

    lifecycle.abort({ kind: "aborted" });
    await lifecycle.done;
  });

  test("a /compact that wakes a park on background work, then an Escape, parks for the person after the reset and runs no request", async () => {
    const mailbox = new ChatTurnMailbox();
    const lifecycle = new RunLifecycle<AgentLoopTerminal>();
    const task = Promise.withResolvers<BackgroundWorkResult>();
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (notification) => mailbox.enqueueSilentSystem(notification) });
    registry.track({ done: task.promise, meta: { id: "background-1", type: "background_command", description: "long build", toolUseId: "tool-1" } });
    const answer = (text: string) => ({ events: [{ kind: "text_delta" as const, text, blockKey: text }, { kind: "done" as const, stopReason: "end_turn" as const }] });
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "tool_use", toolCall: { id: "wait-build", name: "process", input: { action: "wait", soft_timeout: 30 } } }, { kind: "done", stopReason: "tool_use" }] },
      answer("checkpoint saved"),
      answer("an unauthorized request"),
    ]);
    const notes = withSessionNotes(new Map([["process", createProcessTool(registry)]]));
    const record: ConversationMessage = { kind: "user", content: interruptedTurnMessage("person", true), origin: "system" };
    let recorded = 0;
    let turnsEnded = 0;
    let resets = 0;
    const parks: { park: string; userResumeRequired: boolean }[] = [];
    let loopError: Error | undefined;
    void lifecycle.done.catch((error) => { loopError = error instanceof Error ? error : new Error(String(error)); });

    expect(lifecycle.start((signal) => runAgentLoop({
      client, tools: notes.tools, checkpoint: notes.checkpoint,
      systemPrompt: stableSystemPrompt("test"), instruction: "run the build",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "compact-in-park", promptCacheKey: "compact-in-park", artifactScopeId: "compact-in-park", retrievalSessionId: "compact-in-park",
      persistence: { history: { append: () => {} }, recordInterruption: async () => { recorded += 1; return record; } },
      seed: { kind: "fresh" },
      onEvent: (event) => { if (event.kind === "compaction_done" && event.success) resets += 1; },
      inputSource: mailbox,
      background: createBackgroundExecutionOwner(registry),
      signal, currentTurn: lifecycle,
      lifecycle: {
        onTurnEnded: () => { turnsEnded += 1; },
        onTurnParked: ({ park, userResumeRequired }) => {
          parks.push({ park, userResumeRequired });
          // While the host lands the park's durable writes, the person sends
          // /compact, which wakes the wait, and then presses Escape.
          if (parks.length === 1) { mailbox.enqueueCompact(); lifecycle.interrupt(); }
        },
      },
    }))).toBe(true);

    await waitUntil(() => (resets > 0 && parks.length >= 2) || loopError !== undefined, "the compaction did not reset and park again");
    throwLoopError(loopError);
    await Bun.sleep(20);
    expect(recorded).toBe(1);
    expect(resets).toBe(1);
    // The interrupted work park ended the turn once; the compaction ran its checkpoint request only.
    expect(capturedMessages).toHaveLength(2);
    expect(turnsEnded).toBe(1);
    expect(parks).toEqual([{ park: "waiting_on_work", userResumeRequired: false }, { park: "interrupted", userResumeRequired: true }]);

    lifecycle.abort({ kind: "aborted" });
    await lifecycle.done;
  });

  test("an idle checkpoint that wakes an idle park, then an Escape and a settings change that withdraw it, folds later input and parks for the person", async () => {
    const mailbox = new ChatTurnMailbox();
    const lifecycle = new RunLifecycle<AgentLoopTerminal>();
    const answer = (text: string) => ({ events: [{ kind: "text_delta" as const, text, blockKey: text }, { kind: "done" as const, stopReason: "end_turn" as const }] });
    const { client, capturedMessages } = makeCaptureClient([answer("Finished."), answer("an unauthorized request")]);
    const notes = withSessionNotes();
    let idleCompaction = true;
    let notified = false;
    const resolve = notes.tools.resolve.bind(notes.tools);
    notes.tools.resolve = async () => {
      const surface = await resolve();
      // A background result lands while the loop resolves the surface that
      // withdraws the checkpoint, after the loop took the checkpoint input.
      if (!idleCompaction && !notified) { notified = true; mailbox.enqueueSilentSystem("background task finished"); }
      return { ...surface, runtimeConfig: { ...surface.runtimeConfig, idleCompaction } };
    };
    const logicalStarts: string[] = [];
    const parks: { park: string; userResumeRequired: boolean }[] = [];
    let loopError: Error | undefined;
    void lifecycle.done.catch((error) => { loopError = error instanceof Error ? error : new Error(String(error)); });

    expect(lifecycle.start((signal) => runAgentLoop({
      client, tools: notes.tools, checkpoint: notes.checkpoint,
      systemPrompt: stableSystemPrompt("test"), instruction: "say done",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "idle-withdrawn", promptCacheKey: "idle-withdrawn", artifactScopeId: "idle-withdrawn", retrievalSessionId: "idle-withdrawn",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: mailbox,
      signal, currentTurn: lifecycle,
      lifecycle: {
        onLogicalTurnStarted: ({ origin }) => { logicalStarts.push(origin); },
        onTurnParked: ({ park, userResumeRequired }) => {
          parks.push({ park, userResumeRequired });
          // While the host lands the park's durable writes, the idle timer wakes
          // the wait, the person presses Escape, and then turns idle compaction off.
          if (parks.length === 1) { mailbox.enqueueCompact("idle"); lifecycle.interrupt(); idleCompaction = false; }
        },
      },
    }))).toBe(true);

    await waitUntil(() => parks.length >= 3 || loopError !== undefined, "the interrupted park did not park again after the late notification");
    throwLoopError(loopError);
    expect(notified).toBe(true);
    // The notification folded into history: it started no turn and no request.
    expect(logicalStarts).toEqual([]);
    expect(capturedMessages).toHaveLength(1);
    expect(parks).toEqual([
      { park: "idle", userResumeRequired: false },
      { park: "interrupted", userResumeRequired: true },
      { park: "interrupted", userResumeRequired: true },
    ]);

    lifecycle.abort({ kind: "aborted" });
    await lifecycle.done;
  });

  test("returns input_closed when the source closes after the interrupted wait", async () => {
    const lifecycle = new RunLifecycle<AgentLoopTerminal>();
    const { client } = makeCaptureClient([
      { events: [{ kind: "text_delta", text: "Waiting.", blockKey: "waiting" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    let parked = false;
    let waitCount = 0;

    expect(lifecycle.start((signal) => runAgentLoop({
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "wait",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "silent-system-closed-input", promptCacheKey: "silent-system-closed-input", artifactScopeId: "silent-system-closed-input",
      retrievalSessionId: "silent-system-closed-input",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: (waitSignal) => ({
          commit: async () => {
            waitCount += 1;
            if (waitCount > 1 || waitSignal?.aborted) return null;
            return await new Promise((resolve) => {
              waitSignal?.addEventListener("abort", () => resolve(null), { once: true });
            });
          },
          cancel: async () => {},
        }),
      },
      signal,
      currentTurn: lifecycle,
      lifecycle: { onTurnParked: () => { parked = true; } },
    }))).toBe(true);

    await waitUntil(() => parked, "turn did not park");
    expect(lifecycle.interrupt()).toBe(true);
    await expect(lifecycle.done).resolves.toEqual({ kind: "input_closed" });
    expect(waitCount).toBe(2);
  });
});
