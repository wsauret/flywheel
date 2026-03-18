/**
 * Subagent tracing: detects Task tool invocations in Claude/OpenCode JSONL
 * streams and tracks subagent hierarchy, lifecycle, and summary metrics.
 */

export { SubagentTraceParser } from './parser';

export {
  parseOpenCodeJsonlLine,
  isOpenCodeTaskTool,
  openCodeTaskToClaudeMessages,
  createOpenCodeStreamingJsonlParser,
  isOpenCodeJsonlMessage,
} from './opencode-adapter';

export { isSubagentToolName } from './types';

export type {
  ClaudeJsonlMessage,
  SubagentEventType,
  SubagentEvent,
  SubagentSpawnEvent,
  SubagentCompleteEvent,
  SubagentErrorEvent,
  SubagentState,
  SubagentEventCallback,
  SubagentTraceParserOptions,
  SubagentTraceSummary,
} from './types';

export type {
  OpenCodeJsonlMessage,
  OpenCodePart,
  OpenCodeToolState,
  OpenCodeJsonlParseResult,
} from './opencode-adapter';
