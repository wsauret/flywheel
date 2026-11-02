import { errorMessage } from "../../../../infra/error-message.js";
import { Log } from "../../../../infra/log.js";
import type { RuntimeEvent } from "../../../../infra/runtime-event-types.js";
import { createToolUseCounter } from "../../../../infra/runtime-tool-records.js";
import type { SubagentTurnLogObserver } from "./work-log.js";

const log = Log.create({ service: "subagent-stream-filter" });

export interface SubagentStats {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  totalReasoningTokens: number;
  toolUseCount: number;
}

export interface SubagentTextState {
  /** The text of the run's final answer: every text block of the latest
   *  message that wrote text, or empty once a later message only calls tools. */
  finalAssistantText: string;
}

export function createSubagentStats(): SubagentStats {
  return {
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreateTokens: 0,
    totalReasoningTokens: 0,
    toolUseCount: 0,
  };
}

export function createFilteredSubagentStream(input: {
  onRenderEvent: (event: RuntimeEvent) => void;
  agentType: string;
  stats: SubagentStats;
  textState: SubagentTextState;
  turnLog?: SubagentTurnLogObserver;
}): (event: RuntimeEvent) => void {
  let forwardedCount = 0;
  const countToolUses = createToolUseCounter();
  return (event: RuntimeEvent): void => {
    input.stats.toolUseCount = countToolUses(event);
    if (event.type === "model.turn.completed") {
      handleResultEvent(event, input.stats, input.agentType);
      return;
    }
    if (event.type === "tool.result.recorded" && input.turnLog) {
      recordToolResult(event, input.turnLog);
    }
    if (event.type === "tool.input.completed") {
      const { tool_use } = event.data;
      input.turnLog?.recordToolUse(tool_use.id, tool_use.name, tool_use.input);
    }
    try {
      if (event.type === "model.content.delta" || event.type === "model.text.completed") return;
      if (event.type === "model.assistant_message.recorded") scanAssistantContent(event.data, input.textState);
      forwardedCount++;
      if (forwardedCount <= 3 || forwardedCount % 50 === 0) {
        log.debug("subagent event forwarded", {
          agentType: input.agentType,
          eventType: event.type,
          forwardedCount,
        });
      }
      input.onRenderEvent(event);
    } catch (err) {
      log.warn("filteredOnEvent error", { error: errorMessage(err), agentType: input.agentType });
    }
  };
}

// `event` is already narrowed to the `model.turn.completed` member by the caller,
// so `event.data` is the typed `ResultEventData` from runtime-event-types - the
// single source of truth for `total_cost_usd`/`usage`. Reading the typed union
// member instead of re-casting an ad-hoc shape stops the validate-and-discard
// that silently zeroed subagent cost/token attribution (ARCH-BOUNDARIES-004). A missing `total_cost_usd` is still a real signal we surface, then
// fall through to 0 because the runtime fact legitimately makes the field
// optional on streamed turns.
function handleResultEvent(event: Extract<RuntimeEvent, { type: "model.turn.completed" }>, stats: SubagentStats, agentType: string): void {
  const { total_cost_usd, usage } = event.data;
  if (total_cost_usd == null) log.warn("subagent result event missing total_cost_usd", { agentType });
  stats.totalCostUsd = total_cost_usd ?? 0;
  stats.totalInputTokens = usage?.input_tokens ?? 0;
  stats.totalOutputTokens = usage?.output_tokens ?? 0;
  stats.totalCacheReadTokens = usage?.cache_read_input_tokens ?? 0;
  stats.totalCacheCreateTokens = usage?.cache_creation_input_tokens ?? 0;
  stats.totalReasoningTokens = usage?.reasoning_tokens ?? 0;
}

function scanAssistantContent(
  data: { message?: { content?: Array<{ type: string; text?: string }> } },
  textState: SubagentTextState,
): void {
  const content = data.message?.content ?? [];
  const texts = content.flatMap((block) => block.type === "text" && block.text ? [block.text] : []);
  if (texts.length > 0) textState.finalAssistantText = texts.join("\n\n");
  // Narration before a tool call is not an answer. A message with neither
  // text nor a tool call (thinking only) leaves the answer in place.
  else if (content.some((block) => block.type === "tool_use")) textState.finalAssistantText = "";
}

// `event` is already narrowed to the `tool.result.recorded` member by the
// caller, so `event.data` is the typed `ToolResultEventData`. Reading the union
// member instead of re-casting an ad-hoc shape keeps the schema as the single
// source of truth for the field types (ARCH-BOUNDARIES-004).
function recordToolResult(event: Extract<RuntimeEvent, { type: "tool.result.recorded" }>, turnLog: SubagentTurnLogObserver): void {
  const data = event.data;
  if (!data.tool_use_id) return;
  turnLog.recordToolResult(data.tool_use_id, data.content, data.is_error === true, data.interrupted === true);
}
