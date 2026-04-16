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
import type { ToolContext, TodoItem } from "./tools/types.js";
import { createTokenCounter } from "./context/token-counter.js";
import { createSummarizer, unwindMessages } from "./context/summarizer.js";
import { renderNextInput, applyHandoff } from "./agent-state.js";
import type { NextInput, ToolResultEntry } from "./agent-state.js";

const log = Log.create({ service: "harness-agent-loop" });

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
  onTurnAssistantMessage?: (content: ContentBlock[]) => void;
  reasoningEffort?: ReasoningEffort;
  /** Shared queue of pending user inputs. The runner pushes via send();
   *  the loop shifts at text-exit boundaries to continue as a new user turn. */
  pendingUserInputs?: string[];
  /** Prior messages from a resumed conversation. Seeds the loop's history. */
  priorMessages?: Message[];
  /** Called whenever a message is pushed to history — enables streaming persistence. */
  onMessageAppended?: (message: Message) => void;
}

export interface AgentLoopResult {
  contextOverflow: boolean;
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

  let nextInput: NextInput = { kind: "initial", text: instruction };
  let contextOverflow = false;

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
          nextInput = { kind: "recovered", handoff: handoff.userPrompt };
          contextOverflow = true;
        }
      } catch (err) {
        log.error("proactive summarization failed", {
          error: errorMessage(err),
        });
      }
    }

    const userPrompt = renderNextInput(nextInput);
    const turnMessages: Message[] = [...messages, { role: "user", content: userPrompt }];

    let assistantContent: ContentBlock[] = [];
    let toolCalls: ToolCall[] = [];
    let stopReason = "";

    try {
      const stream = client.streamWithTools({
        messages: turnMessages,
        tools: toolDefs,
        systemPrompt,
        reasoningEffort,
        signal,
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
            // Thinking streams to onEvent for display but must not enter message history --
            // Anthropic rejects history with thinking content on subsequent turns.
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
            break;
        }
      }
    } catch (err) {
      if (err instanceof ContextLengthExceededError) {
        log.warn("context length exceeded, attempting recovery");
        contextOverflow = true;
        unwindMessages(messages, client.contextLimit);
        const handoff = await summarizer.summarize(messages, systemPrompt, cwd, signal);
        if (handoff) {
          applyHandoff(messages, handoff);
          nextInput = { kind: "recovered", handoff: handoff.userPrompt };
        } else {
          nextInput = { kind: "recovered", handoff: instruction };
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
      if (options.pendingUserInputs && options.pendingUserInputs.length > 0) {
        const next = options.pendingUserInputs.shift()!;
        nextInput = { kind: "initial", text: next };
        continue;
      }
      log.info("no tool calls in response, completing", { stopReason });
      return { contextOverflow };
    }

    const toolResults: ToolResultEntry[] = [];
    const parallelResults = await Promise.all(
      toolCalls.map(async (tc) => {
        if (signal?.aborted) return null;
        return { tc, result: await executeTool(tc.name, tc.input, toolContext) };
      }),
    );

    for (const entry of parallelResults) {
      if (!entry) continue;
      const { tc, result } = entry;
      onEvent({ kind: "tool_result", toolCallId: tc.id, content: result.content });
      toolResults.push({ toolCallId: tc.id, content: result.content });
      tokenCounter.addToolResult(result.content);
    }

    nextInput = { kind: "observation", toolResults };
  }

  return { contextOverflow };
}

function appendTextBlock(blocks: ContentBlock[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    last.text += text;
  } else {
    blocks.push({ type: "text", text });
  }
}

