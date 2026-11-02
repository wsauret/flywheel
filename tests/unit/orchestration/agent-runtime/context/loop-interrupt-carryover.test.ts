import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import type { AgentLoopTerminal } from "../../../../../src/orchestration/agent-runtime/agent-loop-types.js";
import { CONTINUATION_MESSAGES } from "../../../../../src/orchestration/agent-runtime/continuation-messages.js";
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type ProviderStreamEvent, type StreamOptions, type TurnModelClient } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { RunLifecycle } from "../../../../../src/orchestration/agent-runtime/run-lifecycle.js";
import { ChatTurnMailbox } from "../../../../../src/orchestration/chat/turn-mailbox.js";
import { interruptedTurnMessage } from "../../../../../src/orchestration/session/conversation/turn-end-record.js";
import { WorkflowInjectionQueue } from "../../../../../src/orchestration/workflow-host/injection-queue.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import type { RequestToolSurfaceOwner } from "../../../../../src/orchestration/agent-runtime/request-tool-surface.js";
import { chain, fakeAvailability, singletonCandidate } from "../llm/_provider-chain-harness.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { loginWaitingRequest } from "../_login-wait-fixture.js";
import { ownHistoryTarget } from "../_model-client.js";

async function waitUntil(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(2);
  if (!condition()) throw new Error(message);
}

/** A chat's mailbox and a workflow step's injection queue: the two input
 *  sources a parked loop takes a person's Resume from. */
const SOURCES = [
  ["chat", () => new ChatTurnMailbox()],
  ["workflow step", () => new WorkflowInjectionQueue()],
] as const;

/** What the loop did: turn ends it recorded, parks after an interrupt, and a failure. */
interface LoopObservation {
  recorded: number;
  interruptedParks: number;
  error?: Error;
}

/** Runs a loop whose first request streams until it is interrupted. Every
 *  later request completes, unless its turn opened interrupted. */
