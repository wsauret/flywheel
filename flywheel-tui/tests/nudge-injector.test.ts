import { describe, expect, test } from "bun:test";

import { createNudgeInjector } from "../src/orchestration/engines/providers/harness/nudge-injector.js";
import type { ContentBlock } from "../src/orchestration/engines/providers/harness/llm/types.js";
import type { TodoItem } from "../src/orchestration/engines/providers/harness/tools/types.js";

function makeToolResultBlock(id: string, content = "ok"): ContentBlock {
  return { type: "tool_result", tool_use_id: id, content };
}

function makeTodoItems(n: number): TodoItem[] {
  const items: TodoItem[] = [];
  for (let i = 1; i <= n; i++) {
    items.push({
      id: `task-${i}`,
      content: `task ${i}`,
      status: i === 1 ? "in_progress" : "pending",
    });
  }
  return items;
}

function textBlocks(blocks: ReadonlyArray<ContentBlock>): Array<{ type: "text"; text: string }> {
  return blocks.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>;
}

describe("createNudgeInjector", () => {
  describe("decorate with plain user message (no tool_results)", () => {
    test("returns unchanged blocks when existing has no tool_result", () => {
      const injector = createNudgeInjector();
      const existing: ContentBlock[] = [{ type: "text", text: "hello" }];
      const decorated = injector.decorate(existing, {
        llmCalls: 5,
        maxCalls: 200,
        todoList: [],
      });
      expect(decorated).toEqual(existing);
    });

    test("does not mutate existing when no changes apply", () => {
      const injector = createNudgeInjector();
      const existing: ContentBlock[] = [{ type: "text", text: "hello" }];
      const snapshot = JSON.stringify(existing);
      injector.decorate(existing, {
        llmCalls: 5,
        maxCalls: 200,
        todoList: [],
      });
      expect(JSON.stringify(existing)).toBe(snapshot);
    });
  });

  describe("budget nudge", () => {
    test("appended as last block every turn when tool_results present", () => {
      const injector = createNudgeInjector();
      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const decorated = injector.decorate(existing, {
        llmCalls: 5,
        maxCalls: 200,
        todoList: [],
      });
      const last = decorated[decorated.length - 1]!;
      expect(last.type).toBe("text");
      const text = (last as { type: "text"; text: string }).text;
      expect(text).toContain("<system-reminder>");
      expect(text).toContain("Pacing:");
      expect(text).toContain("5/200 model calls used");
      expect(text).toContain("195 remaining");
    });

    test("budget math reflects provided llmCalls/maxCalls", () => {
      const injector = createNudgeInjector();
      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const decorated = injector.decorate(existing, {
        llmCalls: 2,
        maxCalls: 50,
        todoList: [],
      });
      const last = decorated[decorated.length - 1] as { type: "text"; text: string };
      expect(last.text).toContain("2/50 model calls used");
      expect(last.text).toContain("48 remaining");
    });
  });

  describe("create-todo nudge cadence", () => {
    test("does not fire before threshold (5 non-todo tool calls)", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 5; i++) injector.onToolCall("bash");

      const existing: ContentBlock[] = [makeToolResultBlock("tc_5")];
      const decorated = injector.decorate(existing, {
        llmCalls: 5,
        maxCalls: 200,
        todoList: [],
      });

      const texts = textBlocks(decorated).map((b) => b.text);
      expect(texts.some((t) => t.includes("without creating a todo list"))).toBe(false);
    });

    test("fires at threshold (6 non-todo tool calls) when todo list is empty", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 6; i++) injector.onToolCall("bash");

      const existing: ContentBlock[] = [makeToolResultBlock("tc_6")];
      const decorated = injector.decorate(existing, {
        llmCalls: 6,
        maxCalls: 200,
        todoList: [],
      });

      const first = decorated[0]!;
      expect(first.type).toBe("text");
      expect((first as { type: "text"; text: string }).text).toContain("without creating a todo list");
    });

    test("fires only once across multiple decorate calls", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 6; i++) injector.onToolCall("bash");

      const ctx = {
        llmCalls: 6,
        maxCalls: 200,
        todoList: [],
      };
      const existing: ContentBlock[] = [makeToolResultBlock("tc_6")];
      const first = injector.decorate(existing, ctx);
      injector.onToolCall("bash");
      injector.onToolCall("bash");
      const second = injector.decorate(existing, ctx);

      const firstTexts = textBlocks(first).map((b) => b.text);
      const secondTexts = textBlocks(second).map((b) => b.text);
      expect(firstTexts.some((t) => t.includes("without creating a todo list"))).toBe(true);
      expect(secondTexts.some((t) => t.includes("without creating a todo list"))).toBe(false);
    });

    test("never fires when todo list is non-empty", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 20; i++) injector.onToolCall("bash");

      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const decorated = injector.decorate(existing, {
        llmCalls: 20,
        maxCalls: 200,
        todoList: makeTodoItems(3),
      });

      const texts = textBlocks(decorated).map((b) => b.text);
      expect(texts.some((t) => t.includes("without creating a todo list"))).toBe(false);
    });

    test("todo_list calls do not count toward threshold", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 10; i++) injector.onToolCall("todo_list");

      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const decorated = injector.decorate(existing, {
        llmCalls: 10,
        maxCalls: 200,
        todoList: [],
      });

      const texts = textBlocks(decorated).map((b) => b.text);
      expect(texts.some((t) => t.includes("without creating a todo list"))).toBe(false);
    });

    test("persists total non-todo counter across todo mutations (create-nudge uses cumulative count)", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 6; i++) injector.onToolCall("bash");
      injector.onTodoMutation();

      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const decorated = injector.decorate(existing, {
        llmCalls: 6,
        maxCalls: 200,
        todoList: [],
      });

      const texts = textBlocks(decorated).map((b) => b.text);
      expect(texts.some((t) => t.includes("without creating a todo list"))).toBe(true);
    });
  });

  describe("todo state injection (non-empty todo list)", () => {
    test("always injects current list state as first block when list non-empty", () => {
      const injector = createNudgeInjector();
      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const decorated = injector.decorate(existing, {
        llmCalls: 1,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      });

      const first = decorated[0]!;
      expect(first.type).toBe("text");
      expect((first as { type: "text"; text: string }).text).toContain("Current todo list state");
    });

    test("does not inject state when todo list is empty", () => {
      const injector = createNudgeInjector();
      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const decorated = injector.decorate(existing, {
        llmCalls: 1,
        maxCalls: 200,
        todoList: [],
      });

      const texts = textBlocks(decorated).map((b) => b.text);
      expect(texts.some((t) => t.includes("Current todo list state"))).toBe(false);
    });
  });

  describe("stale-todo reminder cadence", () => {
    test("does not fire before 10 non-todo tool calls accumulate since last mutation", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 9; i++) injector.onToolCall("bash");

      const existing: ContentBlock[] = [makeToolResultBlock("tc_9")];
      const decorated = injector.decorate(existing, {
        llmCalls: 9,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      });

      const texts = textBlocks(decorated).map((b) => b.text);
      expect(texts.some((t) => t.includes("Your todo list looks stale"))).toBe(false);
    });

    test("fires at 10 non-todo tool calls with todo list non-empty (both counters >= 10)", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 10; i++) injector.onToolCall("bash");

      const existing: ContentBlock[] = [makeToolResultBlock("tc_10")];
      const decorated = injector.decorate(existing, {
        llmCalls: 10,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      });

      const first = decorated[0]!;
      expect(first.type).toBe("text");
      expect((first as { type: "text"; text: string }).text).toContain("Your todo list looks stale");
    });

    test("stale reminder appears BEFORE todo state injection (reminder is first)", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 10; i++) injector.onToolCall("bash");

      const existing: ContentBlock[] = [makeToolResultBlock("tc_10")];
      const decorated = injector.decorate(existing, {
        llmCalls: 10,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      });

      const first = decorated[0] as { type: "text"; text: string };
      const second = decorated[1] as { type: "text"; text: string };
      expect(first.text).toContain("Your todo list looks stale");
      expect(second.text).toContain("Current todo list state");
    });

    test("does not fire before cooldown satisfied (>=10 tool calls since last nudge)", () => {
      const injector = createNudgeInjector();
      // Fire a nudge by hitting 10 calls.
      for (let i = 0; i < 10; i++) injector.onToolCall("bash");
      const ctx = {
        llmCalls: 10,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      };
      const first = injector.decorate([makeToolResultBlock("tc_10")], ctx);
      expect(textBlocks(first).some((b) => b.text.includes("Your todo list looks stale"))).toBe(true);

      // Add 9 more non-todo tool calls (total since last mutation = 19, since nudge = 9).
      for (let i = 0; i < 9; i++) injector.onToolCall("bash");
      const second = injector.decorate([makeToolResultBlock("tc_19")], ctx);
      // Cooldown not satisfied: nudge must not fire.
      expect(textBlocks(second).some((b) => b.text.includes("Your todo list looks stale"))).toBe(false);
    });

    test("fires again after cooldown (10 more non-todo calls past previous nudge)", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 10; i++) injector.onToolCall("bash");
      const ctx = {
        llmCalls: 10,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      };
      const first = injector.decorate([makeToolResultBlock("tc_10")], ctx);
      expect(textBlocks(first).some((b) => b.text.includes("Your todo list looks stale"))).toBe(true);

      // Add exactly 10 more non-todo tool calls (since last nudge = 10, since mutation = 20).
      for (let i = 0; i < 10; i++) injector.onToolCall("bash");
      const second = injector.decorate([makeToolResultBlock("tc_20")], ctx);
      expect(textBlocks(second).some((b) => b.text.includes("Your todo list looks stale"))).toBe(true);
    });

    test("onTodoMutation resets both since-mutation and since-nudge counters", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 9; i++) injector.onToolCall("bash");
      injector.onTodoMutation();
      // 9 more non-todo calls (would be 18 cumulative without reset).
      for (let i = 0; i < 9; i++) injector.onToolCall("bash");

      const existing: ContentBlock[] = [makeToolResultBlock("tc_9")];
      const decorated = injector.decorate(existing, {
        llmCalls: 18,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      });

      const texts = textBlocks(decorated).map((b) => b.text);
      expect(texts.some((t) => t.includes("Your todo list looks stale"))).toBe(false);
    });
  });

  describe("no-mutation contract", () => {
    test("decorate returns a new array (different reference)", () => {
      const injector = createNudgeInjector();
      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const decorated = injector.decorate(existing, {
        llmCalls: 1,
        maxCalls: 200,
        todoList: [],
      });
      expect(decorated).not.toBe(existing);
    });

    test("decorate does not mutate the existing array", () => {
      const injector = createNudgeInjector();
      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const lenBefore = existing.length;
      const firstBefore = existing[0];
      injector.decorate(existing, {
        llmCalls: 1,
        maxCalls: 200,
        todoList: makeTodoItems(3),
      });
      expect(existing.length).toBe(lenBefore);
      expect(existing[0]).toBe(firstBefore);
    });

    test("decorate does not mutate with both state injection and stale reminder", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 10; i++) injector.onToolCall("bash");
      const existing: ContentBlock[] = [makeToolResultBlock("tc_10")];
      const snapshot = [...existing];
      injector.decorate(existing, {
        llmCalls: 10,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      });
      expect(existing).toEqual(snapshot);
    });
  });

  describe("block ordering contract", () => {
    test("empty todo list with create-nudge: [create-nudge, ...existing, budget]", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 6; i++) injector.onToolCall("bash");
      const existing: ContentBlock[] = [makeToolResultBlock("tc_6")];
      const decorated = injector.decorate(existing, {
        llmCalls: 6,
        maxCalls: 200,
        todoList: [],
      });

      expect(decorated.length).toBe(3);
      expect(decorated[0]!.type).toBe("text");
      expect((decorated[0] as { text: string }).text).toContain("without creating a todo list");
      expect(decorated[1]!.type).toBe("tool_result");
      expect(decorated[2]!.type).toBe("text");
      expect((decorated[2] as { text: string }).text).toContain("Pacing:");
    });

    test("non-empty todo list without stale: [state, ...existing, budget]", () => {
      const injector = createNudgeInjector();
      const existing: ContentBlock[] = [makeToolResultBlock("tc_1")];
      const decorated = injector.decorate(existing, {
        llmCalls: 1,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      });

      expect(decorated.length).toBe(3);
      expect(decorated[0]!.type).toBe("text");
      expect((decorated[0] as { text: string }).text).toContain("Current todo list state");
      expect(decorated[1]!.type).toBe("tool_result");
      expect(decorated[2]!.type).toBe("text");
      expect((decorated[2] as { text: string }).text).toContain("Pacing:");
    });

    test("non-empty todo list with stale: [stale, state, ...existing, budget]", () => {
      const injector = createNudgeInjector();
      for (let i = 0; i < 10; i++) injector.onToolCall("bash");
      const existing: ContentBlock[] = [makeToolResultBlock("tc_10")];
      const decorated = injector.decorate(existing, {
        llmCalls: 10,
        maxCalls: 200,
        todoList: makeTodoItems(2),
      });

      expect(decorated.length).toBe(4);
      expect((decorated[0] as { text: string }).text).toContain("Your todo list looks stale");
      expect((decorated[1] as { text: string }).text).toContain("Current todo list state");
      expect(decorated[2]!.type).toBe("tool_result");
      expect((decorated[3] as { text: string }).text).toContain("Pacing:");
    });
  });
});
