/**
 * SdkSpawner -- implements ProcessSpawner using the OpenCode SDK.
 *
 * Instead of spawning a subprocess, it starts an OpenCode server via the SDK,
 * creates a session, and uses the HTTP API for messaging. SSE events are
 * parsed to stream output back through the standard onStdout callback.
 *
 * Server lifecycle: started on first spawn, reused across phases, cleaned up
 * via dispose().
 */

import type { ProcessSpawner, SpawnOptions, SpawnResult, StdinHandle } from "./spawner";
import type { WorkerResult } from "../schemas/worker";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import { Log } from "../utils/log";

const log = Log.create({ service: "sdk-spawner" });

/**
 * Parse a model string like "anthropic/claude-opus-4-6" into providerID + modelID.
 * Falls back to "anthropic" / full string if no slash is found.
 */
function parseModelId(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash > 0) {
    return {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    };
  }
  return { providerID: "anthropic", modelID: model };
}

export class SdkSpawner implements ProcessSpawner {
  private client: OpencodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private _initializing: Promise<void> | null = null;

  /**
   * Ensure the OpenCode server is running. Idempotent -- only starts once.
   */
  private async ensureServer(): Promise<void> {
    if (this.client) return;

    // Guard against concurrent initialization
    if (this._initializing) {
      await this._initializing;
      return;
    }

    this._initializing = (async () => {
      try {
        log.info("starting OpenCode server");
        const oc = await createOpencode({ port: 0, timeout: 30_000 });
        this.client = oc.client;
        this.server = oc.server;
        log.info("OpenCode server started", { url: oc.server.url });
      } catch (err) {
        log.error("failed to start OpenCode server", {
          error: err instanceof Error ? err : String(err),
        });
        throw err;
      } finally {
        this._initializing = null;
      }
    })();

    await this._initializing;
  }

