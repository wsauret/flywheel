/**
 * HarnessRunner — EngineRunner implementation for the in-process harness engine.
 *
 * Translates the agent loop's StreamEvents into NDJSONEvents via emit helpers,
 * accumulates cost across turns, and resolves `done` when the loop completes.
 */

import { randomUUID } from "node:crypto";
import { errorMessage } from "../../../../infra/error-message.js";
import type { EngineRunner, EngineResult, RunnerOptions } from "../../core/types.js";
import type { ContentBlock as LLMContentBlock, LLMClient, Message, ReasoningEffort, StreamEvent } from "./llm/types.js";
import type { ContentBlock } from "../../../../infra/ndjson-event-types.js";
import { runAgentLoop } from "./agent-loop.js";
import { buildHarnessSystemPrompt } from "./prompt.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { emitContentBlockDelta, emitToolResult, emitAssistant, emitResult } from "./emit.js";
import { getToolDefinitions } from "./tools/tool-dispatch.js";
import { appendMessage, conversationPathFor, loadMessages } from "./conversation-store.js";

const EFFORT_MAP: Record<string, ReasoningEffort> = {
  off: "off",
  low: "low",
  medium: "medium",
  high: "high",
};

function mapEffort(effort: string | undefined): ReasoningEffort | undefined {
  if (!effort) return undefined;
  return EFFORT_MAP[effort.toLowerCase()];
}

// Maps harness tool names to the Claude CLI tool names that enable them.
// A harness tool is included if ANY of its enabling CLI tools are in the allowed list.
// "Write" and "Edit" enable bash because the harness has no native file-write tool —
// file creation and editing go through shell commands.
const HARNESS_TOOL_ENABLERS: Record<string, readonly string[]> = {
  bash: ["Bash", "Read", "Grep", "Glob", "Edit", "Write"],
  read: ["Read"],
  todo_list: ["Task"],
};

function resolveHarnessTools(cliToolNames: ReadonlyArray<string>): ReturnType<typeof getToolDefinitions> {
  const allowed = new Set(cliToolNames);
  const enabled = new Set<string>(["write_handoff"]); // always available for handoff output
  for (const [name, enablers] of Object.entries(HARNESS_TOOL_ENABLERS)) {
    if (enablers.some(e => allowed.has(e))) enabled.add(name);
  }
  return getToolDefinitions().filter(t => enabled.has(t.name));
}

export class HarnessRunner implements EngineRunner {
  readonly done: Promise<EngineResult>;
  private readonly sessionId: string;

  private abortController = new AbortController();
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  private started = false;
  private readonly pendingUserInputs: string[] = [];
  private readonly resolveResult: (result: EngineResult) => void;

  constructor(
    private readonly options: RunnerOptions,
    private readonly createLLMClient: (model: string) => LLMClient,
  ) {
    // On resume, preserve the session ID so the conversation file path is stable.
    this.sessionId = options.resumeSessionId ?? `harness-${randomUUID()}`;
    const { promise, resolve } = Promise.withResolvers<EngineResult>();
    this.done = promise;
    this.resolveResult = resolve;
  }

  send(text: string): void {
    if (!this.started) {
      this.started = true;
      this.runAgentLoop(text);
      return;
    }
    this.pendingUserInputs.push(text);
  }

  end(): void {
    // Agent-loop exits naturally when pendingUserInputs is empty AND the model
    // produces a turn with no tool calls. No additional signal is needed —
    // end() is the caller's pledge not to call send() again.
  }

  abort(): void {
    this.abortController.abort();
  }

