import { strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

const TOOL_CALL = /\btools\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)/g;

export const codeDisplay: ToolDisplay = {
  name: "code",
  action: "shell_exec",
  displayName: "Code",
  verbs: { progressive: "Execute", past: "Executed" },
  isOptimistic: false,
  preservesResultContent: true,
  getDetail: () => null,
  // A program is named by the tools it calls, which is the work a person follows.
  getSentence: (input) => {
    const calls = [...new Set([...(strField(input, "source") ?? "").matchAll(TOOL_CALL)].map((match) => `${match[1]}.${match[2]}`))];
    return { name: "Ran", detail: calls.length === 0 ? "code" : `code calling ${calls.join(", ")}` };
  },
};
