/**
 * NDJSON (Newline-Delimited JSON) streaming parser for worker output.
 *
 * - Line buffering with partial line handling across chunks
 * - \r\n -> \n normalization
 * - ANSI escape code stripping before JSON parse
 * - Garbage-prefix JSON extraction (e.g., log text before `{`)
 * - MAX_LINE_LENGTH (1MB) guard: oversized lines flushed as raw text
 * - Event routing per parsed type
 * - Feeds through 3-tier buffer system
 */

import { TieredBuffer } from "./buffer";

/** Maximum line length before flushing as raw text (1MB). */
export const MAX_LINE_LENGTH = 1_000_000;

/** Known NDJSON event types from worker output. */
export type NDJSONEventType = "tool_use" | "text" | "step_finish" | "error" | "unknown";

/** A parsed NDJSON event. */
export interface NDJSONEvent {
  type: NDJSONEventType;
  data: Record<string, unknown>;
  raw: string;
}

/** Callback for parsed NDJSON events. */
export type NDJSONEventHandler = (event: NDJSONEvent) => void;

/** Callback for raw text lines (non-JSON or oversized). */
export type RawTextHandler = (text: string) => void;

/**
 * ANSI escape code regex (covers CSI sequences, OSC, etc.).
 */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[>=<]|\x1b\[\?[0-9;]*[hl]/g;

/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Attempt to extract a JSON object from a line that may have garbage prefix.
 * Looks for the first `{` and tries to parse from there.
 */
export function extractJSON(line: string): Record<string, unknown> | null {
  const idx = line.indexOf("{");
  if (idx === -1) return null;

  const candidate = line.slice(idx);
  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/**
 * Classify a parsed JSON event into a known type.
 */
function classifyEvent(data: Record<string, unknown>): NDJSONEventType {
  const type = data.type;
  if (typeof type === "string") {
    if (type === "tool_use") return "tool_use";
    if (type === "text") return "text";
    if (type === "step_finish") return "step_finish";
    if (type === "error") return "error";
  }
  return "unknown";
}

/**
 * Streaming NDJSON parser.
 */
export class NDJSONParser {
  private buffer = "";
  private _sessionId: string | null = null;
  private tieredBuffer: TieredBuffer;

  /** Parsed event handler. */
  onEvent: NDJSONEventHandler = () => {};
  /** Raw text handler (non-JSON or oversized lines). */
  onRawText: RawTextHandler = () => {};

  constructor(tieredBuffer?: TieredBuffer) {
    this.tieredBuffer = tieredBuffer ?? new TieredBuffer();
  }

  /** Session ID captured from the first JSON event with a sessionID field. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** The underlying tiered buffer. */
  get outputBuffer(): TieredBuffer {
    return this.tieredBuffer;
  }

  /**
   * Feed a chunk of data into the parser.
   * Handles partial lines across chunk boundaries.
   */
  write(chunk: string): void {
    // Normalize CRLF line endings first
    let normalized = chunk.replace(/\r\n/g, "\n");
    // Handle \r overwrite semantics (CLI progress bars):
    // Standalone \r causes everything before it on the same line to be overwritten.
    // Must come AFTER \r\n normalization to avoid treating CRLF \r as overwrite.
    normalized = normalized.replace(/^[^\n]*\r([^\r\n]*)/gm, "$1");

    // Feed to tiered buffer
    this.tieredBuffer.append(normalized);

    this.buffer += normalized;

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.processLine(line);
    }

    // Guard: if buffer exceeds MAX_LINE_LENGTH, flush as raw text and truncate
    if (this.buffer.length > MAX_LINE_LENGTH) {
      this.onRawText(this.buffer);
      this.buffer = "";
    }
  }

  /**
   * Flush any remaining partial line (call on process exit).
   */
  flush(): void {
    if (this.buffer.length > 0) {
      this.processLine(this.buffer);
      this.buffer = "";
    }
  }

  private processLine(line: string): void {
    if (line.length === 0) return;

    // Strip ANSI codes before attempting parse
    const cleaned = stripAnsi(line);

    // Try direct JSON parse
    try {
      const parsed = JSON.parse(cleaned);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        this.emitEvent(parsed as Record<string, unknown>, line);
        return;
      }
    } catch {
      // Not valid JSON — try garbage-prefix extraction
    }

    // Try extracting JSON from garbage prefix
    const extracted = extractJSON(cleaned);
    if (extracted) {
      this.emitEvent(extracted, line);
      return;
    }

    // Not JSON — emit as raw text
    this.onRawText(line);
  }

  private emitEvent(data: Record<string, unknown>, raw: string): void {
    // Capture session ID from first event that has it.
    // Claude CLI uses "sessionID" (camelCase) in step_finish events
    // and "session_id" (snake_case) in system/init and result events.
    if (this._sessionId === null) {
      if (typeof data.sessionID === "string") {
        this._sessionId = data.sessionID;
      } else if (typeof data.session_id === "string") {
        this._sessionId = data.session_id;
      }
    }

    const type = classifyEvent(data);
    this.onEvent({ type, data, raw });
  }
}
