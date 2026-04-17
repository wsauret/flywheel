/**
 * Canonical set of tool names that represent subagent spawns.
 * Reconciles the two previous sets:
 *   - structured-event-parser.ts had ["task", "agent"]
 *   - trace-event-handler.ts had ["Task", "dispatch_agent"]
 * All entries are lowercase; consumers normalize before lookup.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "task",
  "agent",
  "dispatch_agent",
]);
