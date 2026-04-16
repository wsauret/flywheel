import * as fs from "node:fs";
import * as path from "node:path";
import { TRACES_DIR, ensureTracesDir, resolveTraceFile, resolveTranscriptFile } from "../../infra/paths.js";
import { writeFileAtomic } from "../../infra/atomic-write.js";
import { createBufferedFileWriter, DEFAULT_DEBOUNCE_MS } from "./buffered-file-writer.js";
import type { Span } from "../../infra/trace-types.js";

interface TraceIndexEntry {
  traceId: string;
  sessionId: string;
  workflowName: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: "ok" | "error";
  spanCount: number;
  closedSpanCount: number;
}

interface TraceWriterDeps {
  sessionId: string;
  baseDir: string;
  /** Maximum number of traces to keep in the index. Default: 100 */
  maxTraces?: number;
  /** Debounce interval in ms for buffered writes. Default: 100ms */
  debounceMs?: number;
}

export interface TraceWriter {
  writeSpan(span: Span): void;
  finalizeTrace(summary: TraceIndexEntry): void;
  flush(): void;
  dispose(): void;
}

function resolveIndexFile(baseDir: string): string {
  return path.resolve(baseDir, TRACES_DIR, "index.jsonl");
}

function readIndex(baseDir: string): TraceIndexEntry[] {
  const indexPath = resolveIndexFile(baseDir);
  if (!fs.existsSync(indexPath)) return [];
  try {
    const content = fs.readFileSync(indexPath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TraceIndexEntry);
  } catch {
    return [];
  }
}

function writeIndex(baseDir: string, entries: TraceIndexEntry[]): void {
  const indexPath = resolveIndexFile(baseDir);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  writeFileAtomic(indexPath, content);
}

const DEFAULT_MAX_TRACES = 100;

export function createTraceWriter(deps: TraceWriterDeps): TraceWriter {
  const {
    sessionId,
    baseDir,
    maxTraces = DEFAULT_MAX_TRACES,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = deps;

  ensureTracesDir(baseDir);

  const writer = createBufferedFileWriter<Span>({
    filePath: resolveTraceFile(sessionId, baseDir),
    serialize: (spans) => spans.map((s) => JSON.stringify(s) + "\n").join(""),
    debounceMs,
  });

  function writeSpan(span: Span): void {
    writer.push(span);
  }

  function finalizeTrace(summary: TraceIndexEntry): void {
    const entries = readIndex(baseDir);
    entries.push(summary);

    if (entries.length > maxTraces) {
      rotate(entries);
    }

    writeIndex(baseDir, entries);
  }

  function flush(): void {
    writer.flush();
  }

  function dispose(): void {
    writer.dispose();
  }

  // Evict oldest non-error traces first to preserve error traces longer
  function rotate(entries: TraceIndexEntry[]): void {
    while (entries.length > maxTraces) {
      let evictIdx = -1;
      let oldestTime = Infinity;

      for (let i = 0; i < entries.length; i++) {
        if (entries[i].status !== "error" && entries[i].startTimeMs < oldestTime) {
          oldestTime = entries[i].startTimeMs;
          evictIdx = i;
        }
      }

      if (evictIdx === -1) break;

      const evicted = entries.splice(evictIdx, 1)[0];

      try {
        const filePath = resolveTraceFile(evicted.sessionId, baseDir);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch { /* best-effort */ }
      try {
        const transcriptPath = resolveTranscriptFile(evicted.sessionId, baseDir);
        if (fs.existsSync(transcriptPath)) {
          fs.unlinkSync(transcriptPath);
        }
      } catch { /* best-effort */ }
    }
  }

  return {
    writeSpan,
    finalizeTrace,
    flush,
    dispose,
  };
}
