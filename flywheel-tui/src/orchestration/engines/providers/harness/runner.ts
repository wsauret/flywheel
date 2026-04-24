/**
 * HarnessRunner — EngineRunner implementation for the in-process harness engine.
 *
 * Translates the agent loop's StreamEvents into NDJSONEvents via emit helpers,
 * accumulates cost across turns, and resolves `done` when the loop completes.
 */

import { randomUUID } from "node:crypto";
import { errorMessage } from "../../../../infra/error-message.js";
import { canonicalize } from "../../../../infra/canonical-name.js";
import type { EngineRunner, EngineResult, RunnerOptions } from "../../core/types.js";
import { resolveToolActions } from "../../core/tool-resolution.js";
import type { ContentBlock as LLMContentBlock, LLMClient, Message, ReasoningEffort, StreamEvent } from "./llm/types.js";
import type { ContentBlock } from "../../../../infra/ndjson-event-types.js";
import type { ToolDefinition } from "./tools/types.js";
import { runAgentLoop } from "./agent-loop.js";
import { cleanupHarnessOutputs } from "./context/truncation.js";
import { buildHarnessSystemPrompt } from "./prompt.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { emitContentBlockDelta, emitToolResult, emitAssistant, emitResult, emitUser, emitCompaction } from "./emit.js";
import { createTurnCostTracker } from "./turn-cost-tracker.js";
import { getToolDefinitions } from "./tools/tool-dispatch.js";
import { createSubagentTool } from "./tools/subagent.js";
import { loadAgentRegistry, type AgentDefinition } from "./agent-loader.js";
import { detectModelFamily } from "./llm/model-family.js";
import { appendMessage, conversationPathFor, loadMessages, loadMeta, rewriteMessages, saveMeta } from "./conversation-store.js";
import { loadCachedModels } from "../../../../infra/auth/openai-model-cache.js";
import { join } from "node:path";

