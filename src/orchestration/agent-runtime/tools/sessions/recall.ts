import type { AdvertisedTool, RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "../types.js";
import { RECALL_EXPAND_MAX, RECALL_PAGE_SIZE, RECALL_READ_DEFAULT_LIMIT, RECALL_READ_MAX_LIMIT, type RecallEntryReference, type RecallPort } from "../../../../protocol/conversation-recall.js";
import { formatRecallOutput } from "./recall/format-recall.js";
import { normalizeRecallScope } from "./recall/recall-scope.js";

const RECALL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search terms. Results match any term, best first." },
    expand: { type: "array", maxItems: RECALL_EXPAND_MAX, items: { anyOf: [{ type: "number" }, { type: "string" }] }, description: "Entry ids, or the integers shown after # by a search in the same scope." },
    offset: { type: "number", description: "UTF-16 offset for expanded reads. Default: 0." },
    limit: { type: "number", description: `UTF-16 units per expanded entry, for expand only. Default ${RECALL_READ_DEFAULT_LIMIT}, max ${RECALL_READ_MAX_LIMIT}.` },
    page: { type: "number", description: "Search result page, from 1." },
    scope: { type: "string", enum: ["lineage", "all"], description: "lineage (default): the active branch. all: every branch." },
  },
} as const;

/** The recall tool as the model sees it, whichever conversation it reads. */
export const RECALL_TOOL_DEFINITION: AdvertisedTool = {
  name: "recall",
  action: "search",
  isConcurrencySafe: true,
  description: "Search this conversation's history, including turns that compaction removed. Use it before you redo work. Results show each entry's id and #coordinate; expand reads entries by either one.",
  inputSchema: RECALL_INPUT_SCHEMA,
};

export function createRecallTool(recall: RecallPort): RuntimeTool {
  return {
    ...RECALL_TOOL_DEFINITION,
    async execute(input: RuntimeToolInput, _context: ToolContext): Promise<ToolResult> {
      return executeRecallTool(recall, input);
    },
  };
}

async function executeRecallTool(recall: RecallPort, input: RuntimeToolInput): Promise<ToolResult> {
  const parsed = parseRecallInput(input);
  if ("error" in parsed) return { content: parsed.error, outcome: "error" };
  const result = await recall({
    scope: parsed.scope,
    ...(parsed.query ? { query: parsed.query } : {}),
    expand: parsed.expand,
    page: parsed.page,
    offset: parsed.offset,
    limit: parsed.limit,
  });

  if (parsed.expand.length > 0 && !parsed.query?.trim()) {
    return expandedRecallResult(parsed.scope, result);
  }
  if (parsed.query?.trim()) {
    return searchRecallResult(parsed.scope, parsed.query, parsed.page, result);
  }
  return recentRecallResult(parsed.scope, result);
}

type ParsedRecallInput = {
  scope: ReturnType<typeof normalizeRecallScope>
  query?: string
  expand: RecallEntryReference[]
  page: number
  offset: number
  limit: number
}

function parseRecallInput(input: RuntimeToolInput): ParsedRecallInput | { error: string } {
  if (input.query !== undefined && typeof input.query !== "string") return { error: "recall query must be a string." };
  if (input.scope !== undefined && input.scope !== "lineage" && input.scope !== "all") return { error: "recall scope must be 'lineage' or 'all'." };
  if (input.expand !== undefined && !Array.isArray(input.expand)) return { error: "recall expand must be an array." };
  const rawExpand = input.expand ?? [];
  if (rawExpand.length > RECALL_EXPAND_MAX) return { error: `recall expand accepts at most ${RECALL_EXPAND_MAX} references.` };
  if (!rawExpand.every(isRecallReference)) return { error: "recall expand must contain only non-negative integer coordinates or non-empty durable entry IDs." };
  if (input.page !== undefined && !isIntegerInRange(input.page, 1)) return { error: "recall page must be a positive integer." };
  if (input.offset !== undefined && !isIntegerInRange(input.offset, 0)) return { error: "recall offset must be a non-negative integer." };
  if (input.limit !== undefined && !isIntegerInRange(input.limit, 1, RECALL_READ_MAX_LIMIT)) {
    return { error: `recall limit must be an integer from 1 through ${RECALL_READ_MAX_LIMIT}.` };
  }
  return {
    scope: normalizeRecallScope(input.scope),
    query: typeof input.query === "string" ? input.query : undefined,
    expand: rawExpand,
    page: typeof input.page === "number" ? input.page : 1,
    offset: typeof input.offset === "number" ? input.offset : 0,
    limit: typeof input.limit === "number" ? input.limit : RECALL_READ_DEFAULT_LIMIT,
  };
}

function isIntegerInRange(value: unknown, minimum: number, maximum = Number.POSITIVE_INFINITY): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isRecallReference(value: unknown): value is RecallEntryReference {
  return (typeof value === "number" && Number.isInteger(value) && value >= 0)
    || (typeof value === "string" && value.length > 0);
}

function expandedRecallResult(scope: ReturnType<typeof normalizeRecallScope>, result: Awaited<ReturnType<RecallPort>>): ToolResult {
  if (result.invalidExpand && result.invalidExpand.length > 0) {
    return { content: `Cannot expand references outside ${scope === "all" ? "this conversation" : "active lineage"}: ${result.invalidExpand.join(", ")}`, outcome: "ok" };
  }
  return recentRecallResult(scope, result);
}

function searchRecallResult(scope: ReturnType<typeof normalizeRecallScope>, query: string, page: number, result: Awaited<ReturnType<RecallPort>>): ToolResult {
  const total = result.totalMatches ?? result.hits.length;
  const totalPages = Math.ceil(total / RECALL_PAGE_SIZE);
  const p = Math.max(1, page);
  const scopeSuffix = scope === "all" ? " (scope: all)" : "";
  const header = totalPages > 1 ? `Page ${p}/${totalPages} (${total} total matches${scopeSuffix})` : `${total} matches${scopeSuffix}`;
  const footer = p < totalPages ? `\n--- Use page:${p + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---` : "";
  return { content: formatRecallOutput(result.hits, query, header) + footer, outcome: "ok" };
}

function recentRecallResult(scope: ReturnType<typeof normalizeRecallScope>, result: Awaited<ReturnType<RecallPort>>): ToolResult {
  const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(result.hits);
  return { content: output, outcome: "ok" };
}
