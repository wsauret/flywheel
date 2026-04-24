// Summarization/compaction helpers extracted from the agent loop. The loop still
// decides *when* to compact (signal check, token threshold, context error); these
// helpers own the mechanics of summarizing, applying the handoff, and emitting
// the compaction_start/done event pair.

import { errorMessage } from "../../../../infra/error-message.js";
import { Log } from "../../../../infra/log.js";
import type { Message, StreamEvent } from "./llm/types.js";
import type { TodoItem } from "./tools/types.js";
import type { createSummarizer } from "./context/summarizer.js";
import { applyHandoff } from "./agent-state.js";
import { formatList as formatTodoList } from "./tools/todo-list.js";

const log = Log.create({ service: "harness-compaction" });

type Summarizer = ReturnType<typeof createSummarizer>;

export function withTodoState(handoffText: string, items: ReadonlyArray<TodoItem>): string {
  if (items.length === 0) return handoffText;
  return `${handoffText}\n\n<todo_state>\nYour todo list is preserved across context recovery. Do not call todo_list(read) — here is the current state:\n${formatTodoList(items)}\n</todo_state>`;
}

export interface CompactionInput {
  summarizer: Summarizer;
  messages: Message[];
  systemPrompt: string;
  cwd: string;
  signal: AbortSignal | undefined;
  todoList: ReadonlyArray<TodoItem>;
  onEvent: (event: StreamEvent) => void;
}

export interface CompactionOutcome {
  applied: boolean;
  /** When present, the caller should push this as the next user message. */
  promptToInject?: string;
}

/** Proactive compaction — swallows errors so the loop can continue. */
export async function runProactiveCompaction(input: CompactionInput): Promise<CompactionOutcome> {
  const compactStart = Date.now();
  input.onEvent({ kind: "compaction_start" });
  try {
    const handoff = await input.summarizer.summarize(input.messages, input.systemPrompt, input.cwd, input.signal);
    if (handoff) {
      applyHandoff(input.messages, handoff);
      const promptToInject = withTodoState(handoff.userPrompt, input.todoList);
      input.onEvent({ kind: "compaction_done", success: true, durationMs: Date.now() - compactStart });
      return { applied: true, promptToInject };
    }
    input.onEvent({ kind: "compaction_done", success: true, durationMs: Date.now() - compactStart });
    return { applied: false };
  } catch (err) {
    input.onEvent({ kind: "compaction_done", success: false, durationMs: Date.now() - compactStart });
    log.error("proactive summarization failed", { error: errorMessage(err) });
    return { applied: false };
  }
}

export interface ReactiveCompactionInput extends CompactionInput {
  /** Fallback prompt if summarization returns no handoff. */
  fallbackInstruction: string;
}

/** Reactive compaction (after a ContextLengthExceededError). Rethrows on failure. */
export async function runReactiveCompaction(input: ReactiveCompactionInput): Promise<CompactionOutcome> {
  const compactStart = Date.now();
  input.onEvent({ kind: "compaction_start" });
  try {
    const handoff = await input.summarizer.summarize(input.messages, input.systemPrompt, input.cwd, input.signal);
    if (handoff) applyHandoff(input.messages, handoff);
    const promptToInject = withTodoState(handoff?.userPrompt ?? input.fallbackInstruction, input.todoList);
    input.onEvent({ kind: "compaction_done", success: true, durationMs: Date.now() - compactStart });
    return { applied: handoff != null, promptToInject };
  } catch (compactErr) {
    input.onEvent({ kind: "compaction_done", success: false, durationMs: Date.now() - compactStart });
    throw compactErr;
  }
}
