import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/infra/event-bus";
import {
  QuestionService,
  QuestionRejectedError,
  type QuestionInfo,
  type QuestionAnswer,
} from "../src/workflows/queue/question-service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): { service: QuestionService; bus: EventBus } {
  const bus = new EventBus();
  const service = new QuestionService(bus);
  return { service, bus };
}

function sampleQuestions(): QuestionInfo[] {
  return [
    {
      question: "Should auto_chain default to true?",
      header: "auto_chain default",
      options: [
        { label: "true", description: "Chain automatically" },
        { label: "false", description: "Stop between stages" },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// ask() — suspends until reply or reject
// ---------------------------------------------------------------------------

describe("QuestionService.ask", () => {
  it("publishes question:asked event and returns a Promise that suspends", async () => {
    const { service, bus } = makeService();
    const events: Array<{ type: string; requestId: string }> = [];

    bus.subscribeToType("question:asked", (e) => {
      events.push({ type: e.type, requestId: e.requestId });
    });

    const questions = sampleQuestions();
    const promise = service.ask(questions);

    // Event should have been emitted synchronously
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("question:asked");
    expect(events[0].requestId).toBeTruthy();

    // Promise should still be pending (not resolved)
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });
    // Flush microtasks
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Now reply to resolve
    const requestId = events[0].requestId;
    service.reply(requestId, [["true"]]);

    const result = await promise;
    expect(result).toEqual([["true"]]);
  });

  it("includes questions in the asked event", () => {
    const { service, bus } = makeService();
    let receivedQuestions: QuestionInfo[] = [];

    bus.subscribeToType("question:asked", (e) => {
      receivedQuestions = e.questions;
    });

    const questions = sampleQuestions();
    service.ask(questions);

    expect(receivedQuestions).toEqual(questions);
  });

  it("generates unique request IDs for each ask call", () => {
    const { service, bus } = makeService();
    const ids: string[] = [];

    bus.subscribeToType("question:asked", (e) => {
      ids.push(e.requestId);
    });

    service.ask(sampleQuestions());
    service.ask(sampleQuestions());

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ---------------------------------------------------------------------------
// reply()
// ---------------------------------------------------------------------------

describe("QuestionService.reply", () => {
  it("resolves the suspended Promise with answers", async () => {
    const { service, bus } = makeService();
    let requestId = "";

    bus.subscribeToType("question:asked", (e) => {
      requestId = e.requestId;
    });

    const promise = service.ask(sampleQuestions());
    const answers: QuestionAnswer[] = [["true"]];
    service.reply(requestId, answers);

    const result = await promise;
    expect(result).toEqual(answers);
  });

  it("publishes question:replied event", () => {
    const { service, bus } = makeService();
    let requestId = "";
    const repliedEvents: Array<{ requestId: string; answers: QuestionAnswer[] }> = [];

    bus.subscribeToType("question:asked", (e) => {
      requestId = e.requestId;
    });
    bus.subscribeToType("question:replied", (e) => {
      repliedEvents.push({ requestId: e.requestId, answers: e.answers });
    });

    service.ask(sampleQuestions());
    const answers: QuestionAnswer[] = [["false"]];
    service.reply(requestId, answers);

    expect(repliedEvents).toHaveLength(1);
    expect(repliedEvents[0].requestId).toBe(requestId);
    expect(repliedEvents[0].answers).toEqual(answers);
  });

  it("removes request from pending list after reply", () => {
    const { service, bus } = makeService();
    let requestId = "";

    bus.subscribeToType("question:asked", (e) => {
      requestId = e.requestId;
    });

    service.ask(sampleQuestions());
    expect(service.list()).toHaveLength(1);

    service.reply(requestId, [["true"]]);
    expect(service.list()).toHaveLength(0);
  });

  it("is a no-op for unknown request IDs", () => {
    const { service } = makeService();
    // Should not throw
    service.reply("nonexistent-id", [["yes"]]);
  });
});

// ---------------------------------------------------------------------------
// reject()
// ---------------------------------------------------------------------------

describe("QuestionService.reject", () => {
  it("rejects the suspended Promise with QuestionRejectedError", async () => {
    const { service, bus } = makeService();
    let requestId = "";

    bus.subscribeToType("question:asked", (e) => {
      requestId = e.requestId;
    });

    const promise = service.ask(sampleQuestions());
    service.reject(requestId);

    try {
      await promise;
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(QuestionRejectedError);
    }
  });

  it("publishes question:rejected event", () => {
    const { service, bus } = makeService();
    let requestId = "";
    const rejectedEvents: string[] = [];

    bus.subscribeToType("question:asked", (e) => {
      requestId = e.requestId;
    });
    bus.subscribeToType("question:rejected", (e) => {
      rejectedEvents.push(e.requestId);
    });

    // Catch the rejection to avoid unhandled rejection error
    const promise = service.ask(sampleQuestions());
    promise.catch(() => {});
    service.reject(requestId);

    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0]).toBe(requestId);
  });

  it("removes request from pending list after reject", () => {
    const { service, bus } = makeService();
    let requestId = "";

    bus.subscribeToType("question:asked", (e) => {
      requestId = e.requestId;
    });

    // Catch the rejection to avoid unhandled rejection error
    const promise = service.ask(sampleQuestions());
    promise.catch(() => {});
    expect(service.list()).toHaveLength(1);

    service.reject(requestId);
    expect(service.list()).toHaveLength(0);
  });

  it("is a no-op for unknown request IDs", () => {
    const { service } = makeService();
    // Should not throw
    service.reject("nonexistent-id");
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("QuestionService.list", () => {
  it("returns pending question requests", () => {
    const { service } = makeService();

    service.ask(sampleQuestions());
    service.ask([
      {
        question: "Second question?",
        header: "Second",
        options: [],
      },
    ]);

    const pending = service.list();
    expect(pending).toHaveLength(2);
    expect(pending[0].questions).toEqual(sampleQuestions());
    expect(pending[1].questions[0].question).toBe("Second question?");
  });

  it("returns empty array when no pending requests", () => {
    const { service } = makeService();
    expect(service.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multiple concurrent requests (independence)
// ---------------------------------------------------------------------------

describe("QuestionService — concurrent requests", () => {
  it("multiple concurrent question requests are independent", async () => {
    const { service, bus } = makeService();
    const requestIds: string[] = [];

    bus.subscribeToType("question:asked", (e) => {
      requestIds.push(e.requestId);
    });

    const promise1 = service.ask([
      { question: "Q1?", header: "Q1", options: [] },
    ]);
    const promise2 = service.ask([
      { question: "Q2?", header: "Q2", options: [] },
    ]);

    expect(requestIds).toHaveLength(2);
    expect(service.list()).toHaveLength(2);

    // Reply to second first
    service.reply(requestIds[1], [["answer2"]]);
    const result2 = await promise2;
    expect(result2).toEqual([["answer2"]]);

    // First should still be pending
    expect(service.list()).toHaveLength(1);

    // Reply to first
    service.reply(requestIds[0], [["answer1"]]);
    const result1 = await promise1;
    expect(result1).toEqual([["answer1"]]);

    expect(service.list()).toHaveLength(0);
  });

  it("rejecting one request does not affect others", async () => {
    const { service, bus } = makeService();
    const requestIds: string[] = [];

    bus.subscribeToType("question:asked", (e) => {
      requestIds.push(e.requestId);
    });

    const promise1 = service.ask([
      { question: "Q1?", header: "Q1", options: [] },
    ]);
    const promise2 = service.ask([
      { question: "Q2?", header: "Q2", options: [] },
    ]);

    // Reject first
    service.reject(requestIds[0]);

    try {
      await promise1;
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(QuestionRejectedError);
    }

    // Second should still be resolvable
    service.reply(requestIds[1], [["answer2"]]);
    const result2 = await promise2;
    expect(result2).toEqual([["answer2"]]);
  });
});

// ---------------------------------------------------------------------------
// Auto-resolve mode
// ---------------------------------------------------------------------------

describe("QuestionService — auto-resolve", () => {
  it("resolves with defaults immediately when autoResolve is true", async () => {
    const bus = new EventBus();
    const service = new QuestionService(bus, { autoResolve: true });

    const questions: QuestionInfo[] = [
      {
        question: "Pick an option?",
        header: "Pick",
        options: [
          { label: "first", description: "First option" },
          { label: "second", description: "Second option" },
        ],
        default: "first",
      },
    ];

    const result = await service.ask(questions);
    // Should resolve with the default value
    expect(result).toEqual([["first"]]);
    // Should NOT leave anything pending
    expect(service.list()).toHaveLength(0);
  });

  it("resolves with first option label when no default is specified", async () => {
    const bus = new EventBus();
    const service = new QuestionService(bus, { autoResolve: true });

    const questions: QuestionInfo[] = [
      {
        question: "Pick an option?",
        header: "Pick",
        options: [
          { label: "alpha", description: "Alpha option" },
          { label: "beta", description: "Beta option" },
        ],
      },
    ];

    const result = await service.ask(questions);
    expect(result).toEqual([["alpha"]]);
  });

  it("resolves with empty answer for questions with no options and no default", async () => {
    const bus = new EventBus();
    const service = new QuestionService(bus, { autoResolve: true });

    const questions: QuestionInfo[] = [
      {
        question: "Any thoughts?",
        header: "Thoughts",
        options: [],
      },
    ];

    const result = await service.ask(questions);
    expect(result).toEqual([[]]);
  });

  it("does not emit question:asked event in auto-resolve mode", () => {
    const bus = new EventBus();
    const service = new QuestionService(bus, { autoResolve: true });
    let eventCount = 0;

    bus.subscribeToType("question:asked", () => {
      eventCount++;
    });

    service.ask(sampleQuestions());
    expect(eventCount).toBe(0);
  });
});
