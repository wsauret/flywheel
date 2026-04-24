// Agent turn state machine: owns the stream/tool-execution loop end-to-end.
// Peripheral concerns (nudge cadence, context compaction retry, summarization)
// live in sibling modules to keep this file scoped to sequencing.

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
import { getToolDefinitions } from "./tools/tool-dispatch.js";
import type { ToolContext, ToolDefinition, TodoItem } from "./tools/types.js";
import { createTokenCounter } from "./context/token-counter.js";
import { createSummarizer, unwindMessages } from "./context/summarizer.js";
import { appendTextBlock, renderToolResults } from "./agent-state.js";
import { createNudgeInjector } from "./nudge-injector.js";
import { runProactiveCompaction, runReactiveCompaction } from "./compaction-cycle.js";
import { runBudgetExhaustTurn } from "./budget-exhaust.js";
import { MAX_STREAM_RETRIES, streamRetryBackoff } from "./stream-retry.js";
import { executeToolCallsParallel } from "./tool-execution.js";

const log = Log.create({ service: "harness-agent-loop" });

const DEFAULT_MAX_LLM_CALLS = 200;

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
  takeNextQueued?: () => string | null;
  hasQueuedInput?: () => boolean;
  priorMessages?: Message[];
  /** Called once per new message push. Prefer this over persistMessages when
   *  provided — it appends one line vs rewriting the whole file. */
  persistAppend?: (message: Message) => void;
  /** Full-rewrite callback. Used for compaction (when the messages array is
   *  replaced) and for in-place merges into the trailing user message. Also
   *  serves as fallback when persistAppend is absent. */
  persistMessages?: (messages: ReadonlyArray<Message>) => void;
  /** Default 200. */
  maxLLMCalls?: number;
  sessionId?: string;
  /** Restored from a previous session — lets providers resume server-side state. */
  previousResponseId?: string;
  /** Dynamically created tools (e.g. subagent) injected by the runner. */
  extraTools?: ReadonlyMap<string, ToolDefinition>;
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

  const baseTools = options.tools ?? getToolDefinitions();
  const extraToolDefs = options.extraTools ? Array.from(options.extraTools.values()) : [];
  const tools = extraToolDefs.length > 0 ? [...baseTools, ...extraToolDefs] : baseTools;
  const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

  const messages: Message[] = options.priorMessages ? [...options.priorMessages] : [];
  const tokenCounter = createTokenCounter();
  const summarizer = createSummarizer(client);
  const todoList: TodoItem[] = [];

  for (const m of messages) tokenCounter.addMessage(m);

  function pushMessage(message: Message): void {
    messages.push(message);
    tokenCounter.addMessage(message);
    if (options.persistAppend) {
      options.persistAppend(message);
    } else {
      options.persistMessages?.(messages);
    }
  }

  function pushUser(content: string | ContentBlock[]): void {
    options.onUserMessage?.(content);
    pushMessage({ role: "user", content });
  }

  const toolContext: ToolContext = {
    cwd,
    signal,
    handoffPath,
    todoList,
    readFiles: new Set(),
    availableTools: new Set(tools.map((t) => t.name)),
  };

  const maxLLMCalls = options.maxLLMCalls ?? DEFAULT_MAX_LLM_CALLS;
  let llmCallCount = 0;

  const nudge = createNudgeInjector();

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
    // No API anchor yet (first call, or post-compaction). tokenCounter is
    // kept in sync with `messages` via pushMessage and the reset-on-compaction
    // paths below, so we can read its total directly.
    return tokenCounter.total;
  }

  // Loop invariant: `messages` ends on a user message whenever a stream call
  // is about to happen. Every branch that reaches a stream call must restore
  // this — seed, recovery paths, and tool turns all push a user message.
  //
  // On resume, priorMessages may already end on a user message (e.g., a
  // tool_result turn the previous runner persisted before dying). A naive
  // pushUser(instruction) would land two user messages in a row and break
  // Anthropic's role-alternation rule, surfacing as a 400 "tool_use ids
  // were found without tool_result blocks immediately after" error. Merge
  // into the trailing user message instead so the tool_results still sit
  // adjacent to the assistant(tool_use) that produced them.
  const tail = messages[messages.length - 1];
  if (tail && tail.role === "user") {
    const existing: ContentBlock[] = typeof tail.content === "string"
      ? [{ type: "text", text: tail.content }]
      : [...tail.content];
    existing.push({ type: "text", text: instruction });
    messages[messages.length - 1] = { role: "user", content: existing };
    tokenCounter.addMessage({ role: "user", content: [{ type: "text", text: instruction }] });
    options.onUserMessage?.(instruction);
    // This path replaces the last message in place, so append-mode would
    // leave the prior trailing line orphaned on disk — use full rewrite.
    options.persistMessages?.(messages);
  } else {
    pushUser(instruction);
  }

  for (;;) {
    if (signal?.aborted) {
      log.info("agent loop aborted by signal");
      break;
    }

    const contextTokens = estimateContextTokens();
    if (messages.length > 0 && summarizer.shouldSummarize(contextTokens, client.contextLimit)) {
      log.info("proactive summarization triggered", { contextTokens, contextLimit: client.contextLimit });
      const result = await runProactiveCompaction({
        summarizer, messages, systemPrompt, cwd, signal, todoList, onEvent,
      });
      if (result.applied) {
        contextOverflow = true;
        previousResponseId = undefined;
        lastApiPromptTokens = 0;
        heuristicAtLastApiCall = 0;
        tokenCounter.resetFor(messages);
        // Handoff replaced the messages array — sync disk with the new state.
        options.persistMessages?.(messages);
        if (result.promptToInject != null) pushUser(result.promptToInject);
      }
    }

    if (llmCallCount >= maxLLMCalls) {
      log.info("budget exhausted", { llmCallCount, maxLLMCalls });
      pushUser(`Budget exhausted (${maxLLMCalls} LLM calls used). Provide a final summary of progress and remaining work.`);
      const { finalContent, previousResponseId: nextId } = await runBudgetExhaustTurn({
        client, messages, systemPrompt, reasoningEffort, signal, previousResponseId, onEvent,
      });
      previousResponseId = nextId;
      if (finalContent.length > 0) {
        options.onTurnAssistantMessage?.(finalContent);
        pushMessage({ role: "assistant", content: finalContent });
      }
      return { outcome: "budget_exhausted", previousResponseId };
    }

    // Decorate the last user message with nudges for THIS request only.
    // The on-disk log stays clean so retries and resumes don't accumulate duplicates.
    let turnMessages: Message[] = messages;
    const last = messages[messages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) {
      const augmented = nudge.decorate(last.content, {
        llmCalls: llmCallCount,
        maxCalls: maxLLMCalls,
        todoList: toolContext.todoList,
      });
      turnMessages = [...messages.slice(0, -1), { ...last, content: augmented }];
    }

    let assistantContent: ContentBlock[] = [];
    let toolCalls: ToolCall[] = [];
    let stopReason = "";

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
        log.warn("context length exceeded, attempting recovery", {
          contextTokens: estimateContextTokens(),
          contextLimit: client.contextLimit,
        });
        contextOverflow = true;
        previousResponseId = undefined;
        lastApiPromptTokens = 0;
        heuristicAtLastApiCall = 0;
        unwindMessages(messages, client.contextLimit);
        const result = await runReactiveCompaction({
          summarizer, messages, systemPrompt, cwd, signal, todoList, onEvent,
          fallbackInstruction: instruction,
        });
        tokenCounter.resetFor(messages);
        // Handoff (and/or unwind) rewrote the messages array — sync disk.
        options.persistMessages?.(messages);
        if (result.promptToInject != null) pushUser(result.promptToInject);
        continue;
      }

      if (err instanceof OutputLengthExceededError) {
        log.warn("output length exceeded, auto-resuming");
        if (err.truncatedContent) {
          pushMessage({ role: "assistant", content: err.truncatedContent });
          tokenCounter.addToolResult(err.truncatedContent);
        }
        pushUser("Your previous response was cut off at the output-length limit. Continue from where you stopped.");
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

    // No tool calls: push the assistant reply and either continue with a
    // pending user input or end the loop.
    if (toolCalls.length === 0) {
      if (assistantContent.length > 0) {
        options.onTurnAssistantMessage?.(assistantContent);
        pushMessage({ role: "assistant", content: assistantContent });
      }
      options.onTurnComplete?.();
      const nextQueued = options.takeNextQueued?.();
      if (nextQueued != null) {
        pushUser(nextQueued);
        continue;
      }
      log.info("no tool calls in response, completing", { stopReason });
      return { outcome: contextOverflow ? "context_overflow" : "ok", previousResponseId };
    }

    // Announce the assistant turn BEFORE tools execute so the render pipeline
    // tracks tool_use ids before any tool_result (or nested subagent event)
    // arrives. The messages array mutation is deferred to after tool execution
    // so the on-disk log never shows an orphan tool_use if the process crashes
    // mid-tool — the invariant "assistant(tool_use) is immediately followed by
    // user(tool_result)" holds at every persistence boundary.
    if (assistantContent.length > 0) {
      options.onTurnAssistantMessage?.(assistantContent);
    }

    const { toolResults, todoMutated } = await executeToolCallsParallel({
      toolCalls, toolContext, signal, hasQueuedInput: options.hasQueuedInput,
      extraTools: options.extraTools, cwd, sessionId: options.sessionId,
      tokenCounter, onEvent,
    });

    for (const tc of toolCalls) nudge.onToolCall(tc.name);

    if (todoMutated) {
      nudge.onTodoMutation();
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
    }

    // Persist assistant(tool_use) and user(tool_result) together — the render
    // emit already happened before tool execution; here we only mutate the
    // messages array so disk state stays consistent.
    if (assistantContent.length > 0) {
      pushMessage({ role: "assistant", content: assistantContent });
    }
    pushUser(renderToolResults(toolResults));

    if (signal?.aborted) break;

    const nextQueued = options.takeNextQueued?.();
    if (nextQueued != null) pushUser(nextQueued);
  }

  return { outcome: contextOverflow ? "context_overflow" : "ok", previousResponseId };
}
