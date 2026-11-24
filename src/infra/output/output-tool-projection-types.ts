import type { ToolEntry } from "../output-blocks.js";
import type { ToolInput } from "./output-projection-events.js";

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

interface StandaloneToolLocation {
  index: number;
  toolName: string;
}

/** The one write a standalone handler makes: it adds its row to the block
 *  tree and gets back the index where the row was inserted. The index is read
 *  before cap eviction, which can move the row to a lower index. */
export interface StandaloneToolSink {
  pushStandaloneToolEntry(tool: ToolEntry): number;
}

export type StandaloneHandler = (
  input: ToolInput | undefined,
  now: number,
  sink: StandaloneToolSink,
  toolUseId?: string,
) => StandaloneToolLocation | null;
