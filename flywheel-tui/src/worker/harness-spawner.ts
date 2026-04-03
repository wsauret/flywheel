/**
 * HarnessSpawner — implements ProcessSpawner using the in-process agent loop.
 *
 * Instead of spawning a subprocess, it runs the harness agent loop directly
 * in the Bun process. Emits NDJSON events via onStdout so the existing
 * pipeline (NDJSONParser, CompletionDetector, StructuredEventParser) works
 * unchanged.
 *
 * Fresh state per spawn() — no instance-level caching between calls.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessSpawner, SpawnOptions, SpawnResult, StdinHandle } from "./spawner.js";
import type { WorkerResult } from "./schemas.js";
import type { CollectedToolCall, ToolCallResult } from "../harness/turn-executor.js";
import { runAgentLoop } from "../harness/agent-loop.js";
import { AnthropicProvider, sanitizeApiKey } from "../harness/anthropic.js";
import { gatherWorkspaceContext, buildSystemPrompt } from "../harness/prompts.js";
import { createBashTool } from "../harness/tools/bash.js";
import { createReadTool } from "../harness/tools/read.js";
import { editTool } from "../harness/tools/edit.js";
import { textSearchTool } from "../harness/tools/text-search.js";
import { astSearchTool } from "../harness/tools/ast-search.js";
import { taskCompleteTool } from "../harness/tools/task-complete.js";
import { resolveSessionHandoffsDir, ensureSessionDir } from "../config/paths.js";
import { Log } from "../utils/log.js";

const log = Log.create({ service: "harness-spawner" });

const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Sanitize a string to ensure no API keys are leaked in NDJSON output.
 */
function sanitize(text: string): string {
  return sanitizeApiKey(text);
}

/**
 * Generate a unique session ID for each spawn invocation.
 */
function generateSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `harness-${Date.now()}-${rand}`;
}

/**
 * Extract model from CLI args (looks for --model flag).
 */
function extractModel(args: string[]): string {
  const idx = args.indexOf("--model");
  if (idx >= 0 && args[idx + 1]) {
    return args[idx + 1];
  }
  return DEFAULT_MODEL;
}

/**
 * Emit a single NDJSON line via the onStdout callback.
 * All emitted text is sanitized to prevent API key leakage.
 */
function emit(onStdout: ((chunk: string) => void) | undefined, event: Record<string, unknown>): void {
  if (!onStdout) return;
  const line = sanitize(JSON.stringify(event));
  onStdout(line + "\n");
}

function emitText(
  onStdout: ((chunk: string) => void) | undefined,
  _sessionId: string,
  text: string,
): void {
  emit(onStdout, {
    type: "assistant",
    message: {
      content: [{ type: "text", text: sanitize(text) }],
    },
  });
}

function emitToolUse(
  onStdout: ((chunk: string) => void) | undefined,
  _sessionId: string,
  call: CollectedToolCall,
): void {
  emit(onStdout, {
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      }],
    },
  });
}

function emitThinking(
  onStdout: ((chunk: string) => void) | undefined,
  _sessionId: string,
  thinking: string,
): void {
  emit(onStdout, {
    type: "assistant",
    message: {
      content: [{ type: "thinking", thinking: sanitize(thinking) }],
    },
  });
}

function emitToolResult(
  onStdout: ((chunk: string) => void) | undefined,
  _sessionId: string,
  result: ToolCallResult,
): void {
  emit(onStdout, {
    type: "tool_result",
    tool_use_id: result.toolCallId,
    content: result.name,
    is_error: result.isError,
  });
}

function emitUsage(
  onStdout: ((chunk: string) => void) | undefined,
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number },
): void {
  emit(onStdout, {
    type: "usage",
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
    },
  });
}

function emitCompletion(onStdout: ((chunk: string) => void) | undefined): void {
  emit(onStdout, { type: "result", subtype: "success" });
}

