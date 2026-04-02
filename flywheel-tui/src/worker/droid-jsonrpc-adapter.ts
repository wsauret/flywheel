/**
 * Droid JSON-RPC protocol adapter.
 *
 * Translates between Flywheel's internal NDJSON event format and Droid's
 * JSON-RPC 2.0 protocol (`--input-format stream-jsonrpc --output-format
 * stream-jsonrpc`).
 *
 * Output (stdout) translation:
 *   JSON-RPC notification envelopes → flat NDJSON events matching what
 *   NDJSONParser, CompletionDetector, and StructuredEventParser expect.
 *
 * Input (stdin) translation:
 *   Plain text prompts → JSON-RPC requests (initialize_session, add_user_message).
 *
 * The adapter is stateless per-line. It buffers incomplete lines across
 * chunks (since a single stdout chunk may contain partial JSON lines).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FACTORY_API_VERSION = "1.0.0";
const FACTORY_PROTOCOL_VERSION = "1.1.0";
const JSONRPC_VERSION = "2.0";

// ---------------------------------------------------------------------------
// JSON-RPC message builders (stdin → droid)
// ---------------------------------------------------------------------------

let _requestId = 0;
function nextId(): string {
  return `fw-${++_requestId}`;
}

/**
 * Build a JSON-RPC `droid.initialize_session` request.
 *
 * Must be the first message sent after spawning the droid process.
 * Establishes the session with model, autonomy mode, tool scoping, and cwd.
 */
export function buildInitializeSession(opts: {
  cwd: string;
  modelId: string;
  sessionId?: string;
  enabledToolIds?: string[];
}): string {
  const request = {
    jsonrpc: JSONRPC_VERSION,
    type: "request",
    factoryApiVersion: FACTORY_API_VERSION,
    factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
    id: nextId(),
    method: "droid.initialize_session",
    params: {
      machineId: "flywheel",
      cwd: opts.cwd,
      autonomyMode: "auto-high" as const,
      modelId: opts.modelId,
      ...(opts.sessionId && { sessionId: opts.sessionId }),
      ...(opts.enabledToolIds && { enabledToolIds: opts.enabledToolIds }),
    },
  };
  return JSON.stringify(request) + "\n";
}

/**
 * Build a JSON-RPC `droid.add_user_message` request.
 *
 * Sends a user message to the droid agent. Can be called during an active
 * turn (message is queued and processed after the current turn completes)
 * or between turns (processed immediately).
 */
export function buildAddUserMessage(text: string): string {
  const request = {
    jsonrpc: JSONRPC_VERSION,
    type: "request",
    factoryApiVersion: FACTORY_API_VERSION,
    factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
    id: nextId(),
    method: "droid.add_user_message",
    params: { text },
  };
  return JSON.stringify(request) + "\n";
}

/**
 * Build a JSON-RPC `droid.interrupt_session` request.
 */
export function buildInterruptSession(): string {
  const request = {
    jsonrpc: JSONRPC_VERSION,
    type: "request",
    factoryApiVersion: FACTORY_API_VERSION,
    factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
    id: nextId(),
    method: "droid.interrupt_session",
    params: {},
  };
  return JSON.stringify(request) + "\n";
}

// ---------------------------------------------------------------------------
// Notification type → flat NDJSON translation (droid stdout → Flywheel)
// ---------------------------------------------------------------------------

interface JsonRpcEnvelope {
  jsonrpc: string;
  type: string;
  method?: string;
  id?: string;
  params?: { notification?: Record<string, unknown> };
  result?: Record<string, unknown>;
}

/**
 * Translate a single JSON-RPC notification into zero or more flat NDJSON
 * lines that the existing Flywheel pipeline understands.
 *
 * Returns an array of translated NDJSON strings (each ending with \n),
 * or an empty array if the notification should be silently dropped.
 */
