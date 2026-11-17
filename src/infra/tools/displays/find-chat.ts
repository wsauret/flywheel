import { singleLine, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

/** The lead's search of the project's past sessions, shown by its keywords. */
export const findChatDisplay: ToolDisplay = {
  name: "find_chat",
  action: "ui_meta",
  displayName: "Find Session",
  verbs: { progressive: "Finding a session", past: "Found sessions" },
  isOptimistic: false,
  getPresentation: (input) => ({ name: "Find session", detail: singleLine(strField(input, "query")) ?? "" }),
};
