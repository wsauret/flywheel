/**
 * Core agentic loop with streaming and context recovery.
 *
 * Structure: each iteration (1) builds messages from NextInput,
 * (2) streams LLM response, (3) dispatches tool calls, (4) advances state.
 *
 * Self-contained -- knows nothing about NDJSONEvent, EngineRunner, or the TUI.
 * Works with LLMClient, StreamEvent, and ToolContext.
 */

import { errorMessage } from "../../../../infra/error-message.js";
import { Log } from "../../../../infra/log.js";
import type {
  LLMClient,
  Message,
  ReasoningEffort,
  StreamEvent,
  ToolCall,
  ContentBlock,
} from "./llm/types.js";
import { ContextLengthExceededError, OutputLengthExceededError } from "./llm/types.js";
import { executeTool, getToolDefinitions } from "./tools/tool-dispatch.js";
import { formatList as formatTodoList } from "./tools/todo-list.js";
import type { ToolContext, TodoItem } from "./tools/types.js";
import { limitOutput } from "./context/truncation.js";
import { createTokenCounter } from "./context/token-counter.js";
import { createSummarizer, unwindMessages } from "./context/summarizer.js";
import { renderNextInput, applyHandoff } from "./agent-state.js";
import type { NextInput, ToolResultEntry } from "./agent-state.js";

const log = Log.create({ service: "harness-agent-loop" });

const TODO_NUDGE_AFTER_TURNS = 10;
const TODO_NUDGE_COOLDOWN_TURNS = 10;

function withTodoState(handoffText: string, items: ReadonlyArray<TodoItem>): string {
  if (items.length === 0) return handoffText;
  return `${handoffText}\n\n<todo_state>\nYour todo list is preserved across context recovery. Do not call todo_list(read) — here is the current state:\n${formatTodoList(items)}\n</todo_state>`;
}

export interface AgentLoopOptions {
  client: LLMClient;
  tools?: ReturnType<typeof getToolDefinitions>;
  systemPrompt: string;
  /** The user's task instruction — becomes the first user message.
   *  When priorMessages is non-empty, this is the next turn (e.g. a revision request). */
  instruction: string;
  cwd: string;
  handoffPath?: string;
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void;
  /** Fires when a new user turn is sent to the model. */
  onUserMessage?: (content: string | ContentBlock[]) => void;
  /** Fires when the model yields to the user (no tool calls, ready for next message). */
  onTurnComplete?: () => void;
  onTurnAssistantMessage?: (content: ContentBlock[]) => void;
  reasoningEffort?: ReasoningEffort;
  /** Shared queue of pending user inputs. The runner pushes via send();
   *  the loop shifts at text-exit boundaries to continue as a new user turn. */
  pendingUserInputs?: string[];
  /** Prior messages from a resumed conversation. Seeds the loop's history. */
  priorMessages?: Message[];
  /** Called whenever a message is pushed to history — enables streaming persistence. */
  onMessageAppended?: (message: Message) => void;
  /** Maximum number of LLM calls before the loop terminates. Default 200. */
  maxLLMCalls?: number;
  sessionId?: string;
  /** Restored from a previous session — lets providers resume server-side state. */
  previousResponseId?: string;
}

export type AgentLoopOutcome = "ok" | "context_overflow" | "budget_exhausted";

