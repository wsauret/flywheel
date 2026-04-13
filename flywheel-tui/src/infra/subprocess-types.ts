/**
 * Subprocess payload types and schemas — canonical, single source of truth.
 *
 * Zod schemas define the shapes; static types are derived via z.infer.
 * Schema values are exported for type derivation and test validation.
 * All layers import from here.
 */

import { z } from "zod";

// SubprocessFailureReason — discriminated union of failure kinds

export const SubprocessFailureReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timeout"), timeoutMs: z.number(), message: z.string() }),
  z.object({ kind: z.literal("exit_code"), exitCode: z.number(), message: z.string() }),
  z.object({ kind: z.literal("schema_error"), message: z.string() }),
  z.object({ kind: z.literal("api_error"), message: z.string() }),
  z.object({ kind: z.literal("rate_limited"), message: z.string() }),
  z.object({ kind: z.literal("transient"), message: z.string() }),
  z.object({ kind: z.literal("interrupted"), message: z.string() }),
  z.object({ kind: z.literal("handoff_missing"), message: z.string() }),
  z.object({ kind: z.literal("handoff_invalid"), message: z.string() }),
]);

export type SubprocessFailureReason = z.infer<typeof SubprocessFailureReasonSchema>;

// SubprocessResult — output of a subprocess execution

export const SubprocessResultSchema = z.object({
  output: z.string(),
  exitCode: z.number(),
  truncated: z.boolean(),
  durationMs: z.number(),
  failure: SubprocessFailureReasonSchema.optional(),
  sessionId: z.string().optional(),
  handoffPath: z.string(),
});

export type SubprocessResult = z.infer<typeof SubprocessResultSchema>;

// ── Content blocks within Claude assistant messages ──

interface ThinkingContentBlock {
  type: "thinking";
  thinking: string;
}

interface TextContentBlock {
  type: "text";
  text: string;
}

interface ToolUseContentBlock {
  type: "tool_use";
  id?: string;
  name: string;
  input?: Record<string, unknown>;
}

export type ContentBlock = ThinkingContentBlock | TextContentBlock | ToolUseContentBlock;

// ── Typed data shapes per NDJSON event type ──
// Claude Code's NDJSON stream is an external format. These interfaces encode
// the expected shape; consumers guard against missing fields defensively.

export interface AssistantEventData {
  type: "assistant";
  message?: {
    content?: ContentBlock[];
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    parent_tool_use_id?: string | null;
  };
  parent_tool_use_id?: string | null;
}

interface ToolResultEventData {
  type: "tool_result";
  tool_use_id?: string;
  is_error?: boolean;
  content?: string;
}

interface ResultEventData {
  type: "result";
  is_error?: boolean;
  subtype?: string;
  result?: string;
  modelUsage?: Record<string, { contextWindow?: number }>;
}

interface ContentBlockDeltaData {
  type: "content_block_delta";
  delta?: {
    type: string;
    thinking?: string;
    text?: string;
  };
}

interface DirectToolUseData {
  type: "tool_use";
  name: string;
  input?: Record<string, unknown>;
}

// ── NDJSONEvent — discriminated union on `type` with typed `data` per variant ──

export type NDJSONEvent =
  | { type: "assistant"; data: AssistantEventData; raw: string }
  | { type: "tool_result"; data: ToolResultEventData; raw: string }
  | { type: "result"; data: ResultEventData; raw: string }
  | { type: "content_block_delta"; data: ContentBlockDeltaData; raw: string }
  | { type: "tool_use"; data: DirectToolUseData; raw: string }
  | { type: "user"; data: Record<string, unknown>; raw: string }
  | { type: "system"; data: Record<string, unknown>; raw: string }
  | { type: "text"; data: Record<string, unknown>; raw: string }
  | { type: "step_finish"; data: Record<string, unknown>; raw: string }
  | { type: "error"; data: Record<string, unknown>; raw: string }
  | { type: "flywheel:subprocess_boundary"; data: Record<string, unknown>; raw: string }
  | { type: "unknown"; data: Record<string, unknown>; raw: string };
