import type { ToolEntry } from "../../output-blocks.js";

/** A tool whose row is in the block tree, addressed by where it landed. */
export type PlacedTool =
  | { kind: "agent"; agentId: string; spawnedAt: number; toolName: string }
  | { kind: "standalone"; toolName: string; streamsInput: boolean };

export interface PendingToolInfo {
  name: string;
  timestamp: number;
  renderLayout: "subagent" | "standalone-mutation" | "row";
  runCategoryOverride?: "execute";
  presentationOverride?: ToolEntry["presentation"];
}
