// Self-contained agentic loop — no coupling to NDJSONEvent, EngineRunner, or the TUI.

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
import { ContextLengthExceededError, OutputLengthExceededError, RetryableStreamError } from "./llm/types.js";
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
const MAX_STREAM_RETRIES = 5;
const TRANSIENT_RETRY_BASE_MS = 500;
const RATE_LIMIT_MIN_MS = 5_000;
const RATE_LIMIT_MAX_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

function streamRetryBackoff(attempt: number, err: RetryableStreamError): number {
  switch (err.kind) {
    case "transient":
      return TRANSIENT_RETRY_BASE_MS + Math.random() * TRANSIENT_RETRY_BASE_MS;
    case "rate_limit": {
      const exponential = Math.min(RATE_LIMIT_MIN_MS * 2 ** (attempt - 1), RATE_LIMIT_MAX_MS);
      return exponential + exponential * 0.2 * Math.random();
    }
    case "overload":
    case "unknown":
    default: {
      const exponential = Math.min(DEFAULT_RETRY_BASE_MS * 2 ** (attempt - 1), DEFAULT_RETRY_MAX_MS);
      return exponential + Math.random() * DEFAULT_RETRY_BASE_MS * 0.5;
    }
  }
}

function withTodoState(handoffText: string, items: ReadonlyArray<TodoItem>): string {
  if (items.length === 0) return handoffText;
  return `${handoffText}\n\n<todo_state>\nYour todo list is preserved across context recovery. Do not call todo_list(read) — here is the current state:\n${formatTodoList(items)}\n</todo_state>`;
}

interface AgentLoopOptions {
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
  onUserMessage?: (content: string | ContentBlock[]) => void;
  onTurnComplete?: () => void;
  onTurnAssistantMessage?: (content: ContentBlock[]) => void;
  reasoningEffort?: ReasoningEffort;
  /** Shared queue of pending user inputs. The runner pushes via send();
   *  the loop shifts at text-exit boundaries to continue as a new user turn. */
  pendingUserInputs?: string[];
  priorMessages?: Message[];
  /** Called whenever a message is pushed to history — enables streaming persistence. */
  onMessageAppended?: (message: Message) => void;
  /** Default 200. */
  maxLLMCalls?: number;
  sessionId?: string;
  /** Restored from a previous session — lets providers resume server-side state. */
  previousResponseId?: string;
}

type AgentLoopOutcome = "ok" | "context_overflow" | "budget_exhausted";

interface AgentLoopResult {
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
    readFiles: new Set(),
    availableTools: new Set(tools.map((t) => t.name)),
  };

  const maxLLMCalls = options.maxLLMCalls ?? 200;
  let llmCallCount = 0;

  const hasTodoTool = tools.some((t) => t.name === "todo_list");
  let turnsSinceTodoMutation = 0;
  let turnsSinceTodoNudge = 0;

  let nextInput: NextInput = { kind: "initial", text: instruction };
  let contextOverflow = false;
  let previousResponseId: string | undefined = options.previousResponseId;
  let streamRetries = 0;
  // Anchored context tracking (matches Claude Code / Codex pattern):
  // After each API call, record the actual input_tokens from the response.
  // Between calls, add heuristic estimates for newly pushed messages.
  let lastApiPromptTokens = 0;
  let heuristicAtLastApiCall = 0;

  function estimateContextTokens(): number {
    if (lastApiPromptTokens > 0) {
      return lastApiPromptTokens + (tokenCounter.total - heuristicAtLastApiCall);
    }
    // No API anchor yet (first call, or post-compaction). Estimate from
    // the current messages array so compaction resets are reflected.
    const fresh = createTokenCounter();
    for (const m of messages) fresh.addMessage(m);
    return fresh.total;
  }

  for (;;) {
    if (signal?.aborted) {
      log.info("agent loop aborted by signal");
      break;
    }

    const contextTokens = estimateContextTokens();
    if (messages.length > 0 && summarizer.shouldSummarize(contextTokens, client.contextLimit)) {
      log.info("proactive summarization triggered", { contextTokens, contextLimit: client.contextLimit });
      const compactStart = Date.now();
      onEvent({ kind: "compaction_start" });
      try {
        if (nextInput.kind === "initial") {
          options.pendingUserInputs?.unshift(nextInput.text);
          log.info("preserved user message before compaction");
        }
        const handoff = await summarizer.summarize(messages, systemPrompt, cwd, signal);
        if (handoff) {
          applyHandoff(messages, handoff);
          nextInput = { kind: "recovered", handoff: withTodoState(handoff.userPrompt, todoList) };
          contextOverflow = true;
          previousResponseId = undefined;
          lastApiPromptTokens = 0;
          heuristicAtLastApiCall = 0;
        }
        onEvent({ kind: "compaction_done", success: true, durationMs: Date.now() - compactStart });
      } catch (err) {
        onEvent({ kind: "compaction_done", success: false, durationMs: Date.now() - compactStart });
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
              ...(event.summary ? { summary: event.summary } : {}),
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
          case "usage":
            lastApiPromptTokens = event.inputTokens + event.cacheReadTokens;
            heuristicAtLastApiCall = tokenCounter.total;
            break;
          case "done":
            stopReason = event.stopReason;
            if (event.responseId) previousResponseId = event.responseId;
            break;
        }
      }
    } catch (err) {
      if (err instanceof ContextLengthExceededError) {
        log.warn("context length exceeded, attempting recovery", { contextTokens: estimateContextTokens(), contextLimit: client.contextLimit });
        const compactStart = Date.now();
        onEvent({ kind: "compaction_start" });
        if (nextInput.kind === "initial") {
          options.pendingUserInputs?.unshift(nextInput.text);
          log.info("preserved user message before context recovery");
        }
        contextOverflow = true;
        previousResponseId = undefined;
        lastApiPromptTokens = 0;
        heuristicAtLastApiCall = 0;
        unwindMessages(messages, client.contextLimit);
        try {
          const handoff = await summarizer.summarize(messages, systemPrompt, cwd, signal);
          if (handoff) {
            applyHandoff(messages, handoff);
            nextInput = { kind: "recovered", handoff: withTodoState(handoff.userPrompt, todoList) };
          } else {
            nextInput = { kind: "recovered", handoff: withTodoState(instruction, todoList) };
          }
          onEvent({ kind: "compaction_done", success: true, durationMs: Date.now() - compactStart });
        } catch (compactErr) {
          onEvent({ kind: "compaction_done", success: false, durationMs: Date.now() - compactStart });
          throw compactErr;
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

      if (err instanceof RetryableStreamError && streamRetries < MAX_STREAM_RETRIES) {
        streamRetries++;
        llmCallCount--;
        const delay = err.retryDelayMs ?? streamRetryBackoff(streamRetries, err);
        log.warn(`stream error, retrying (${streamRetries}/${MAX_STREAM_RETRIES}) in ${Math.round(delay)}ms`, {
          message: err.message,
        });
        await Bun.sleep(delay);
        continue;
      }

      throw err;
    }

    streamRetries = 0;

    pushMessage({ role: "user", content: userPrompt });

    if (assistantContent.length > 0) {
      options.onTurnAssistantMessage?.(assistantContent);
      pushMessage({ role: "assistant", content: assistantContent });
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
        } catch (err) {
          if (steeringAbort.signal.aborted || signal?.aborted) return { tc, skipped: true as const };
          log.warn("tool execution threw", { tool: tc.name, error: errorMessage(err) });
          throw err;
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
