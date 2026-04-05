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
import {
  runAgentLoop,
  gatherWorkspaceContext,
  buildSystemPrompt,
  createStandardTools,
  createProvider,
  sanitize,
  emitText,
  emitThinking,
  emitToolUse,
  emitToolResult,
  emitUsage,
  emitCompletion,
} from "../harness/index.js";
import { resolveSessionHandoffsDir, ensureSessionDir } from "../config/paths.js";
import { Log } from "../utils/log.js";

const log = Log.create({ service: "harness-spawner" });

const DEFAULT_MODEL = "claude-sonnet-4-6";

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
        const provider = createProvider(process.env["ANTHROPIC_API_KEY"] ?? "");
        const tools = createStandardTools();

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
            emitText(options?.onStdout, text);
          },
          onThinking: (thinking) => {
            emitThinking(options?.onStdout, thinking);
          },
          onToolUse: (call) => {
            emitToolUse(options?.onStdout, call);
          },
          onToolResult: (toolResult) => {
            emitToolResult(options?.onStdout, toolResult);
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