export interface AgentLoopResult {
  outcome: AgentLoopOutcome;
  previousResponseId?: string;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    client,
    systemPrompt,
    instruction,
    cwd,
    handoffPath,
    signal,
    onEvent,
    reasoningEffort,
  } = options;

  const tools = options.tools ?? getToolDefinitions();
  const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

  const messages: Message[] = options.priorMessages ? [...options.priorMessages] : [];
  const tokenCounter = createTokenCounter();
  const summarizer = createSummarizer(client);
  const todoList: TodoItem[] = [];

  function pushMessage(message: Message): void {
    messages.push(message);
    tokenCounter.addMessage(message);
    options.onMessageAppended?.(message);
  }

  // Seed token counter from resumed messages (counts happen via addMessage on push,
  // so we pre-count the prior slice to keep totals accurate).
  for (const m of messages) tokenCounter.addMessage(m);

  const toolContext: ToolContext = {
    cwd,
    signal,
    handoffPath,
    todoList,
  };

  const maxLLMCalls = options.maxLLMCalls ?? 200;
  let llmCallCount = 0;

  const hasTodoTool = (options.tools ?? getToolDefinitions()).some((t) => t.name === "todo_list");
  let turnsSinceTodoMutation = 0;
  let turnsSinceTodoNudge = 0;

  let nextInput: NextInput = { kind: "initial", text: instruction };
  let contextOverflow = false;
  let previousResponseId: string | undefined = options.previousResponseId;

  for (;;) {
    if (signal?.aborted) {
      log.info("agent loop aborted by signal");
      break;
    }

    if (messages.length > 0 && summarizer.shouldSummarize(tokenCounter.total, client.contextLimit)) {
      log.info("proactive summarization triggered");
      try {
        const handoff = await summarizer.summarize(messages, systemPrompt, cwd, signal);
        if (handoff) {
          applyHandoff(messages, handoff);
          nextInput = { kind: "recovered", handoff: withTodoState(handoff.userPrompt, todoList) };
          contextOverflow = true;
          // Server-side conversation chain is invalid after compaction — fall back
          // to stateless mode where encrypted reasoning blocks carry the context.
          previousResponseId = undefined;
        }
      } catch (err) {
        log.error("proactive summarization failed", {
          error: errorMessage(err),
        });
      }
    }

    const userPrompt = renderNextInput(nextInput);
    options.onUserMessage?.(userPrompt);

    if (nextInput.kind === "observation" && Array.isArray(userPrompt)) {
      const budgetLine = `[Budget: ${llmCallCount}/${maxLLMCalls} calls used, ${maxLLMCalls - llmCallCount} remaining]`;
      userPrompt.push({ type: "text", text: budgetLine });

      const inProgress = hasTodoTool
        ? toolContext.todoList.find((t) => t.status === "in_progress")
        : undefined;
      if (
        inProgress &&
        turnsSinceTodoMutation >= TODO_NUDGE_AFTER_TURNS &&
        turnsSinceTodoNudge >= TODO_NUDGE_COOLDOWN_TURNS
      ) {
        userPrompt.push({ type: "text", text:
          `[Todo: "${inProgress.content}" is still in_progress — if done, call todo_list(complete). The user is watching the progress bar.]`,
        });
        turnsSinceTodoNudge = 0;
      }
    }

    const turnMessages: Message[] = [...messages, { role: "user", content: userPrompt }];

    let assistantContent: ContentBlock[] = [];
    let toolCalls: ToolCall[] = [];
    let stopReason = "";

    if (llmCallCount >= maxLLMCalls) {
      log.info("budget exhausted", { llmCallCount, maxLLMCalls });

      const exhaustionMessage = `Budget exhausted (${maxLLMCalls} LLM calls used). Provide a final summary of progress and remaining work.`;
      pushMessage({ role: "user", content: exhaustionMessage });

      const finalStream = client.streamWithTools({
        messages: [...messages],
        tools: [],
        systemPrompt,
        reasoningEffort,
        signal,
        previousResponseId,
      });

      const finalContent: ContentBlock[] = [];
      for await (const event of finalStream) {
        onEvent(event);
        if (event.kind === "text_delta") {
          appendTextBlock(finalContent, event.text);
        }
        if (event.kind === "done" && event.responseId) {
          previousResponseId = event.responseId;
        }
      }

      if (finalContent.length > 0) {
        options.onTurnAssistantMessage?.(finalContent);
        pushMessage({ role: "assistant", content: finalContent });
      }

      return { outcome: "budget_exhausted", previousResponseId };
    }

    try {
      llmCallCount++;
      const stream = client.streamWithTools({
        messages: turnMessages,
        tools: toolDefs,
        systemPrompt,
        reasoningEffort,
        signal,
        previousResponseId,
      });

      for await (const event of stream) {
        if (signal?.aborted) {
          log.info("stream aborted mid-turn");
          break;
        }

        onEvent(event);

        switch (event.kind) {
          case "text_delta":
            appendTextBlock(assistantContent, event.text);
            break;
          case "thinking_delta":
            break;
          case "thinking_complete":
            if (event.signature) {
              assistantContent.push({
                type: "thinking",
                thinking: event.thinking,
                signature: event.signature,
              });
            }
            break;
          case "reasoning":
            assistantContent.push({
              type: "reasoning",
              id: event.id,
              encrypted_content: event.encryptedContent,
            });
            break;
          case "tool_use":
            toolCalls.push(event.toolCall);
            assistantContent.push({
              type: "tool_use",
              id: event.toolCall.id,
              name: event.toolCall.name,
              input: event.toolCall.input,
            });
            break;
          case "done":
            stopReason = event.stopReason;
            if (event.responseId) previousResponseId = event.responseId;
            break;
        }
      }
    } catch (err) {
      if (err instanceof ContextLengthExceededError) {
        log.warn("context length exceeded, attempting recovery");
        contextOverflow = true;
        previousResponseId = undefined;
        unwindMessages(messages, client.contextLimit);
        const handoff = await summarizer.summarize(messages, systemPrompt, cwd, signal);
        if (handoff) {
          applyHandoff(messages, handoff);
          nextInput = { kind: "recovered", handoff: withTodoState(handoff.userPrompt, todoList) };
        } else {
          nextInput = { kind: "recovered", handoff: withTodoState(instruction, todoList) };
        }
        continue;
      }

      if (err instanceof OutputLengthExceededError) {
        log.warn("output length exceeded, auto-resuming");
        pushMessage({ role: "user", content: userPrompt });
        if (err.truncatedContent) {
          pushMessage({ role: "assistant", content: err.truncatedContent });
          tokenCounter.addToolResult(err.truncatedContent);
        }
        nextInput = { kind: "resume-truncation" };
        continue;
      }

      throw err;
    }

    const userMessage: Message = { role: "user", content: userPrompt };
    pushMessage(userMessage);

    if (assistantContent.length > 0) {
      options.onTurnAssistantMessage?.(assistantContent);
      const assistantMessage: Message = { role: "assistant", content: assistantContent };
      pushMessage(assistantMessage);
    }

    if (toolCalls.length === 0) {
      options.onTurnComplete?.();
      if (options.pendingUserInputs && options.pendingUserInputs.length > 0) {
        const next = options.pendingUserInputs.shift()!;
        nextInput = { kind: "initial", text: next };
        continue;
      }
      log.info("no tool calls in response, completing", { stopReason });
      return { outcome: contextOverflow ? "context_overflow" : "ok", previousResponseId };
    }

    const toolResults: ToolResultEntry[] = [];
    const steeringAbort = new AbortController();
    const toolSignal = signal
      ? AbortSignal.any([signal, steeringAbort.signal])
      : steeringAbort.signal;
    const steeringContext: ToolContext = { ...toolContext, signal: toolSignal };

    const settled = await Promise.allSettled(
      toolCalls.map(async (tc) => {
        if (steeringAbort.signal.aborted || signal?.aborted) return { tc, skipped: true as const };
        try {
          const result = await executeTool(tc.name, tc.input, steeringContext);
          if (options.pendingUserInputs?.length && !steeringAbort.signal.aborted) {
            steeringAbort.abort();
          }
          return { tc, skipped: false as const, result };
        } catch {
          if (steeringAbort.signal.aborted || signal?.aborted) return { tc, skipped: true as const };
          throw undefined;
        }
      }),
    );

    let todoMutated = false;
    for (let i = 0; i < settled.length; i++) {
      const entry = settled[i]!;
      if (entry.status === "rejected") {
        const tc = toolCalls[i]!;
        const content = "Tool execution failed.";
        onEvent({ kind: "tool_result", toolCallId: tc.id, content });
        toolResults.push({ toolCallId: tc.id, content, isError: true });
        continue;
      }
      const value = entry.value;
      if (!value) continue;
      if (value.skipped) {
        const content = signal?.aborted ? "Interrupted by user." : "Skipped due to queued user message.";
        onEvent({ kind: "tool_result", toolCallId: value.tc.id, content });
        toolResults.push({ toolCallId: value.tc.id, content, isError: true });
      } else {
        const { text: content } = await limitOutput(value.result.content, undefined, cwd, options.sessionId);
        onEvent({ kind: "tool_result", toolCallId: value.tc.id, content });
        toolResults.push({ toolCallId: value.tc.id, content });
        tokenCounter.addToolResult(content);
        if (value.tc.name === "todo_list" && value.tc.input?.operation !== "read") todoMutated = true;
      }
    }

    if (todoMutated) {
      turnsSinceTodoMutation = 0;
      turnsSinceTodoNudge = 0;
      if (toolContext.todoList.length > 0) {
        onEvent({
          kind: "todo_state",
          todos: toolContext.todoList.map((t) => ({
            id: t.id,
            content: t.content,
            status: t.status,
            ...(t.notes ? { notes: t.notes } : {}),
          })),
        });
      }
    } else {
      turnsSinceTodoMutation++;
      turnsSinceTodoNudge++;
    }

    if (signal?.aborted && toolResults.length > 0) {
      const observationPrompt = renderNextInput({ kind: "observation", toolResults });
      pushMessage({ role: "user", content: observationPrompt });
      break;
    }

    if (options.pendingUserInputs && options.pendingUserInputs.length > 0) {
      const observationPrompt = renderNextInput({ kind: "observation", toolResults });
      pushMessage({ role: "user", content: observationPrompt });
      const next = options.pendingUserInputs.shift()!;
      nextInput = { kind: "initial", text: next };
    } else {
      nextInput = { kind: "observation", toolResults };
    }
  }

  return { outcome: contextOverflow ? "context_overflow" : "ok", previousResponseId };
}

function appendTextBlock(blocks: ContentBlock[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    last.text += text;
  } else {
    blocks.push({ type: "text", text });
  }
}

