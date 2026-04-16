import { ensureTracesDir, resolveTranscriptFile } from "../../infra/paths.js";
import { createBufferedFileWriter, DEFAULT_DEBOUNCE_MS } from "./buffered-file-writer.js";
import type { NDJSONEvent } from "../../infra/ndjson-event-types.js";

export interface TranscriptWriter {
  /** Append a raw NDJSON event to the transcript file (buffered). */
  handleEvent(event: NDJSONEvent): void;
  /** Flush + close fd + cancel timers. Safe to call multiple times. */
  dispose(): void;
  /** Number of events successfully buffered. */
  getEventCount(): number;
}

interface TranscriptWriterDeps {
  sessionId: string;
  baseDir: string;
  /** Debounce interval in ms for buffered writes. Default: 100ms */
  debounceMs?: number;
}

export function createTranscriptWriter(deps: TranscriptWriterDeps): TranscriptWriter {
  const { sessionId, baseDir, debounceMs = DEFAULT_DEBOUNCE_MS } = deps;

  // Ensure traces directory exists
  ensureTracesDir(baseDir);

  // Buffered line writer (fd-append + debounce)
  const writer = createBufferedFileWriter<string>({
    filePath: resolveTranscriptFile(sessionId, baseDir),
    serialize: (lines) => lines.map((line) => line + "\n").join(""),
    debounceMs,
  });

  let eventCount = 0;

  function handleEvent(event: NDJSONEvent): void {
    if (event.raw === "") return;
    // Skip streaming deltas — only persist turn-boundary events
    if (event.type === "content_block_delta") return;
    writer.push(event.raw);
    eventCount++;
  }

  function dispose(): void {
    writer.dispose();
  }

  function getEventCount(): number {
    return eventCount;
  }

  return {
    handleEvent,
    dispose,
    getEventCount,
  };
}
