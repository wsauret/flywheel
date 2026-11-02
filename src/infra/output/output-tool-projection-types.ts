import type { ToolEntry } from "../output-blocks.js";
import type { StructuredOutputBuilder } from "./structured-output-builder.js";
import type { ToolInput } from "./output-projection-events.js";

/** A tool whose row is in the block tree, addressed by where it landed. */
export type PlacedTool =
  | { kind: "agent"; agentId: string; spawnedAt: number; toolName: string }
  | { kind: "row"; agentId: string; childIndex: number; toolName: string; streamsInput: boolean; inSubagent: boolean }
  | { kind: "standalone"; toolName: string; streamsInput: boolean };

/** A visible tool the projector follows at its stable position in the tree. */
export type TrackedTool = PlacedTool;

export interface PendingToolInfo {
  name: string;
  timestamp: number;
  parentAgentId: string | undefined;
  renderLayout: "subagent" | "standalone-mutation" | "row";
  runCategoryOverride?: "execute";
  presentationOverride?: ToolEntry["presentation"];
}

interface StandaloneToolLocation {
  index: number;
  toolName: string;
}

export type StandaloneHandler = (
  input: ToolInput | undefined,
  now: number,
  builder: StructuredOutputBuilder,
  toolUseId?: string,
) => StandaloneToolLocation | null;
