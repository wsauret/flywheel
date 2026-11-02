import { strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDisplay, ToolPresentationResolution } from "../types.js";

const TITLE_LIMIT = 96;

function papercutTitle(observation: string): string {
  const singleLine = observation.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= TITLE_LIMIT) return singleLine;
  return `${singleLine.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

function papercutPresentation(input: ToolInput): ToolPresentationResolution {
  const observation = strField(input, "observation");
  if (!observation) return "input_not_ready";
  return { name: "Papercut", detail: papercutTitle(observation) };
}

export const papercutDisplay: ToolDisplay = {
  name: "papercut_log",
  action: "ui_meta",
  displayName: "Papercut",
  verbs: { progressive: "Recording papercut", past: "Recorded papercut" },
  isOptimistic: false,
  invocationBody: (input) => {
    const observation = strField(input, "observation");
    return observation ? { content: observation, filetype: "text", presentation: "disclosure" } : undefined;
  },
  getPresentation: papercutPresentation,
};

export const papercutDisposeDisplay: ToolDisplay = {
  name: "papercut_dispose",
  action: "ui_meta",
  displayName: "Close Papercut",
  verbs: { progressive: "Closing papercut", past: "Closed papercut" },
  isOptimistic: false,
  getDetail: (input) => strField(input, "disposition") ?? null,
};
