import { OutputBuffer } from "./output-buffer";
import type { NDJSONEvent } from "./subprocess-types";

export const MAX_LINE_LENGTH = 1_000_000;

type NDJSONEventHandler = (event: NDJSONEvent) => void;
type RawTextHandler = (text: string) => void;

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[>=<]|\x1b\[\?[0-9;]*[hl]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

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

const KNOWN_TYPES = new Set([
  "assistant", "system", "user", "tool_result", "result",
  "tool_use", "content_block_delta", "text", "step_finish", "error",
] as const);

function classifyEvent(data: Record<string, unknown>): NDJSONEvent["type"] {
  const type = data.type;
  return typeof type === "string" && (KNOWN_TYPES as Set<string>).has(type)
    ? type as NDJSONEvent["type"]
    : "unknown";
}

export class NDJSONParser {
  private buffer = "";
  private _sessionId: string | null = null;
  private _outputBuffer: OutputBuffer;

  onEvent: NDJSONEventHandler = () => {};
  onRawText: RawTextHandler = () => {};

  constructor(outputBuffer?: OutputBuffer) {
    this._outputBuffer = outputBuffer ?? new OutputBuffer();
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get outputBuffer(): OutputBuffer {
    return this._outputBuffer;
  }

  write(chunk: string): void {
    let normalized = chunk.replace(/\r\n/g, "\n");
    // \r overwrite semantics (CLI progress bars) — must come after \r\n normalization
    normalized = normalized.replace(/^[^\n]*\r([^\r\n]*)/gm, "$1");

    this._outputBuffer.append(normalized);

    this.buffer += normalized;

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.processLine(line);
    }

    if (this.buffer.length > MAX_LINE_LENGTH) {
      this.onRawText(this.buffer);
      this.buffer = "";
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.processLine(this.buffer);
      this.buffer = "";
    }
  }

  private processLine(line: string): void {
    if (line.length === 0) return;

    const cleaned = stripAnsi(line);

    try {
      const parsed = JSON.parse(cleaned);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        this.emitEvent(parsed as Record<string, unknown>, line);
        return;
      }
    } catch { /* not valid JSON — try garbage-prefix extraction */ }

    const extracted = extractJSON(cleaned);
    if (extracted) {
      this.emitEvent(extracted, line);
      return;
    }

    this.onRawText(line);
  }

  private emitEvent(data: Record<string, unknown>, raw: string): void {
    // Claude CLI uses "sessionID" (camelCase) in step_finish and "session_id" (snake_case) in result events
    if (this._sessionId === null) {
      if (typeof data.sessionID === "string") {
        this._sessionId = data.sessionID;
      } else if (typeof data.session_id === "string") {
        this._sessionId = data.session_id;
      }
    }

    const type = classifyEvent(data);
    // Single boundary cast: raw JSON → typed discriminated union
    this.onEvent({ type, data, raw } as NDJSONEvent);
  }
}
