import { describe, it, expect } from "bun:test";
import { createQuestionWiring } from "../src/tui/utils/question-wiring";
import { EventBus } from "../src/events/event-bus";
import type { QuestionRequest } from "../src/controller/question-service";

describe("createQuestionWiring", () => {
  it("creates a QuestionService and wires events", () => {
    const bus = new EventBus();
    let lastQuestion: QuestionRequest | null = null;
    let cleared = false;

    const wiring = createQuestionWiring({
      eventBus: bus,
      onQuestion: (q) => { lastQuestion = q; },
      onClear: () => { cleared = true; },
    });

    expect(wiring.service).toBeDefined();
    expect(typeof wiring.cleanup).toBe("function");
  });

  it("onQuestion fires when question:asked is emitted with pending questions", async () => {
    const bus = new EventBus();
    let lastQuestion: QuestionRequest | null = null;

    const wiring = createQuestionWiring({
      eventBus: bus,
      onQuestion: (q) => { lastQuestion = q; },
      onClear: () => {},
    });

    // Ask a question through the service — this emits question:asked
    const answerPromise = wiring.service.ask([{
      question: "Pick one",
      header: "Test",
      options: [{ label: "A", description: "Option A" }],
    }]);

    // The event should have triggered onQuestion
    expect(lastQuestion).not.toBeNull();
    expect(lastQuestion!.questions[0].question).toBe("Pick one");

    // Clean up (rejects pending questions)
    wiring.cleanup();
    try { await answerPromise; } catch { /* expected rejection */ }
  });

  it("onClear fires when question:replied is emitted", () => {
    const bus = new EventBus();
    let cleared = false;

    createQuestionWiring({
      eventBus: bus,
      onQuestion: () => {},
      onClear: () => { cleared = true; },
    });

    bus.emit({
      type: "question:replied",
      requestId: "q1",
      answers: [["answer"]],
      timestamp: new Date().toISOString(),
    });

    expect(cleared).toBe(true);
  });

  it("onClear fires when question:rejected is emitted", () => {
    const bus = new EventBus();
    let cleared = false;

    createQuestionWiring({
      eventBus: bus,
      onQuestion: () => {},
      onClear: () => { cleared = true; },
    });

    bus.emit({
      type: "question:rejected",
      requestId: "q1",
      timestamp: new Date().toISOString(),
    });

    expect(cleared).toBe(true);
  });

  it("cleanup rejects pending questions and unsubscribes", async () => {
    const bus = new EventBus();
    let questionCount = 0;

    const wiring = createQuestionWiring({
      eventBus: bus,
      onQuestion: () => { questionCount++; },
      onClear: () => {},
    });

    // Ask a question
    const answerPromise = wiring.service.ask([{
      question: "Will be rejected",
      header: "Test",
      options: [],
    }]);
    expect(questionCount).toBe(1);

    // Cleanup
    wiring.cleanup();

    // answerPromise should reject
    let rejected = false;
    try { await answerPromise; } catch { rejected = true; }
    expect(rejected).toBe(true);

    // After cleanup, further events don't trigger callbacks
    questionCount = 0;
    bus.emit({
      type: "question:asked",
      questions: [],
      timestamp: new Date().toISOString(),
    } as any);
    expect(questionCount).toBe(0);
  });

  it("cleanup is idempotent", async () => {
    const bus = new EventBus();
    let clearCount = 0;

    const wiring = createQuestionWiring({
      eventBus: bus,
      onQuestion: () => {},
      onClear: () => { clearCount++; },
    });

    wiring.cleanup();
    wiring.cleanup();
    wiring.cleanup();

    // onClear only called once (first cleanup)
    expect(clearCount).toBe(1);
  });

  it("two wirings on separate buses don't interfere", async () => {
    const busA = new EventBus();
    const busB = new EventBus();
    let questionA: QuestionRequest | null = null;
    let questionB: QuestionRequest | null = null;

    const wiringA = createQuestionWiring({
      eventBus: busA,
      onQuestion: (q) => { questionA = q; },
      onClear: () => {},
    });

    const wiringB = createQuestionWiring({
      eventBus: busB,
      onQuestion: (q) => { questionB = q; },
      onClear: () => {},
    });

    // Ask on A only
    const promiseA = wiringA.service.ask([{
      question: "Question A",
      header: "A",
      options: [],
    }]);

    expect(questionA).not.toBeNull();
    expect(questionB).toBeNull();

    wiringA.cleanup();
    wiringB.cleanup();
    try { await promiseA; } catch { /* expected */ }
  });
});
