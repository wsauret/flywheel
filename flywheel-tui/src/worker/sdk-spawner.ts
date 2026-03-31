/**
 * SdkSpawner -- implements ProcessSpawner using the OpenCode SDK.
 *
 * Instead of spawning a subprocess, it starts an OpenCode server via the SDK,
 * creates a session, and uses the HTTP API for messaging. SSE events are
 * parsed to stream output back through the standard onStdout callback.
 *
 * Server lifecycle: started on first spawn, reused across steps, cleaned up
 * via dispose().
 */

import type { ProcessSpawner, SpawnOptions, SpawnResult, StdinHandle } from "./spawner";
import type { WorkerResult } from "./schemas";
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

        // Wait for the session API to be ready. The HTTP port may be open
        // before the server is fully initialized to handle requests.
        const MAX_READY_ATTEMPTS = 10;
        const READY_DELAY_MS = 300;
        for (let i = 0; i < MAX_READY_ATTEMPTS; i++) {
          try {
            const probe = await oc.client.session.list();
            if (probe.data) {
              log.info("OpenCode server ready", { attempt: i + 1 });
              break;
            }
          } catch {
            // Not ready yet
          }
          if (i === MAX_READY_ATTEMPTS - 1) {
            log.warn("OpenCode server readiness check exhausted — proceeding anyway");
          } else {
            await new Promise((r) => setTimeout(r, READY_DELAY_MS));
          }
        }
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

    // Fire onSessionId callback immediately after session creation
    options?.onSessionId?.(sessionId);

    // State tracking
    const textChunks: string[] = [];
    let completed = false;
    let aborted = false;
    let interrupted = false;
    /** Number of promptAsync injections awaiting their session.idle. */
    let pendingInjections = 0;
    /** Last injected message text — re-sent on idle if the queue didn't drain. */
    let lastInjectedMessage: string | null = null;

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
            if (completed) break;

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
                    // Emit as NDJSON text event (matches opencode run --format json output)
                    const ndjsonEvent = JSON.stringify({
                      type: "text",
                      timestamp: Date.now(),
                      sessionID: sessionId,
                      part: {
                        sessionID: sessionId,
                        type: "text",
                        text: props.delta,
                      },
                    });
                    options?.onStdout?.(ndjsonEvent + "\n");
                  } else if (props.field === "thinking" && typeof props.delta === "string") {
                    // Forward reasoning/thinking deltas as NDJSON
                    const ndjsonEvent = JSON.stringify({
                      type: "reasoning",
                      timestamp: Date.now(),
                      sessionID: sessionId,
                      part: {
                        sessionID: sessionId,
                        type: "reasoning",
                        text: props.delta,
                      },
                    });
                    options?.onStdout?.(ndjsonEvent + "\n");
                  }
                  break;
                }

                // Full part updates (tool use, step lifecycle)
                case "message.part.updated": {
                  const part = props.part as Record<string, unknown> | undefined;
                  if (!part) break;

                  const partType = part.type as string;

                  if (partType === "tool-use" || partType === "tool_use") {
                    const ndjsonEvent = JSON.stringify({
                      type: "tool_use",
                      timestamp: Date.now(),
                      sessionID: sessionId,
                      part: { ...part, sessionID: sessionId },
                    });
                    options?.onStdout?.(ndjsonEvent + "\n");
                  } else if (partType === "step-start") {
                    const ndjsonEvent = JSON.stringify({
                      type: "step_start",
                      timestamp: Date.now(),
                      sessionID: sessionId,
                      part: { ...part, sessionID: sessionId },
                    });
                    options?.onStdout?.(ndjsonEvent + "\n");
                  } else if (partType === "step-finish") {
                    log.debug("step-finish", { sessionId });
                    const ndjsonEvent = JSON.stringify({
                      type: "step_finish",
                      timestamp: Date.now(),
                      sessionID: sessionId,
                      part: { ...part, sessionID: sessionId },
                    });
                    options?.onStdout?.(ndjsonEvent + "\n");
                  } else if (partType === "text") {
                    // Full text part (as opposed to delta) — forward as text event
                    const text = part.text as string | undefined;
                    if (text) {
                      const ndjsonEvent = JSON.stringify({
                        type: "text",
                        timestamp: Date.now(),
                        sessionID: sessionId,
                        part: { ...part, sessionID: sessionId },
                      });
                      options?.onStdout?.(ndjsonEvent + "\n");
                    }
                  }
                  break;
                }

                case "session.idle": {
                  if (interrupted) {
                    // Session is interrupted — ignore ALL idle events until
                    // user resumes via write(). OpenCode may fire multiple
                    // idle events after an abort; resetting the flag on the
                    // first one caused the second to resolve the promise.
                    log.debug("ignoring session.idle while interrupted", { sessionId });
                    break;
                  }

                  if (pendingInjections > 0) {
                    // Session went idle but a message was injected via promptAsync.
                    // The message may have been queued while the session was busy
                    // and not drained before idle. Re-send it now that the session
                    // is idle so it starts a fresh turn.
                    pendingInjections--;
                    log.info("session idle — re-sending pending injection", { sessionId, remaining: pendingInjections });
                    if (lastInjectedMessage) {
                      const msg = lastInjectedMessage;
                      lastInjectedMessage = null;
                      client.session.promptAsync({
                        path: { id: sessionId },
                        body: {
                          parts: [{ type: "text", text: msg }],
                          ...(model ? { model } : {}),
                        },
                      }).catch((err) =>
                        log.error("re-injection failed", { sessionId, error: err instanceof Error ? err : String(err) }),
                      );
                    }
                    break;
                  }

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
                    handoffPath: "",
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
              handoffPath: "",
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
        interrupted = false; // Reset interrupt state on new message (resume)
        pendingInjections++;
        lastInjectedMessage = message;
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
      interrupt: () => {
        if (completed) return;
        interrupted = true;
        client.session.abort({ path: { id: sessionId } }).catch(() => {});
        log.info("SDK session interrupted", { sessionId });
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
