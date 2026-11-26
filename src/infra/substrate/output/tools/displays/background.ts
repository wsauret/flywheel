import { strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

export const historicalBackgroundDisplay: ToolDisplay = {
  name: "background",
  action: "ui_meta",
  displayName: "Background",
  verbs: { progressive: "Managing background work", past: "Managed background work" },
  isOptimistic: false,
  hiddenFromTranscript: true,
  getDetail: (input) => strField(input, "action") ?? null,
};