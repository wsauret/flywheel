import { numField, singleLine, strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

function recallDetail(input: ToolInput): string | null {
  const parts: string[] = [];
  const query = singleLine(strField(input, "query"));
  if (query) parts.push(`"${query}"`);
  const expand = input.expand;
  if (Array.isArray(expand) && expand.length > 0) parts.push(`expand ${expand.join(", ")}`);
  const page = numField(input, "page");
  if (page !== undefined && page > 1) parts.push(`page ${page}`);
  const offset = numField(input, "offset");
  const limit = numField(input, "limit");
  if (offset !== undefined) parts.push(`offset ${offset}`);
  if (limit !== undefined) parts.push(`limit ${limit}`);
  if (strField(input, "scope") === "all") parts.push("(scope: all)");
  return parts.length > 0 ? parts.join(" ") : "recent history";
}

export const recallDisplay: ToolDisplay = {
  name: "recall",
  action: "search",
  displayName: "Recall",
  verbs: { progressive: "Recalling", past: "Recalled" },
  isOptimistic: true,
  getDetail: recallDetail,
};
