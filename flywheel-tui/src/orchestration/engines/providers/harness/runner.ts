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
import { cleanupHarnessOutputs } from "./context/truncation.js";
import { buildHarnessSystemPrompt } from "./prompt.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { emitContentBlockDelta, emitToolResult, emitAssistant, emitResult, emitUser } from "./emit.js";
import { getToolDefinitions } from "./tools/tool-dispatch.js";
import { appendMessage, conversationPathFor, loadMessages, loadMeta, saveMeta } from "./conversation-store.js";

const EFFORT_MAP: Record<string, ReasoningEffort> = {
  off: "off",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
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

    try {
      const client = this.createLLMClient(options.model);
      const tools = options.tools ? resolveHarnessTools(options.tools) : undefined;
      const availableToolNames = new Set((tools ?? getToolDefinitions()).map(t => t.name));

      const projectInstructions = await loadProjectInstructions(options.cwd);
      const systemPrompt = buildHarnessSystemPrompt({
        orchestrationSystemPrompt: options.systemPrompt ?? "",
        provider: client.provider,
        projectInstructions,
        availableTools: availableToolNames,
        cwd: options.cwd,
      });

      let turn = { thinkingContent: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 };

      const onEvent = (streamEvent: StreamEvent): void => {
        switch (streamEvent.kind) {
          case "text_delta":
            emitContentBlockDelta(options.onEvent, {
              type: "text_delta",
              text: streamEvent.text,
            });
            break;
          case "thinking_delta":
            turn.thinkingContent += streamEvent.text;
            emitContentBlockDelta(options.onEvent, {
              type: "thinking_delta",
              thinking: streamEvent.text,
            });
            break;
          case "thinking_complete":
            if (!turn.thinkingContent) {
              emitContentBlockDelta(options.onEvent, {
                type: "thinking_delta",
                thinking: streamEvent.thinking,
              });
            }
            turn.thinkingContent = streamEvent.thinking;
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
            break;
          case "todo_state":
            emitAssistant(options.onEvent, [{
              type: "tool_use",
              id: `todo-sync-${Date.now()}`,
              name: "todo_list",
              input: { operation: "write", todos: streamEvent.todos },
            }]);
            break;
          case "usage":
            const deltaInputTokens = Math.max(0, streamEvent.inputTokens - turn.inputTokens);
            const deltaOutputTokens = Math.max(0, streamEvent.outputTokens - turn.outputTokens);
            const deltaCacheReadTokens = Math.max(0, streamEvent.cacheReadTokens - turn.cacheReadTokens);
            const deltaCacheCreateTokens = Math.max(0, streamEvent.cacheCreateTokens - turn.cacheCreateTokens);
            const deltaReasoningTokens = Math.max(0, streamEvent.reasoningTokens - turn.reasoningTokens);
            turn.inputTokens = streamEvent.inputTokens;
            turn.outputTokens = streamEvent.outputTokens;
            turn.cacheReadTokens = streamEvent.cacheReadTokens;
            turn.cacheCreateTokens = streamEvent.cacheCreateTokens;
            turn.reasoningTokens = streamEvent.reasoningTokens;
            this.totalInputTokens += deltaInputTokens;
            this.totalOutputTokens += deltaOutputTokens;
            this.totalCostUsd += client.costFor({
              input: deltaInputTokens,
              output: deltaOutputTokens,
              cacheRead: deltaCacheReadTokens,
              cacheWrite: deltaCacheCreateTokens,
              reasoning: deltaReasoningTokens,
            });
            break;
          case "done":
            emitResult(options.onEvent, {
              totalCostUsd: this.totalCostUsd,
              inputTokens: turn.inputTokens,
              outputTokens: turn.outputTokens,
              sessionId: this.sessionId,
              contextWindow: client.contextLimit,
            });
            break;
        }
      };

      const onTurnAssistantMessage = (content: LLMContentBlock[]): void => {
        const blocks: ContentBlock[] = [];
        if (turn.thinkingContent) {
          blocks.push({ type: "thinking", thinking: turn.thinkingContent });
        }
        for (const b of content) {
          if (b.type === "text") blocks.push({ type: "text", text: b.text });
          else if (b.type === "tool_use") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        }
        if (blocks.length > 0) {
          emitAssistant(options.onEvent, blocks, {
            input_tokens: turn.inputTokens,
            cache_read_input_tokens: turn.cacheReadTokens,
            cache_creation_input_tokens: turn.cacheCreateTokens,
          });
        }
        turn = { thinkingContent: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 };
      };

      const isResume = !!options.resumeSessionId;
      const conversationPath = options.sessionDir
        ? conversationPathFor(options.sessionDir, this.sessionId)
        : null;
      const priorMessages: Message[] = conversationPath && isResume
        ? loadMessages(conversationPath)
        : [];
      const priorMeta = options.sessionDir && isResume
        ? loadMeta(options.sessionDir, this.sessionId)
        : null;
      const onMessageAppended = conversationPath
        ? (message: Message) => appendMessage(conversationPath, message)
        : undefined;

      const result = await runAgentLoop({
        client,
        systemPrompt,
        instruction,
        cwd: options.cwd,
        handoffPath: options.handoffPath,
        signal,
        onEvent,
        onUserMessage: (content) => { emitUser(options.onEvent, content); },
        onTurnComplete: options.onTurnComplete,
        onTurnAssistantMessage,
        reasoningEffort: mapEffort(options.effort),
        pendingUserInputs: this.pendingUserInputs,
        tools,
        priorMessages,
        onMessageAppended,
        sessionId: this.sessionId,
        previousResponseId: priorMeta?.previousResponseId,
      });

      if (options.sessionDir && result.previousResponseId) {
        saveMeta(options.sessionDir, this.sessionId, {
          previousResponseId: result.previousResponseId,
        });
      }

      this.resolveResult({
        durationMs: Date.now() - startTime,
        sessionId: this.sessionId,
        failure: result.outcome === "ok" ? undefined : { kind: result.outcome },
      });
    } catch (err) {
      this.resolveResult({
        durationMs: Date.now() - startTime,
        sessionId: this.sessionId,
        failure: signal.aborted
          ? { kind: "aborted" }
          : { kind: "api_error", message: errorMessage(err) },
      });
    } finally {
      cleanupHarnessOutputs(options.cwd, this.sessionId);
    }
  }
}

