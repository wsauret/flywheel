/**
 * Parses OpenCode JSONL streaming output for subagent tracing.
 * Extracts Task tool invocations and converts them to ClaudeJsonlMessage format
 * for compatibility with the SubagentTraceParser.
 *
 * OpenCode's format differs from Claude in that subagent spawns and
 * completions arrive in a single `tool_use` event with the result already
 * populated in `state.output`.
 */

import type { ClaudeJsonlMessage } from './types';

/**
 * Represents an OpenCode JSONL message structure.
 */
export interface OpenCodeJsonlMessage {
  source: 'opencode';
  type?: string;
  timestamp?: number;
  sessionID?: string;
  part?: OpenCodePart;
  raw: Record<string, unknown>;
}

/**
 * The 'part' field within OpenCode messages.
 */
export interface OpenCodePart {
  id?: string;
  type?: string;
  tool?: string;
  callID?: string;
  state?: OpenCodeToolState;
  text?: string;
}

/**
 * Tool state within an OpenCode tool_use event.
 */
export interface OpenCodeToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  time?: {
    start?: number;
    end?: number;
  };
  metadata?: {
    sessionId?: string;
    summary?: unknown[];
  };
}

/**
 * Result of parsing an OpenCode JSONL line.
 */
export type OpenCodeJsonlParseResult =
  | { success: true; message: OpenCodeJsonlMessage }
  | { success: false; raw: string; error: string };

/**
 * Strip ANSI escape sequences from a string.
 */
const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

/**
 * Extract JSON object from a line that may have garbage prefix.
 */
function extractJson(str: string): string {
  const firstBrace = str.indexOf('{');
  if (firstBrace === -1) {
    return str;
  }
  return str.slice(firstBrace);
}

/**
 * Parse a single OpenCode JSONL line.
 */
export function parseOpenCodeJsonlLine(line: string): OpenCodeJsonlParseResult {
  const stripped = stripAnsi(line);
  const jsonPart = extractJson(stripped);
  const trimmed = jsonPart.trim();

  if (!trimmed) {
    return { success: false, raw: line, error: 'Empty line' };
  }

  try {
    const parsed = JSON.parse(trimmed);

    if (typeof parsed !== 'object' || parsed === null) {
      return { success: false, raw: line, error: 'Invalid JSON object' };
    }

    const payload = parsed as Record<string, unknown>;

    const message: OpenCodeJsonlMessage = {
      source: 'opencode',
      type: typeof payload.type === 'string' ? payload.type : undefined,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : undefined,
      sessionID: typeof payload.sessionID === 'string' ? payload.sessionID : undefined,
      part: typeof payload.part === 'object' && payload.part !== null
        ? payload.part as OpenCodePart
        : undefined,
      raw: payload,
    };

    return { success: true, message };
  } catch (err) {
    return {
      success: false,
      raw: line,
      error: err instanceof Error ? err.message : 'Parse error',
    };
  }
}

/**
 * Check if an OpenCode message is a Task tool invocation (subagent).
 */
export function isOpenCodeTaskTool(message: OpenCodeJsonlMessage): boolean {
  if (message.type !== 'tool_use') {
    return false;
  }

  const toolName = message.part?.tool;
  if (typeof toolName !== 'string') return false;
  const lower = toolName.toLowerCase();
  return lower === 'task' || lower === 'agent';
}

/**
 * Convert an OpenCode Task tool message to ClaudeJsonlMessage format(s).
 *
 * OpenCode sends subagent spawn + complete in a single event, so we generate
 * TWO ClaudeJsonlMessages:
 * 1. A 'tool_use' message for the spawn (with input parameters)
 * 2. A 'tool_result' message for the completion (with output)
 */
export function openCodeTaskToClaudeMessages(message: OpenCodeJsonlMessage): ClaudeJsonlMessage[] {
  const results: ClaudeJsonlMessage[] = [];

  if (!isOpenCodeTaskTool(message)) {
    return results;
  }

  const part = message.part;
  const state = part?.state;
  const input = state?.input;

  if (!input) {
    return results;
  }

  const callId = part?.callID || `opencode_${message.timestamp || Date.now()}`;

  // 1. Create spawn message (tool_use)
  const spawnMessage: ClaudeJsonlMessage = {
    type: 'assistant',
    tool: {
      name: 'Task',
      input: input as Record<string, unknown>,
    },
    raw: {
      type: 'assistant',
      tool_use_id: callId,
      content: [
        {
          type: 'tool_use',
          id: callId,
          name: 'Task',
          input: input,
        },
      ],
    },
  };
  results.push(spawnMessage);

  // 2. Create completion message (tool_result)
  // Only create if the tool has completed (has output or status === 'completed')
  if (state?.output || state?.status === 'completed') {
    const resultMessage: ClaudeJsonlMessage = {
      type: 'result',
      result: state.output,
      raw: {
        type: 'tool_result',
        tool_use_id: callId,
        content: state.output || '',
        is_error: false,
      },
    };
    results.push(resultMessage);
  }

  return results;
}

/**
 * Create a streaming JSONL parser for OpenCode output.
 * Buffers partial lines and emits complete parsed messages.
 */
export function createOpenCodeStreamingJsonlParser(): {
  push: (chunk: string) => OpenCodeJsonlParseResult[];
  flush: () => OpenCodeJsonlParseResult[];
  getState: () => { messages: OpenCodeJsonlMessage[] };
} {
  let buffer = '';
  const messages: OpenCodeJsonlMessage[] = [];

  return {
    push(chunk: string): OpenCodeJsonlParseResult[] {
      buffer += chunk;
      const results: OpenCodeJsonlParseResult[] = [];

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const result = parseOpenCodeJsonlLine(line);
        results.push(result);

        if (result.success) {
          messages.push(result.message);
        }
      }

      return results;
    },

    flush(): OpenCodeJsonlParseResult[] {
      if (!buffer.trim()) {
        buffer = '';
        return [];
      }

      const result = parseOpenCodeJsonlLine(buffer);
      buffer = '';

      if (result.success) {
        messages.push(result.message);
      }

      return [result];
    },

    getState(): { messages: OpenCodeJsonlMessage[] } {
      return { messages };
    },
  };
}

/**
 * Type guard to check if a message is an OpenCode JSONL message.
 */
export function isOpenCodeJsonlMessage(message: unknown): message is OpenCodeJsonlMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as OpenCodeJsonlMessage).source === 'opencode'
  );
}