function translateNotification(notification: Record<string, unknown>): string[] {
  const ntype = notification.type as string | undefined;
  if (!ntype) return [];

  switch (ntype) {
    // --- Text streaming ---
    case "assistant_text_delta": {
      const msg = notification as {
        messageId?: string;
        blockIndex?: number;
        textDelta?: string;
      };
      // Emit as flat message event compatible with dispatchDroidEvent
      return [JSON.stringify({
        type: "message",
        role: "assistant",
        id: msg.messageId ?? "",
        text: msg.textDelta ?? "",
        timestamp: Date.now(),
      }) + "\n"];
    }

    // --- Full message creation (user echo, final assistant, tool calls) ---
    case "create_message": {
      const message = notification.message as {
        id?: string;
        role?: string;
        content?: Array<{
          type: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
          tool_use_id?: string;
          content?: string;
          is_error?: boolean;
        }>;
      } | undefined;
      if (!message) return [];

      const lines: string[] = [];
      const content = message.content ?? [];

      // Extract text blocks
      const textParts = content
        .filter(c => c.type === "text" && c.text)
        .map(c => c.text)
        .join("");

      // Extract tool_use blocks
      const toolUses = content.filter(c => c.type === "tool_use");

      // Extract tool_result blocks
      const toolResults = content.filter(c => c.type === "tool_result");

      // Emit text message if present
      if (textParts && message.role === "assistant") {
        lines.push(JSON.stringify({
          type: "message",
          role: "assistant",
          id: message.id ?? "",
          text: textParts,
          timestamp: Date.now(),
        }) + "\n");
      }

      // Emit tool calls
      for (const tu of toolUses) {
        lines.push(JSON.stringify({
          type: "tool_call",
          id: tu.tool_use_id ?? "",
          toolName: tu.name ?? "",
          parameters: tu.input ?? {},
          timestamp: Date.now(),
        }) + "\n");
      }

      // Emit tool results
      for (const tr of toolResults) {
        lines.push(JSON.stringify({
          type: "tool_result",
          id: tr.tool_use_id ?? "",
          toolId: tr.tool_use_id ?? "",
          isError: tr.is_error ?? false,
          value: tr.content ?? "",
          timestamp: Date.now(),
        }) + "\n");
      }

      return lines;
    }

    // --- Tool progress (streaming tool execution updates) ---
    case "tool_progress_update": {
      const tp = notification as {
        toolUseId?: string;
        toolName?: string;
        content?: string;
      };
      return [JSON.stringify({
        type: "tool_call",
        id: tp.toolUseId ?? "",
        toolName: tp.toolName ?? "",
        parameters: {},
        timestamp: Date.now(),
      }) + "\n"];
    }

    // --- Tool result ---
    case "tool_result": {
      const tr = notification as {
        toolUseId?: string;
        toolId?: string;
        isError?: boolean;
        value?: string;
      };
      return [JSON.stringify({
        type: "tool_result",
        id: tr.toolUseId ?? tr.toolId ?? "",
        toolId: tr.toolId ?? "",
        isError: tr.isError ?? false,
        value: tr.value ?? "",
        timestamp: Date.now(),
      }) + "\n"];
    }

    // --- State changes ---
    case "droid_working_state_changed": {
      const state = notification.newState as string | undefined;
      if (state === "idle") {
        // Emit a completion signal that CompletionDetector recognizes
        return [JSON.stringify({
          type: "completion",
          timestamp: Date.now(),
        }) + "\n"];
      }
      // Other state changes (streaming_assistant_message, executing_tool) are informational
      return [];
    }

    // --- Token usage ---
    case "session_token_usage_changed": {
      const usage = notification.tokenUsage as Record<string, unknown> | undefined;
      return [JSON.stringify({
        type: "usage",
        usage: usage ?? {},
        timestamp: Date.now(),
      }) + "\n"];
    }

    // --- Noise we can safely drop ---
    case "settings_updated":
    case "mcp_status_changed":
    case "session_title_updated":
      return [];

    // --- Server-to-client requests (permissions, ask_user) ---
    // These are not notifications but requests that need responses.
    // For now, log them and drop. Future: implement permission handler.
    default:
      return [];
  }
}

/**
 * Translate a JSON-RPC response into flat NDJSON lines.
 *
 * Most responses are ack-only (empty result). The init response carries
 * session ID which we extract for session tracking.
 */
function translateResponse(id: string, result: Record<string, unknown> | undefined): string[] {
  if (!result) return [];

  // Initialize session response — emit system init event with session_id
  if (typeof result.sessionId === "string") {
    return [JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: result.sessionId,
      timestamp: Date.now(),
    }) + "\n"];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Streaming stdout adapter
// ---------------------------------------------------------------------------

/**
 * Creates a stdout chunk translator that converts JSON-RPC output into
 * flat NDJSON that the existing Flywheel pipeline consumes.
 *
 * Usage: wrap the `onStdout` callback with this adapter so that
 * NDJSONParser receives flat NDJSON instead of JSON-RPC envelopes.
 *
 * ```ts
 * const adapter = createStdoutAdapter();
 * const onStdout = (chunk: string) => {
 *   const translated = adapter.translate(chunk);
 *   originalOnStdout(translated);
 * };
 * ```
 */
export function createStdoutAdapter(): {
  /** Translate a raw stdout chunk. Returns translated NDJSON text. */
  translate(chunk: string): string;
} {
  let lineBuffer = "";

  return {
    translate(chunk: string): string {
      lineBuffer += chunk;
      const lines: string[] = [];
      let idx: number;

      while ((idx = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (!line) continue;

        let envelope: JsonRpcEnvelope;
        try {
          envelope = JSON.parse(line) as JsonRpcEnvelope;
        } catch {
          // Not JSON — pass through as-is (stderr leak, etc.)
          lines.push(line + "\n");
          continue;
        }

        // Route by message type
        if (envelope.type === "notification" && envelope.params?.notification) {
          const translated = translateNotification(
            envelope.params.notification as Record<string, unknown>,
          );
          lines.push(...translated);
        } else if (envelope.type === "response" && envelope.id) {
          const translated = translateResponse(
            envelope.id,
            envelope.result as Record<string, unknown> | undefined,
          );
          lines.push(...translated);
        }
        // Requests from server (e.g., droid.request_permission) are dropped for now
      }

      return lines.join("");
    },
  };
}
