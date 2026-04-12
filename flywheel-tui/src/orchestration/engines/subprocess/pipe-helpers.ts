import type { StdinHandle, SpawnOptions } from "./spawner.js";
import type { CompletionDetector } from "./completion.js";
import type { NDJSONParser } from "../../../infra/ndjson-parser.js";
import type { createSubprocessTimeout } from "./timeout.js";
import type { StdoutProcessorState } from "./spawn-helpers.js";

export function writeInitialStdin(
  stdinSink: import("bun").FileSink,
  content: string,
  stdinHandle: StdinHandle,
): () => Promise<void> {
  const encoder = new TextEncoder();
  return async () => {
    try {
      stdinSink.write(encoder.encode(content));
      stdinSink.flush();
    } catch {
      stdinHandle.close();
    }
  };
}

export function watchHandoff(
  handoffPath: string,
  stdinHandle: StdinHandle,
  subprocessTimeout: ReturnType<typeof createSubprocessTimeout>,
  completionDetector: CompletionDetector,
  state: StdoutProcessorState,
  options: SpawnOptions | undefined,
): () => Promise<void> {
  return async () => {
    if (!handoffPath) return;

    while (stdinHandle.isOpen && !subprocessTimeout.signal.aborted) {
      if (completionDetector.hasSeenCompletion) return;

      if (completionDetector.checkHandoffFile(handoffPath)) {
        if (state.onCompletionDetected) {
          state.onCompletionDetected();
          if (!options?.onTurnComplete) state.onCompletionDetected = null;
        }
        return;
      }

      await Bun.sleep(100);
    }
  };
}

export function wireCompletionDetection(
  options: SpawnOptions,
  stdinHandle: StdinHandle,
  ndjsonParser: NDJSONParser,
  completionDetector: CompletionDetector,
  state: StdoutProcessorState,
): void {
  if (options.onTurnComplete) {
    const turnCallback = options.onTurnComplete;
    state.onCompletionDetected = () => {
      if (!stdinHandle.isOpen) return;
      completionDetector.reset();
      turnCallback(ndjsonParser.sessionId ?? undefined);
    };
  } else {
    state.onCompletionDetected = () => {
      if (!stdinHandle.isOpen) return;
      stdinHandle.close();
    };
  }
}