function startLoop(
  inputSource: ChatTurnMailbox | WorkflowInjectionQueue,
  onResumed: () => void = () => {},
  tools: RequestToolSurfaceOwner = new RequestToolMap(),
  overrideClient?: TurnModelClient,
  maxLLMCalls?: number,
  interruptFirstRequest = true,
) {
  const lifecycle = new RunLifecycle<AgentLoopTerminal>();
  const requests: { readonly messages: ConversationMessage[]; completed: boolean }[] = [];
  const history: ConversationMessage[] = [];
  const record: ConversationMessage = { kind: "user", content: interruptedTurnMessage("person", true), origin: "system" };
  const loop: LoopObservation = { recorded: 0, interruptedParks: 0 };
  void lifecycle.done.catch((error) => { loop.error = error instanceof Error ? error : new Error(String(error)); });
  const client = chain({
    candidates: [singletonCandidate("anthropic_api")],
    availability: fakeAvailability({}).availability,
    build: async () => ({ historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: 100_000, outputLimit: 8_000,
    supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION,
    async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      const request = { messages: [...options.messages], completed: false };
      requests.push(request);
      if (requests.length === 1 && interruptFirstRequest) {
        yield { kind: "text_delta", text: "Working", blockKey: "working" };
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      // A request whose turn is already cut ends as a real stream does.
      if (options.signal?.aborted) return;
      yield { kind: "text_delta", text: "Continuing.", blockKey: "continuing" };
      yield { kind: "done", stopReason: "end_turn" };
      request.completed = true;
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    }),
  });
  expect(lifecycle.start((signal) => runAgentLoop({
    client: overrideClient ?? client,
    maxLLMCalls,
    tools,
    systemPrompt: stableSystemPrompt("test"),
    instruction: "do the work",
    executionCwd: "/scratch",
    userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "interrupt-carryover", promptCacheKey: "interrupt-carryover", artifactScopeId: "interrupt-carryover", retrievalSessionId: "interrupt-carryover",
    persistence: {
      history: { append: (message) => { history.push(message); } },
      recordInterruption: async () => { loop.recorded += 1; return record; },
    },
    seed: { kind: "fresh" },
    onEvent: () => {},
    inputSource,
    signal,
    currentTurn: lifecycle,
    lifecycle: {
      onTurnParked: ({ userResumeRequired }) => { if (userResumeRequired) loop.interruptedParks += 1; },
      onTurnResumed: onResumed,
    },
  }))).toBe(true);
  const settled = (condition: () => boolean, message: string) => waitUntil(() => condition() || loop.error !== undefined, message).then(() => {
    if (loop.error) throw loop.error;
  });
  return { lifecycle, requests, history, record, loop, settled };
}

describe("an Escape between a Resume and the turn it opens", () => {
  for (const [kind, source] of SOURCES) {
    test(`${kind}: the first model request settles without an earlier interruption owner`, async () => {
      const { lifecycle, requests, loop, settled } = startLoop(source(), undefined, undefined, undefined, undefined, false);
      try {
        await settled(() => requests[0]?.completed === true, "the first request did not complete");
        expect(requests).toHaveLength(1);
        expect(loop.error).toBeUndefined();
      } finally {
        lifecycle.abort({ kind: "aborted" });
        await lifecycle.done;
      }
    });

    test(`${kind}: an Escape after the Resume cuts the resumed turn, records its end, and a second Resume continues`, async () => {
      const inputSource = source();
      let escapeOnResume = false;
      // The Resume is accepted here; the loop has not opened its next turn yet.
      const { lifecycle, requests, record, loop, settled } = startLoop(inputSource, () => {
        if (escapeOnResume) expect(lifecycle.interrupt()).toBe(true);
      });

      await settled(() => requests.length >= 1, "the first request did not start");
      expect(lifecycle.interrupt()).toBe(true);
      await settled(() => loop.interruptedParks >= 1, "the interrupted turn did not park");
      expect(loop.recorded).toBe(1);

      escapeOnResume = true;
      inputSource.enqueueResume();
      await settled(() => loop.interruptedParks >= 2, "the Escape after the Resume did not cut the resumed turn");
      escapeOnResume = false;
      expect(loop.recorded).toBe(2);
      expect(requests.some((request) => request.completed)).toBe(false);

      inputSource.enqueueResume();
      await settled(() => requests.some((request) => request.completed), "the second Resume did not continue");
      expect(loop.recorded).toBe(2);
      // The model reads the interrupt, the Resume, the interrupt, the Resume.
      const context = requests.find((request) => request.completed)?.messages ?? [];
      const trail = context.flatMap((message) => message.kind !== "user" ? [] : message.content === record.content ? ["interrupted"] : message.content === CONTINUATION_MESSAGES.resumed ? ["resumed"] : []);
      expect(trail).toEqual(["interrupted", "resumed", "interrupted", "resumed"]);

      lifecycle.abort({ kind: "aborted" });
      await lifecycle.done;
    });

    test(`${kind}: a second Escape before the Resume does not cut the resumed turn`, async () => {
      const inputSource = source();
      const { lifecycle, requests, loop, settled } = startLoop(inputSource);

      await settled(() => requests.length >= 1, "the first request did not start");
      expect(lifecycle.interrupt()).toBe(true);
      // A double press, or a lagging status: the turn is already interrupted.
      lifecycle.interrupt();
      await settled(() => loop.interruptedParks >= 1, "the interrupted turn did not park");
      lifecycle.interrupt();

      inputSource.enqueueResume();
      await settled(() => requests.some((request) => request.completed), "the Resume did not continue");
      expect(loop.recorded).toBe(1);
      expect(loop.interruptedParks).toBe(1);

      lifecycle.abort({ kind: "aborted" });
      await lifecycle.done;
    });
  }
});

describe("interrupting an account login wait", () => {
  for (const [kind, source] of SOURCES) {
    for (const budget of [false, true]) {
      test(`${kind}: ${budget ? "budget summary" : "request"} wait releases on interrupt and parks without a login failure`, async () => {
        const fixture = loginWaitingRequest("continued");
        const input = source();
        const { lifecycle, loop, settled, history } = startLoop(input, undefined, undefined, fixture.client, budget ? 0 : undefined);
        try {
          await fixture.entered;
          expect(lifecycle.interrupt()).toBe(true);
          await settled(() => loop.interruptedParks === 1, "login wait did not park after interruption");
          expect(loop.recorded).toBe(1);
          expect(fixture.calls()).toBe(1);
          expect(history.some((message) => message.kind === "assistant")).toBe(false);
          fixture.renew();
          expect(fixture.calls()).toBe(1);
          input.enqueueResume();
          await settled(() => fixture.calls() > 1, "explicit Resume did not continue");
          expect(loop.error).toBeUndefined();
        } finally {
          lifecycle.abort({ kind: "aborted" });
          await lifecycle.done;
        }
      });
    }
  }
  test("a renewed request settles twice inside the same interruption owner", async () => {
    const fixture = loginWaitingRequest("continued");
    const { lifecycle, loop, settled, history } = startLoop(new ChatTurnMailbox(), undefined, undefined, fixture.client);
    try {
      await fixture.entered;
      fixture.renew();
      await settled(() => history.some((message) => message.kind === "assistant"), "renewed execution did not settle");
      expect(fixture.calls()).toBe(2);
      expect(loop.error).toBeUndefined();
    } finally {
      lifecycle.abort({ kind: "aborted" });
      await lifecycle.done;
    }
  });
});

describe("an Escape while the next request's admission waits", () => {
  test("keeps the adopted message once, cuts the turn it starts before any request, and records the turn end", async () => {
    const inputSource = new ChatTurnMailbox();
    const base = new RequestToolMap();
    let resolves = 0;
    let admissionHeld = false;
    const admissionGate = Promise.withResolvers<void>();
    // Every admission after the first request's holds until the gate opens,
    // as an admission that reads remote usage evidence does.
    const tools: RequestToolSurfaceOwner = {
      async resolve() {
        resolves += 1;
        if (resolves === 2) {
          admissionHeld = true;
          await admissionGate.promise;
        }
        return base.resolve();
      },
      current: () => base.current(),
    };
    const { lifecycle, requests, history, record, loop, settled } = startLoop(inputSource, () => {}, tools);
    await settled(() => requests.length >= 1, "the first request did not start");
    expect(lifecycle.interrupt()).toBe(true);
    await settled(() => loop.interruptedParks >= 1, "the interrupted turn did not park");

    inputSource.enqueueNextTurn({ text: "next task" });
    await settled(() => admissionHeld, "the message did not reach the request boundary");
    const isSent = (message: ConversationMessage) => message.kind === "user" && message.content === "next task";
    await settled(() => history.some(isSent), "the message was not adopted while admission waits");
    expect(lifecycle.interrupt()).toBe(true);
    admissionGate.resolve();

    await settled(() => loop.interruptedParks >= 2, "the Escape did not cut the turn the message started");
    expect(loop.recorded).toBe(2);
    expect(requests.some((request) => request.completed)).toBe(false);
    expect(requests).toHaveLength(1);
    expect(history.filter(isSent)).toHaveLength(1);

    // A Resume continues: the model reads the message once, then the turn end that cut it.
    inputSource.enqueueResume();
    await settled(() => requests.some((request) => request.completed), "the Resume did not continue");
    const context = requests.find((request) => request.completed)?.messages ?? [];
    const trail = context.flatMap((message) => message.kind !== "user" ? [] : isSent(message) ? ["sent"] : message.content === record.content ? ["interrupted"] : []);
    expect(trail).toEqual(["interrupted", "sent", "interrupted"]);

    lifecycle.abort({ kind: "aborted" });
    await lifecycle.done;
  });
});