  async spawn(
    _command: string,
    _args: string[],
    options?: SpawnOptions,
  ): Promise<SpawnResult> {
    await this.ensureServer();

    const client = this.client!;
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? 60 * 60_000;
    const promptText = options?.stdin ?? "";

    // Parse model from environment or options. The model is passed via args
    // in the subprocess path, but for SDK we need it in the prompt call.
    // We extract it from args: look for --model <value>
    let model: { providerID: string; modelID: string } | undefined;
    const modelArgIdx = _args.indexOf("--model");
    if (modelArgIdx >= 0 && _args[modelArgIdx + 1]) {
      model = parseModelId(_args[modelArgIdx + 1]);
    }

    // Create session
    const sessionResp = await client.session.create({
      body: { title: "flywheel-worker" },
    });
    const sessionId = sessionResp.data!.id;
    log.info("SDK session created", { sessionId });

    // State tracking
    const textChunks: string[] = [];
    let completed = false;
    let aborted = false;

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      if (!completed) {
        log.warn("SDK spawn timeout", { sessionId, timeoutMs });
        completed = true;
        aborted = true;
        client.session.abort({ path: { id: sessionId } }).catch(() => {});
      }
    }, timeoutMs);

    // Wire external abort signal
    if (options?.signal) {
      if (options.signal.aborted) {
        completed = true;
        aborted = true;
      } else {
        options.signal.addEventListener("abort", () => {
          if (!completed) {
            completed = true;
            aborted = true;
            client.session.abort({ path: { id: sessionId } }).catch(() => {});
          }
        }, { once: true });
      }
    }

    // Subscribe to SSE events via raw fetch (not SDK's typed stream) because
    // message.part.delta events are not in the SDK's Event type union.
    const eventResp = await fetch(`${this.server!.url}/event`, {
      headers: { Accept: "text/event-stream" },
    });

    if (!eventResp.body) {
      throw new Error("SSE event stream not available");
    }

    const sseReader = eventResp.body.getReader();
    const sseDecoder = new TextDecoder();

    // Result promise: resolved when session.idle fires for our session
    const resultPromise = new Promise<WorkerResult>((resolve) => {
      const processEvents = async () => {
        let sseBuf = "";
        try {
          while (true) {
            if (completed && aborted) break;

            const { done, value } = await sseReader.read();
            if (done) break;
            sseBuf += sseDecoder.decode(value, { stream: true });

            // Parse SSE lines
            const lines = sseBuf.split("\n");
            sseBuf = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              let evt: { type: string; properties?: Record<string, unknown> };
              try {
                evt = JSON.parse(line.slice(6));
              } catch {
                continue;
              }

              const props = evt.properties ?? {};

              // Filter events to our session
              const evtSessionId =
                (props.sessionID as string | undefined) ??
                (props.part as Record<string, unknown> | undefined)?.sessionID as string | undefined;
              if (evtSessionId && evtSessionId !== sessionId) continue;

              switch (evt.type) {
                // Streaming text deltas (token-by-token)
                case "message.part.delta": {
                  if (props.field === "text" && typeof props.delta === "string") {
                    textChunks.push(props.delta);
                    options?.onStdout?.(props.delta);
                  }
                  break;
                }

                // Full part updates (final text, step lifecycle)
                case "message.part.updated": {
                  const part = props.part as Record<string, unknown> | undefined;
                  if (part?.type === "step-finish") {
                    log.debug("step-finish", { sessionId });
                  }
                  break;
                }

                case "session.idle": {
                  log.info("session idle", { sessionId });
                  completed = true;
                  clearTimeout(timeoutHandle);

                  const output = textChunks.join("");
                  resolve({
                    output,
                    rawOutput: output,
                    exitCode: 0,
                    truncated: false,
                    durationMs: Date.now() - startTime,
                    failure: undefined,
                  });
                  // Cancel the SSE reader
                  sseReader.cancel().catch(() => {});
                  return;
                }

                case "session.status": {
                  const status = (props.status as Record<string, unknown> | undefined)?.type;
                  log.debug("session status", { sessionId, status });
                  break;
                }

                default:
                  break;
              }
            }
          }
        } catch (err) {
          // Stream may close on abort or server shutdown
          if (!completed) {
            completed = true;
            clearTimeout(timeoutHandle);

            const output = textChunks.join("");
            resolve({
              output,
              rawOutput: output,
              exitCode: aborted ? 130 : -1,
              truncated: false,
              durationMs: Date.now() - startTime,
              failure: aborted
                ? { kind: "interrupted", message: "Session aborted" }
                : {
                    kind: "transient",
                    message: err instanceof Error ? err.message : String(err),
                  },
            });
          }
        }
      };

      // Start processing events in the background
      processEvents();
    });

    // Create StdinHandle for mid-execution injection
    const stdinHandle: StdinHandle = {
      write: (message: string) => {
        if (completed) return false;
        client.session.promptAsync({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text: message }],
            ...(model ? { model } : {}),
          },
        }).catch((err) =>
          log.error("injection failed", {
            sessionId,
            error: err instanceof Error ? err : String(err),
          }),
        );
        return true;
      },
      close: () => {
        if (completed) return;
        completed = true;
        aborted = true;
        clearTimeout(timeoutHandle);
        client.session.abort({ path: { id: sessionId } }).catch(() => {});
      },
      get isOpen() {
        return !completed;
      },
    };

    // Send initial prompt
    if (promptText) {
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: promptText }],
          ...(model ? { model } : {}),
        },
      });
      log.info("initial prompt sent", { sessionId, promptLength: promptText.length });
    }

    return { result: resultPromise, stdinHandle };
  }

  /**
   * Clean up the OpenCode server. Call when the workflow completes.
   */
  dispose(): void {
    if (this.server) {
      log.info("disposing OpenCode server");
      try {
        this.server.close();
      } catch {
        // Server may already be closed
      }
      this.server = null;
      this.client = null;
    }
  }
}