  private async runAgentLoop(instruction: string): Promise<void> {
    const startTime = Date.now();
    const { options, abortController } = this;

    const signal = options.signal
      ? AbortSignal.any([options.signal, abortController.signal])
      : abortController.signal;

    const client = this.createLLMClient(options.model);
    const tools = options.tools ? resolveHarnessTools(options.tools) : undefined;
    const availableToolNames = new Set((tools ?? getToolDefinitions()).map(t => t.name));

    const projectInstructions = await loadProjectInstructions(options.cwd);
    const systemPrompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: options.systemPrompt ?? "",
      provider: client.provider,
      projectInstructions,
      availableTools: availableToolNames,
    });

    const onEvent = (streamEvent: StreamEvent): void => {
      switch (streamEvent.kind) {
        case "text_delta":
          emitContentBlockDelta(options.onEvent, {
            type: "text_delta",
            text: streamEvent.text,
          });
          break;
        case "thinking_delta":
          emitContentBlockDelta(options.onEvent, {
            type: "thinking_delta",
            thinking: streamEvent.text,
          });
          break;
        case "tool_result":
          emitToolResult(
            options.onEvent,
            streamEvent.toolCallId,
            streamEvent.content,
            false,
          );
          break;
        case "tool_use":
          // Collected and emitted as a batch in onTurnAssistantMessage
          break;
        case "usage":
          this.totalInputTokens += streamEvent.inputTokens;
          this.totalOutputTokens += streamEvent.outputTokens;
          this.totalCostUsd += client.costFor({
            input: streamEvent.inputTokens,
            output: streamEvent.outputTokens,
            cacheRead: streamEvent.cacheReadTokens,
            cacheWrite: streamEvent.cacheCreateTokens,
            reasoning: streamEvent.reasoningTokens,
          });
          break;
        case "done":
          emitResult(options.onEvent, {
            totalCostUsd: this.totalCostUsd,
            inputTokens: this.totalInputTokens,
            outputTokens: this.totalOutputTokens,
            sessionId: this.sessionId,
            contextWindow: client.contextLimit,
          });
          // onTurnComplete is deferred to onTurnAssistantMessage below so the
          // assistant event (with text/tool_use blocks) reaches the parser
          // BEFORE the chat session flushes the output blocks.
          break;
      }
    };

    const onTurnAssistantMessage = (content: LLMContentBlock[]): void => {
      if (content.length > 0) {
        const blocks = content.flatMap((b): ContentBlock[] => {
          if (b.type === "text") return [{ type: "text", text: b.text }];
          if (b.type === "tool_use") return [{ type: "tool_use", id: b.id, name: b.name, input: b.input }];
          return [];
        });
        if (blocks.length > 0) {
          emitAssistant(options.onEvent, blocks, {
            input_tokens: this.totalInputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          });
        }
      }
      // Fire onTurnComplete AFTER the assistant event so the parser has the
      // text blocks before the chat session flushes and resets activity.
      options.onTurnComplete?.();
    };

    // Conversation persistence: load prior messages (if resuming) and stream new
    // messages to disk as they're pushed. Path is derived from handoffPath, so
    // when handoffPath is absent (e.g. tests) persistence is a no-op.
    const conversationPath = options.handoffPath
      ? conversationPathFor(options.handoffPath, this.sessionId)
      : null;
    const priorMessages: Message[] = conversationPath && options.resumeSessionId
      ? loadMessages(conversationPath)
      : [];
    const onMessageAppended = conversationPath
      ? (message: Message) => appendMessage(conversationPath, message)
      : undefined;

    try {
      const result = await runAgentLoop({
        client,
        systemPrompt,
        instruction,
        cwd: options.cwd,
        handoffPath: options.handoffPath,
        signal,
        onEvent,
        onTurnAssistantMessage,
        reasoningEffort: mapEffort(options.effort),
        pendingUserInputs: this.pendingUserInputs,
        tools,
        priorMessages,
        onMessageAppended,
      });

      this.resolveResult({
        durationMs: Date.now() - startTime,
        sessionId: this.sessionId,
        failure: result.contextOverflow ? { kind: "context_overflow" } : undefined,
      });
    } catch (err) {
      this.resolveResult({
        durationMs: Date.now() - startTime,
        sessionId: this.sessionId,
        failure: signal.aborted
          ? { kind: "aborted" }
          : { kind: "api_error", message: errorMessage(err) },
      });
    }
  }
}

