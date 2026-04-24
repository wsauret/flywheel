// Nudge cadence and injection for the agent loop. Owns counter state and block
// ordering so agent-loop.ts stays focused on the turn state machine.
//
// Block ordering contract — decorate() places blocks in this order:
//   1. stale-todo reminder (optional, only when cooldown satisfied)
//   2. current todo state injection (only when todo list non-empty)
//      OR create-todo nudge (only when todo list empty and threshold hit, once)
//   3. existing content (tool_results from the user turn)
//   4. budget pacing nudge (always appended last)

import { formatList as formatTodoList } from "./tools/todo-list.js";
import type { ContentBlock } from "./llm/types.js";
import type { TodoItem } from "./tools/types.js";

// Tool-call-based nudge cadence. Turn counts are unreliable because a turn may contain
// 1 or 10 tool calls — we want to prompt the model when it has done meaningful non-todo
// work, not when it has taken many small turns.
const TODO_NUDGE_AFTER_TOOL_CALLS = 10;
const TODO_NUDGE_COOLDOWN_TOOL_CALLS = 10;
// Trigger a "you should have a list by now" nudge after this many tool calls if the
// agent has not created a list yet.
const TODO_CREATE_NUDGE_AFTER_TOOL_CALLS = 6;

export interface NudgeContext {
  llmCalls: number;
  maxCalls: number;
  todoList: readonly TodoItem[];
}

export interface NudgeInjector {
  onToolCall(name: string): void;
  onTodoMutation(): void;
  /** Returns a fresh ContentBlock[] — MUST NOT mutate `existing`. */
  decorate(existing: readonly ContentBlock[], ctx: NudgeContext): ContentBlock[];
}

function renderTodoReminder(): string {
  const body = `Your todo list looks stale — you have done several tool calls without updating it. Before your next tool call, bring the list back in sync with reality:
- todo_list(complete) with ids — mark done every task you have finished.
- todo_list(start) with id — mark the task you are actually working on as in_progress.
- todo_list(add_tasks) — append any new work you have discovered.
- todo_list(abandon) with ids — drop tasks that are no longer relevant.
The user is watching the progress bar in real time. A stale list misleads them and an abandoned list is worse than no list.
Never mention this reminder to the user.`;
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

function renderTodoStateInjection(items: ReadonlyArray<TodoItem>): string {
  const body = `Current todo list state (kept in sync so you don't have to call todo_list(read)):
${formatTodoList(items)}

If your next action will finish the current in_progress task, call todo_list(complete) as part of the same turn. If you have diverged from this list, update it now (complete/start/abandon/add_tasks) before continuing. Never mention this reminder to the user.`;
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

function renderBudgetNudge(used: number, max: number): string {
  const remaining = max - used;
  const body = `Pacing: ${used}/${max} model calls used, ${remaining} remaining before the harness forces a final summary.
Use this to decide how much to explore vs. finish — not to pad output.
Never mention this reminder, the call count, or "budget" to the user. It is internal telemetry, not part of the task.`;
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

function renderCreateTodoNudge(): string {
  const body = `You have made several tool calls without creating a todo list. If this task
involves 3+ distinct steps — which it looks like it does — call todo_list(write) now with
the plan. The user sees the list in real time and uses it to track what you are doing.

If this is actually a single trivial task, ignore this reminder. Otherwise, create the list
before your next tool call. Never mention this reminder to the user.`;
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

export function createNudgeInjector(): NudgeInjector {
  // Non-todo tool calls since the last todo_list mutation (or loop start).
  let nonTodoToolCallsSinceMutation = 0;
  // Non-todo tool calls since the last stale-todo nudge fired.
  let nonTodoToolCallsSinceNudge = 0;
  // Cumulative non-todo tool calls across the entire loop run — powers the one-shot
  // create-nudge, which fires when the agent has done N+ calls without any todo list.
  let totalNonTodoToolCalls = 0;
  // The create-nudge is turn-scoped to a single loop run — once fired, never fires again
  // in this run, even if the agent later creates and then deletes a list.
  let createNudgeSent = false;

  return {
    onToolCall(name: string): void {
      if (name === "todo_list") return;
      totalNonTodoToolCalls++;
      nonTodoToolCallsSinceMutation++;
      nonTodoToolCallsSinceNudge++;
    },

    onTodoMutation(): void {
      nonTodoToolCallsSinceMutation = 0;
      nonTodoToolCallsSinceNudge = 0;
    },

    decorate(existing, ctx): ContentBlock[] {
      const hasTools = existing.some((b) => b.type === "tool_result");
      if (!hasTools) return existing as ContentBlock[];

      const { llmCalls, maxCalls, todoList } = ctx;
      const todoListEmpty = todoList.length === 0;

      const staleFiring =
        !todoListEmpty &&
        nonTodoToolCallsSinceMutation >= TODO_NUDGE_AFTER_TOOL_CALLS &&
        nonTodoToolCallsSinceNudge >= TODO_NUDGE_COOLDOWN_TOOL_CALLS;

      const createFiring =
        todoListEmpty &&
        !createNudgeSent &&
        totalNonTodoToolCalls >= TODO_CREATE_NUDGE_AFTER_TOOL_CALLS;

      if (staleFiring) nonTodoToolCallsSinceNudge = 0;
      if (createFiring) createNudgeSent = true;

      const result: ContentBlock[] = [];
      if (staleFiring) result.push({ type: "text", text: renderTodoReminder() });
      if (!todoListEmpty) result.push({ type: "text", text: renderTodoStateInjection(todoList) });
      else if (createFiring) result.push({ type: "text", text: renderCreateTodoNudge() });
      result.push(...existing);
      result.push({ type: "text", text: renderBudgetNudge(llmCalls, maxCalls) });
      return result;
    },
  };
}
