import type { ToolInput } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";
import { isRecord } from "../../record.js";
import { displayUrl } from "../shell-programs.js";

/** The row detail names the first operation the call carries, in the
 *  precedence a reader would ask about: what was searched, else what was
 *  opened, else what was found or clicked. */
function firstOperation(input: ToolInput, key: string): ToolInput | undefined {
  const operations = input[key];
  if (!Array.isArray(operations) || operations.length === 0) return undefined;
  const head: unknown = operations[0];
  return isRecord(head) ? head : undefined;
}

function webDetail(input: ToolInput): string | null {
  const first = (key: string) => firstOperation(input, key);
  const query = first("search_query");
  if (typeof query?.q === "string") return query.q;
  const open = first("open");
  if (typeof open?.ref_id === "string") return open.ref_id;
  const find = first("find");
  if (typeof find?.ref_id === "string" && typeof find.pattern === "string") return `${find.pattern} in ${find.ref_id}`;
  const click = first("click");
  if (typeof click?.ref_id === "string") return click.ref_id;
  return null;
}

export const webDisplay: ToolDisplay = {
  name: "web",
  action: "search",
  preservesResultContent: true,
  displayName: "Web",
  verbs: { progressive: "Searching", past: "Searched" },
  isOptimistic: false,
  getDetail: webDetail,
  // The sentence names what the call did with its first operation: a page it
  // opened reads as opened, not searched.
  getSentence: (input, _executionCwd, presentation) => {
    if (firstOperation(input, "search_query") !== undefined) return { name: "Searched", detail: presentation.detail };
    if (firstOperation(input, "open") !== undefined) return { name: "Opened", detail: displayUrl(presentation.detail) };
    if (firstOperation(input, "click") !== undefined) return { name: "Clicked", detail: displayUrl(presentation.detail) };
    return { name: "Searched", detail: presentation.detail };
  },
};
