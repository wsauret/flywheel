import type { ToolDisplay } from "../types.js";

/** The models the session can use, read like any other listing. */
export const modelsDisplay: ToolDisplay = {
  name: "models",
  action: "list",
  displayName: "List Models",
  verbs: { progressive: "Listing models", past: "Listed models" },
  isOptimistic: false,
  getDetail: () => null,
};
