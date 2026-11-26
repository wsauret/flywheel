import { formatDisplayPath, listDetail, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

export const listDisplay: ToolDisplay = {
  name: "list",
  action: "list",
  displayName: "List",
  verbs: { progressive: "Listing", past: "Listed" },
  isOptimistic: true,
  preservesResultContent: true,
  getDetail: listDetail,
  getSentence: (input, cwd) => ({ name: listDisplay.verbs.past, detail: formatDisplayPath(strField(input, "path") ?? ".", cwd) ?? "." }),
};