export class HarnessSpawner implements ProcessSpawner {
  async spawn(
    _command: string,
    args: string[],
    options?: SpawnOptions,
  ): Promise<SpawnResult> {
    const startTime = Date.now();
    const sessionId = generateSessionId();
    const model = extractModel(args);
    const promptText = options?.stdin ?? "";
    const cwd = options?.cwd ?? process.cwd();

    log.info("harness spawn", { sessionId, model, promptLength: promptText.length });

    options?.onSessionId?.(sessionId);

    const abortController = new AbortController();
    let completed = false;

    if (options?.signal) {
      if (options.signal.aborted) {
        completed = true;
      } else {
        options.signal.addEventListener("abort", () => {
          if (!completed) {
            abortController.abort();
          }
        }, { once: true });
      }
    }

    const stdinHandle: StdinHandle = {
      write: (_message: string) => {
        return false;
      },
      close: () => {
        if (!completed) {
          abortController.abort();
        }
      },
      interrupt: () => {
        if (!completed) {
          abortController.abort();
          log.info("harness session interrupted", { sessionId });
        }
      },
      get isOpen() {
        return !completed;
      },
    };

    const resultPromise = (async (): Promise<WorkerResult> => {
      if (completed) {
        return {
          output: "",
          rawOutput: "",
          exitCode: 130,
          truncated: false,
          durationMs: Date.now() - startTime,
          failure: { kind: "interrupted", message: "Session aborted before start" },
          handoffPath: "",
        };
      }

      try {
        const provider = new AnthropicProvider({
          apiKey: process.env["ANTHROPIC_API_KEY"] ?? "",
        });

        const tools = [
          createBashTool(),
          createReadTool(),
          editTool,
          textSearchTool,
          astSearchTool,
          taskCompleteTool,
        ];

        const workspaceContext = await gatherWorkspaceContext();
        const systemPrompt = buildSystemPrompt(workspaceContext);

        const textChunks: string[] = [];

        const result = await runAgentLoop({
          provider,
          tools,
          systemPrompt,
          initialMessage: promptText,
          model,
          abortSignal: abortController.signal,
          cwd,
          env: options?.env ?? {},
          onTextDelta: (text) => {
            textChunks.push(text);
            emitText(options?.onStdout, sessionId, text);
          },
          onThinking: (thinking) => {
            emitThinking(options?.onStdout, sessionId, thinking);
          },
          onToolUse: (call) => {
            emitToolUse(options?.onStdout, sessionId, call);
          },
          onToolResult: (toolResult) => {
            emitToolResult(options?.onStdout, sessionId, toolResult);
          },
          onUsage: (usage) => {
            emitUsage(options?.onStdout, usage);
          },
        });

        completed = true;

        const output = textChunks.join("");
        let handoffPath = "";

        if (result.handoff && options?.sessionId) {
          try {
            const handoffFileName = options.handoffFileName ?? `harness_${sessionId}.json`;
            const handoffsDir = resolveSessionHandoffsDir(options.sessionId, cwd);
            ensureSessionDir(options.sessionId, cwd);
            handoffPath = path.join(handoffsDir, handoffFileName);
            fs.writeFileSync(handoffPath, JSON.stringify(result.handoff, null, 2));
            log.info("handoff file written", { sessionId, handoffPath });
          } catch (err) {
            log.error("failed to write handoff file", {
              sessionId,
              error: err instanceof Error ? err : String(err),
            });
          }
        }

        emitCompletion(options?.onStdout);

        const isAborted = result.status === "aborted";
        const isError = result.status === "error";

        let failure: WorkerResult["failure"];
        if (isAborted) {
          failure = { kind: "interrupted", message: "Session aborted" };
        } else if (isError && result.error) {
          failure = { kind: "transient", message: sanitize(result.error.message) };
        }

        return {
          output: sanitize(output),
          rawOutput: sanitize(output),
          exitCode: isAborted ? 130 : isError ? 1 : 0,
          truncated: false,
          durationMs: Date.now() - startTime,
          failure,
          sessionId,
          handoffPath,
        };
      } catch (err) {
        completed = true;
        const message = err instanceof Error ? sanitize(err.message) : sanitize(String(err));
        log.error("harness spawn failed", { sessionId, error: message });

        emitCompletion(options?.onStdout);

        return {
          output: "",
          rawOutput: "",
          exitCode: 1,
          truncated: false,
          durationMs: Date.now() - startTime,
          failure: { kind: "transient", message },
          handoffPath: "",
        };
      }
    })();

    return { result: resultPromise, stdinHandle };
  }
}
