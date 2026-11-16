import type { LlmToolOutputPart } from "../../../../src/infra/llm/tool-output-part-schema.js";
import type { AnyBlock, ToolEntry, AgentGroupBlock } from "../../../../src/infra/output-blocks.js";
import { resolveTrackedToolResult as resolveTrackedToolResultAtCwd } from "../../../../src/infra/output/structured-event-tool-results.js";
import type { PlacedTool } from "../../../../src/infra/output/output-tool-projection-types.js";
import type { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder.js";
import type { ToolOutcome } from "../../../../src/infra/tool-outcome.js";

export function textContent(text: string): LlmToolOutputPart[] {
  return [{ type: "text", text }];
}

export function resolveTrackedToolResult(
  builder: StructuredOutputBuilder,
  tracked: PlacedTool,
  toolUseId: string,
  outcome: ToolOutcome,
  rawContent?: LlmToolOutputPart[],
  details?: unknown,
  executionOutputTail?: string,
): void {
  resolveTrackedToolResultAtCwd(builder, tracked, toolUseId, outcome, "/workspace", rawContent, details, executionOutputTail);
}

export function agentBlock(builder: StructuredOutputBuilder): AgentGroupBlock {
  const block = builder.getBlocks()[0];
  if (block?.kind !== "agentGroup") throw new Error("expected agent group block");
  return block;
}

export function toolBlock(builder: StructuredOutputBuilder): ToolEntry {
  const block = builder.getBlocks()[0];
  if (block?.kind !== "tool") throw new Error("expected tool block");
  return block;
}

export function outputPatch(block: AnyBlock) {
  return {
    cursor: { scope: "session", domain: "output", sessionId: "s1" },
    position: 1,
    prevPosition: 0,
    payload: {
      kind: "output.delta",
      delta: { visibleMessageCount: 0, blocks: [{ kind: "upsert", index: 0, blockId: "tool:test", block }] },
    },
  } as const;
}
