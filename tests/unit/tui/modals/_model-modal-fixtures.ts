import type { ModelAssignmentRow } from "../../../../src/protocol/model-assignment-protocol-types.js";
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js";
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" };
import { RGBA } from "@opentui/core";

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
export function fakeRow(roleId: string, label: string): ModelAssignmentRow {
  return {
    slot: roleSlot(roleId),
    label,
    model: "claude-opus-4-6",
    effort: "high",
    modelSource: "explicit",
    matchesInheritedPair: false,
  };
}

export const theme = {
  ...resolveTheme(flywheelTheme, "dark"),
  primary: RGBA.fromHex("#ffaa55"),
  info: RGBA.fromHex("#55aaff"),
  success: RGBA.fromHex("#55dd88"),
  error: RGBA.fromHex("#dd5577"),
  background: RGBA.fromHex("#171717"),
  text: RGBA.fromHex("#f4f1ec"),
  textMuted: RGBA.fromHex("#8f877d"),
  textSubtle: RGBA.fromHex("#a69c91"),
  warning: RGBA.fromHex("#f0c35f"),
};

export function styledTextContent(text: { chunks: ReadonlyArray<{ text: string }> }): string {
  return text.chunks.map((chunk) => chunk.text).join("");
}
