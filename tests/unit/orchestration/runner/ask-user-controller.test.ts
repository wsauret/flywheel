import { describe, expect, it } from "bun:test";

import type { EmitFn } from "../../../../src/infra/event-bus.js";
import type { FlywheelEvent } from "../../../../src/infra/events.js";
import type { QuestionEntry } from "../../../../src/infra/output-blocks.js";
import { createAskUserController, type AskUserController } from "../../../../src/orchestration/runner/ask-user-controller.js";

type AskUserHost = Parameters<typeof createAskUserController>[0]["host"];
type CapturedEvent = { type: FlywheelEvent["type"]; sessionId: string };

const QUESTIONS: QuestionEntry[] = [{
  question: "Pick?",
  choices: [{ kind: "option", label: "A" }, { kind: "freeform", label: "Other" }],
  multiSelect: false,
}];

function answer(text: string) {
  return { kind: "choice" as const, selections: [{ choiceId: "choice-1" }], text };
}

function createController(host: Partial<AskUserHost>, events: CapturedEvent[]): AskUserController {
  const emit: EmitFn = (type, payload) => {
    events.push({ type, sessionId: payload.sessionId });
  };
  const noopHost: AskUserHost = {
    pushQuestion: () => {},
    answerQuestion: () => {},
    cancelQuestion: () => {},
    flush: () => {},
  };

  return createAskUserController({ host: { ...noopHost, ...host }, emit, sessionId: "s1" });
}

function factTypes(events: readonly CapturedEvent[]): FlywheelEvent["type"][] {
  return events.map((event) => event.type);
}

function countType(events: readonly CapturedEvent[], type: FlywheelEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

describe("createAskUserController", () => {
  it("resolves an active question with the user's answer and leaves its block to the committed settlement", async () => {
    const calls: string[] = [];
    const events: CapturedEvent[] = [];
    const controller = createController({
      pushQuestion: (toolUseId) => { calls.push(`push:${toolUseId}`); },
      answerQuestion: (toolUseId, answers) => { calls.push(`answer:${toolUseId}:${answers["Pick?"]}`); },
      cancelQuestion: (toolUseId) => { calls.push(`cancel:${toolUseId}`); },
      flush: () => { calls.push("flush"); },
    }, events);

    const result = controller.ask("tool_1", QUESTIONS);
    controller.answerQuestion("tool_1", { "Pick?": answer("A") });

    expect(await result).toEqual({ kind: "answered", answers: { "Pick?": answer("A") } });
    expect(calls).toEqual(["push:tool_1", "flush"]);
    expect(factTypes(events)).toEqual(["agent.user_input.awaiting", "agent.user_input.resumed"]);
    expect(countType(events, "agent.user_input.resumed")).toBe(1);
  });

  it("emits one awaiting and one final resumed for concurrent questions", async () => {
    const events: CapturedEvent[] = [];
    const controller = createController({}, events);

    const first = controller.ask("tool_a", QUESTIONS);
    const second = controller.ask("tool_b", QUESTIONS);

    expect(factTypes(events)).toEqual(["agent.user_input.awaiting"]);

    controller.answerQuestion("tool_a", { A: answer("1") });
    await expect(first).resolves.toEqual({ kind: "answered", answers: { A: answer("1") } });
    expect(factTypes(events)).toEqual(["agent.user_input.awaiting"]);

    controller.answerQuestion("tool_b", { B: answer("2") });
    await expect(second).resolves.toEqual({ kind: "answered", answers: { B: answer("2") } });
    expect(factTypes(events)).toEqual(["agent.user_input.awaiting", "agent.user_input.resumed"]);
    expect(countType(events, "agent.user_input.awaiting")).toBe(1);
    expect(countType(events, "agent.user_input.resumed")).toBe(1);
  });

  it("applies an answer that arrived before the tool started waiting, without lifecycle events", async () => {
    const calls: string[] = [];
    const events: CapturedEvent[] = [];
    const controller = createController({
      pushQuestion: (toolUseId) => { calls.push(`push:${toolUseId}`); },
      answerQuestion: (toolUseId) => { calls.push(`answer:${toolUseId}`); },
      cancelQuestion: () => {},
      flush: () => { calls.push("flush"); },
    }, events);

    controller.answerQuestion("tool_early", { "Continue?": answer("Yes") });
    calls.length = 0;

    await expect(controller.ask("tool_early", QUESTIONS)).resolves.toEqual({
      kind: "answered",
      answers: { "Continue?": answer("Yes") },
    });
    // The block did not exist when the answer landed, so ask re-applies it
    // right after pushing the block.
    expect(calls).toEqual(["push:tool_early", "answer:tool_early", "flush"]);
    expect(events).toEqual([]);
  });

  it("applies a cancel that arrived before the tool started waiting, without lifecycle events", async () => {
    const calls: string[] = [];
    const events: CapturedEvent[] = [];
    const controller = createController({
      answerQuestion: () => {},
      cancelQuestion: (toolUseId) => { calls.push(`cancel:${toolUseId}`); },
      flush: () => { calls.push("flush"); },
    }, events);

    controller.cancelQuestion("tool_early");
    calls.length = 0;

    await expect(controller.ask("tool_early", QUESTIONS)).resolves.toEqual({ kind: "cancelled" });
    expect(calls).toEqual(["cancel:tool_early", "flush"]);
    expect(events).toEqual([]);
  });

  it("suspends the durable question when the tool signal aborts", async () => {
    const calls: string[] = [];
    const events: CapturedEvent[] = [];
    const abortController = new AbortController();
    const controller = createController({
      answerQuestion: () => { calls.push("answer"); },
      cancelQuestion: (toolUseId) => { calls.push(`cancel:${toolUseId}`); },
      flush: () => { calls.push("flush"); },
    }, events);

    const result = controller.ask("tool_abort", QUESTIONS, abortController.signal);
    calls.length = 0;
    abortController.abort();

    expect(await result).toEqual({ kind: "suspended" });
    expect(calls).toEqual([]);
    expect(factTypes(events)).toEqual(["agent.user_input.awaiting", "agent.user_input.resumed"]);
    expect(countType(events, "agent.user_input.resumed")).toBe(1);
  });

  it("returns suspension without output mutation when the tool signal was already aborted", async () => {
    const calls: string[] = [];
    const events: CapturedEvent[] = [];
    const abortController = new AbortController();
    abortController.abort();
    const controller = createController({
      cancelQuestion: (toolUseId) => { calls.push(`cancel:${toolUseId}`); },
      flush: () => { calls.push("flush"); },
    }, events);

    await expect(controller.ask("tool_abort", QUESTIONS, abortController.signal)).resolves.toEqual({ kind: "suspended" });

    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });


  it("reports whether shutdown suspended a pending durable wait", async () => {
    const events: CapturedEvent[] = [];
    const controller = createController({}, events);
    const result = controller.ask("tool_pending", QUESTIONS);

    expect(controller.suspendAll()).toBe(true);
    expect(await result).toEqual({ kind: "suspended" });
    expect(controller.suspendAll()).toBe(false);
  });
});