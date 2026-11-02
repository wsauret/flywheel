import { strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

/** A simulator action is a command whose output the row keeps. */
export const iosSimulatorDisplay: ToolDisplay = {
  name: "ios_simulator",
  action: "shell_exec",
  displayName: "iOS Simulator",
  verbs: { progressive: "Driving simulator", past: "Drove simulator" },
  isOptimistic: false,
  preservesResultContent: true,
  getDetail: (input) => [strField(input, "workflow"), strField(input, "action")].filter(Boolean).join(" ") || null,
};