const EFFORT_MAP: Record<string, ReasoningEffort> = {
  off: "off",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

function mapEffort(effort: string | undefined): ReasoningEffort | undefined {
  if (!effort) return undefined;
  return EFFORT_MAP[canonicalize(effort)];
}

// Maps harness tool names to the Claude CLI tool names that enable them.
// A harness tool is included if ANY of its enabling CLI tools are in the allowed list.
const HARNESS_TOOL_ENABLERS: Record<string, readonly string[]> = {
  bash: ["Bash", "Read", "Grep", "Glob", "Edit", "Write"],
  read: ["Read"],
  edit: ["Edit"],
  write: ["Write", "Edit"],
  text_search: ["Grep", "Glob"],
  ast_search: ["Grep", "Glob"],
  todo_list: ["Task"],
  subagent: ["Agent", "Task"],
};

function resolveHarnessTools(cliToolNames: ReadonlyArray<string>): ReturnType<typeof getToolDefinitions> {
  const allowed = new Set(cliToolNames);
  const enabled = new Set<string>(["write_handoff"]);
  for (const [name, enablers] of Object.entries(HARNESS_TOOL_ENABLERS)) {
    if (enablers.some(e => allowed.has(e))) enabled.add(name);
  }
  return getToolDefinitions().filter(t => enabled.has(t.name));
}

function resolveHarnessToolDefinitions(toolNames: ReadonlyArray<string>): ReturnType<typeof getToolDefinitions> {
  const allowed = new Set(toolNames);
  return getToolDefinitions().filter((tool) => allowed.has(tool.name));
}

export class HarnessRunner implements EngineRunner {
  readonly done: Promise<EngineResult>;
  private readonly sessionId: string;

  private abortController = new AbortController();
  private started = false;
  private readonly resolveResult: (result: EngineResult) => void;
  private cachedAgentRegistry?: Map<string, AgentDefinition>;

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
    // Subsequent sends are already in the session queue (chat-controls pushes
    // before calling send); the loop picks them up via takeNextQueued.
    if (!this.started) {
      this.started = true;
      this.runAgentLoop(text);
    }
  }

  end(): void {
    // Caller's pledge not to call send() again; the loop exits naturally once
    // the queue drains and the model yields with no tool calls.
  }

  abort(): void {
    this.abortController.abort();
    if (!this.started) {
      // Aborting a never-started runner — runAgentLoop never ran, so there's
      // no async path that will resolve `done`. Resolve now so lifecycle
      // callbacks (onDone -> onEnded) can still fire.
      this.resolveResult({
        durationMs: 0,
        sessionId: this.sessionId,
        failure: { kind: "aborted" },
      });
    }
  }

  drainPendingInputs(): string[] {
    return this.options.drainQueued?.() ?? [];
  }

  private async runAgentLoop(instruction: string): Promise<void> {
    const startTime = Date.now();
    const { options, abortController } = this;

    const signal = options.signal
      ? AbortSignal.any([options.signal, abortController.signal])
      : abortController.signal;

    try {
      const client = this.createLLMClient(options.model);
      const tools = options.engineToolNames
        ? resolveHarnessToolDefinitions(options.engineToolNames)
        : options.toolActions
          ? resolveHarnessToolDefinitions(resolveToolActions("harness", options.toolActions))
          : options.tools
            ? resolveHarnessTools(options.tools)
            : undefined;
      const availableToolNames = new Set((tools ?? getToolDefinitions()).map(t => t.name));

      const projectInstructions = options.projectInstructions !== undefined
        ? options.projectInstructions
        : await loadProjectInstructions(options.cwd);

      if (options.agentRegistry) {
        this.cachedAgentRegistry = options.agentRegistry;
      } else if (!this.cachedAgentRegistry) {
        // Compiled binaries don't ship the source tree — the bundled installer
        // populates `~/.flywheel/agents/` at startup, which becomes the
        // built-in registry in that environment. In dev we read from the
        // canonical source directly so changes pick up without an install pass.
        const userAgentsDir = join(process.env.HOME ?? "", ".flywheel", "agents");
        const projectAgentsDir = join(options.cwd, ".flywheel", "agents");
        this.cachedAgentRegistry = await loadAgentRegistry(userAgentsDir, undefined, projectAgentsDir);
      }
      const agentRegistry = this.cachedAgentRegistry;

      const costTracker = createTurnCostTracker(client);
      const modelFamily = detectModelFamily(client.model) ?? "anthropic";

      const availableModels = modelFamily === "openai" ? loadCachedModels() ?? undefined : undefined;

      const subagentExtraTools: Map<string, ToolDefinition> = new Map();
      if (agentRegistry.size > 0) {
        const subagentDef = createSubagentTool({
          agentRegistry,
          createLLMClient: this.createLLMClient,
          modelFamily,
          availableModels,
          parentModel: client.model,
          onRenderEvent: options.onEvent,
          addCost: (cost, input, output) => {
            costTracker.addExternalCost(cost, input, output);
          },
          projectInstructions: projectInstructions ?? "",
          sessionDir: options.sessionDir ?? options.cwd,
        });
        subagentExtraTools.set("subagent", subagentDef);
      }

      const allToolNames = new Set(availableToolNames);
      if (subagentExtraTools.size > 0) allToolNames.add("subagent");

      const systemPrompt = buildHarnessSystemPrompt({
        orchestrationSystemPrompt: options.systemPrompt ?? "",
        model: client.model,
        projectInstructions,
        availableTools: allToolNames,
        cwd: options.cwd,
      });

      let thinkingContent = "";

      const parentToolUseId = options.parentToolUseId;

      const onEvent = (streamEvent: StreamEvent): void => {
        switch (streamEvent.kind) {
          case "text_delta":
            emitContentBlockDelta(options.onEvent, {
              type: "text_delta",
              text: streamEvent.text,
            }, parentToolUseId);
            break;
          case "thinking_delta":
            thinkingContent += streamEvent.text;
            emitContentBlockDelta(options.onEvent, {
              type: "thinking_delta",
              thinking: streamEvent.text,
            }, parentToolUseId);
            break;
          case "thinking_complete":
            if (!thinkingContent) {
              emitContentBlockDelta(options.onEvent, {
                type: "thinking_delta",
                thinking: streamEvent.thinking,
              }, parentToolUseId);
            }
            thinkingContent = streamEvent.thinking;
            break;
          case "tool_result":
            emitToolResult(
              options.onEvent,
              streamEvent.toolCallId,
              streamEvent.content,
              false,
              parentToolUseId,
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
            }], undefined, parentToolUseId);
            break;
          case "usage":
            costTracker.handleUsage(streamEvent);
            break;
          case "compaction_start":
            emitCompaction(options.onEvent, "start", undefined, parentToolUseId);
            break;
          case "compaction_done":
            emitCompaction(options.onEvent, streamEvent.success ? "done" : "error", streamEvent.durationMs, parentToolUseId);
            break;
          case "done": {
            const totals = costTracker.getTotals();
            emitResult(options.onEvent, {
              totalCostUsd: totals.cost,
              inputTokens: totals.inputTokens,
              outputTokens: totals.outputTokens,
              sessionId: this.sessionId,
              contextWindow: client.contextLimit,
            }, parentToolUseId);
            break;
          }
        }
      };

      const onTurnAssistantMessage = (content: LLMContentBlock[]): void => {
        const blocks: ContentBlock[] = [];
        if (thinkingContent) {
          blocks.push({ type: "thinking", thinking: thinkingContent });
        }
        for (const b of content) {
          if (b.type === "text") blocks.push({ type: "text", text: b.text });
          else if (b.type === "tool_use") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        }
        if (blocks.length > 0) {
          const turnTokens = costTracker.getTurnTokens();
          const turnCache = costTracker.getTurnCacheTokens();
          emitAssistant(options.onEvent, blocks, {
            input_tokens: turnTokens.inputTokens,
            cache_read_input_tokens: turnCache.cacheReadTokens,
            cache_creation_input_tokens: turnCache.cacheCreateTokens,
          }, parentToolUseId);
        }
        costTracker.resetTurn();
        thinkingContent = "";
      };

      const isResume = !!options.resumeSessionId;
      const conversationPath = typeof options.conversationPath === "function"
        ? options.conversationPath(this.sessionId)
        : options.conversationPath
          ? options.conversationPath
          : options.sessionDir
            ? conversationPathFor(options.sessionDir, this.sessionId)
            : null;
      const priorMessages: Message[] = conversationPath && isResume
        ? loadMessages(conversationPath)
        : [];
      const priorMeta = options.sessionDir && isResume
        ? loadMeta(options.sessionDir, this.sessionId)
        : null;
      const persistAppend = conversationPath
        ? (msg: Message) => appendMessage(conversationPath, msg)
        : undefined;
      const persistMessages = conversationPath
        ? (msgs: ReadonlyArray<Message>) => rewriteMessages(conversationPath, msgs)
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
        takeNextQueued: options.takeNextQueued,
        hasQueuedInput: options.hasQueuedInput,
        tools,
        extraTools: subagentExtraTools.size > 0 ? subagentExtraTools : undefined,
        priorMessages,
        persistAppend,
        persistMessages,
        sessionId: this.sessionId,
        previousResponseId: priorMeta?.previousResponseId,
        maxLLMCalls: options.maxLLMCalls,
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

