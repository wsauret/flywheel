import { singleLine, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

/** The lead's search of the project's past chats, shown by its keywords. */
export const findChatDisplay: ToolDisplay = {
  name: "find_chat",
  action: "ui_meta",
  displayName: "Find Chat",
  verbs: { progressive: "Finding a chat", past: "Found chats" },
  isOptimistic: false,
  getPresentation: (input) => ({ name: "Find chat", detail: singleLine(strField(input, "query")) ?? "" }),
};
