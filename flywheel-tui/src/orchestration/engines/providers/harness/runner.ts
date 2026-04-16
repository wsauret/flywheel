/**
 * HarnessRunner — EngineRunner implementation for the in-process harness engine.
 *
 * Translates the agent loop's StreamEvents into NDJSONEvents via emit helpers,
 * accumulates cost across turns, and resolves `done` when the loop completes.
 */

import { randomUUID } from "node:crypto";
import { errorMessage } from "../../../../infra/error-message.js";
import type { EngineRunner, EngineResult, RunnerOptions } from "../../core/types.js";
import type { ContentBlock as LLMContentBlock, LLMClient, ReasoningEffort, StreamEvent } from "./llm/types.js";
import type { ContentBlock } from "../../../../infra/ndjson-event-types.js";
import { runAgentLoop } from "./agent-loop.js";
import { buildHarnessSystemPrompt } from "./prompt.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { emitContentBlockDelta, emitToolResult, emitAssistant, emitResult } from "./emit.js";
import { getToolDefinitions } from "./tools/tool-dispatch.js";

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
const HARNESS_TOOL_ENABLERS: Record<string, readonly string[]> = {
  bash: ["Bash", "Read", "Grep", "Glob", "Edit"],
  write_handoff: ["Write"],
  read_image: ["Read"],
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
    this.sessionId = `harness-${randomUUID()}`;
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

    const projectInstructions = await loadProjectInstructions(options.cwd);
    const systemPrompt = buildHarnessSystemPrompt(
      options.systemPrompt ?? "",
      client.provider,
      projectInstructions,
    );

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
          options.onTurnComplete?.();
          break;
      }
    };

    const onTurnAssistantMessage = (content: LLMContentBlock[]): void => {
      if (content.length === 0) return;
      const blocks = content.flatMap((b): ContentBlock[] => {
        if (b.type === "text") return [{ type: "text", text: b.text }];
        if (b.type === "tool_use") return [{ type: "tool_use", id: b.id, name: b.name, input: b.input }];
        return [];
      });
      if (blocks.length === 0) return;
      emitAssistant(options.onEvent, blocks, {
        input_tokens: this.totalInputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
    };

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
        tools: options.tools ? resolveHarnessTools(options.tools) : undefined,
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



